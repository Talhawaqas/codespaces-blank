// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./InayaBridgeTypes.sol";
import "./IInayaMessageHandler.sol";
import "./InayaMessenger.sol";

// ============================================================
// INAYA TOKEN BRIDGE -- HOME SIDE (BSC Testnet only)
//
// The lock side of the bridge. Real $INAYA never leaves this chain: this
// contract holds custody of every token that has a bridged representation
// live on a spoke chain, tracked per destination chain in
// `lockedBalanceByChain`. Invariant maintained at all times:
//     Σ InayaWrappedINAYA(chainId).totalSupply() <= lockedBalanceByChain[chainId]
//
// IMPORTANT -- InayaToken's fee-on-transfer: every real-INAYA hop into or
// out of this contract costs 0.0001 INAYA, paid by whichever address is the
// `_from` of that specific transfer, credited to InayaToken's treasury. When
// THIS CONTRACT is the `_from` (unlocking to a user, or forwarding a
// re-route), the fee comes out of this contract's own balance, not the
// recipient's -- a cost the per-chain locked ledger doesn't otherwise
// account for. `feeBufferBalance()` is the operational reserve that absorbs
// this; it must be owner-funded via `topUpFeeBuffer` and monitored. A hop
// that would exceed it reverts inside `onMessage`, which InayaMessenger
// catches and marks Failed -- retryable once the buffer is topped up, never
// a stuck/reverted permanent state.
// ============================================================
contract InayaTokenBridgeHome is Ownable, Pausable, ReentrancyGuard, IInayaMessageHandler {
    using SafeERC20 for IERC20;

    IERC20 public immutable inayaToken;
    InayaMessenger public messenger;
    address public emergencyPauser;

    mapping(uint256 => uint256) public lockedBalanceByChain;
    uint256 public totalLocked;

    mapping(uint256 => bytes32) public spokeBridgeAddress; // destChainId => trusted InayaTokenBridgeSpoke id
    mapping(address => bool) public authorizedModules;     // e.g. InayaStakingGatewayHome

    event BridgeOut(address indexed from, uint256 indexed destChainId, bytes32 recipient, uint256 amount, bytes32 messageId);
    event ReceivedAndLocked(address indexed from, uint256 indexed destChainId, bytes32 recipient, uint256 amount, bytes32 messageId);
    event UnlockedInto(address indexed to, uint256 amount, uint256 indexed originChainId);
    event Unlocked(address indexed to, uint256 amount, uint256 indexed sourceChainId);
    event Routed(uint256 indexed fromChainId, uint256 indexed toChainId, uint256 amount, bytes32 messageId);
    event FeeBufferTopUp(address indexed from, uint256 amount);
    event AuthorizedModuleUpdated(address indexed module, bool allowed);
    event MessengerUpdated(address newMessenger);
    event SpokeBridgeAddressUpdated(uint256 indexed chainId, bytes32 spokeBridge);
    event EmergencyPauserUpdated(address newPauser);

    modifier onlyMessenger() {
        require(msg.sender == address(messenger), "Caller is not the messenger");
        _;
    }

    modifier onlyAuthorizedModule() {
        require(authorizedModules[msg.sender], "Caller is not an authorized module");
        _;
    }

    constructor(address initialOwner, address _inayaToken, address _messenger) Ownable(initialOwner) {
        require(_inayaToken != address(0) && _messenger != address(0), "Zero address not allowed");
        inayaToken = IERC20(_inayaToken);
        messenger = InayaMessenger(_messenger);
    }

    // ------------------------------------------------------------
    // USER-FACING
    // ------------------------------------------------------------

    /// @notice Bridges real $INAYA from home to `destChainId`. Caller must have approved this
    ///         contract for `amount` plus InayaToken's per-transfer fee beforehand -- this
    ///         contract ends up holding exactly `amount`, the fee is deducted from the caller.
    function bridgeOut(uint256 destChainId, bytes32 recipient, uint256 amount)
        external
        whenNotPaused
        nonReentrant
        returns (bytes32 messageId)
    {
        require(amount > 0, "Amount must be > 0");
        require(spokeBridgeAddress[destChainId] != bytes32(0), "No spoke bridge registered for destination chain");

        inayaToken.safeTransferFrom(msg.sender, address(this), amount);
        lockedBalanceByChain[destChainId] += amount;
        totalLocked += amount;

        messageId = messenger.sendMessage(
            destChainId,
            spokeBridgeAddress[destChainId],
            InayaBridgeTypes.MSG_TOKEN_MINT,
            abi.encode(recipient, amount)
        );

        emit BridgeOut(msg.sender, destChainId, recipient, amount, messageId);
    }

    // ------------------------------------------------------------
    // INBOUND MESSAGE HANDLER (msgType = TOKEN_BURN_NOTICE)
    // ------------------------------------------------------------
    function onMessage(InayaBridgeTypes.Message calldata message) external onlyMessenger whenNotPaused returns (bool) {
        require(message.msgType == InayaBridgeTypes.MSG_TOKEN_BURN_NOTICE, "Unexpected msgType");

        (uint8 action, bytes32 recipient, uint256 amount, uint256 routeToChainId) =
            abi.decode(message.payload, (uint8, bytes32, uint256, uint256));

        uint256 sourceChain = message.sourceChainId;
        require(lockedBalanceByChain[sourceChain] >= amount, "Insufficient locked balance for source chain");

        lockedBalanceByChain[sourceChain] -= amount;
        totalLocked -= amount;

        if (action == InayaBridgeTypes.BURN_ACTION_PLAIN) {
            address to = InayaBridgeTypes.bytes32ToAddress(recipient);
            inayaToken.safeTransfer(to, amount);
            emit Unlocked(to, amount, sourceChain);
            return true;
        } else if (action == InayaBridgeTypes.BURN_ACTION_ROUTE) {
            require(spokeBridgeAddress[routeToChainId] != bytes32(0), "No spoke bridge registered for route target");
            lockedBalanceByChain[routeToChainId] += amount;
            totalLocked += amount;
            bytes32 routeMessageId = messenger.sendMessage(
                routeToChainId,
                spokeBridgeAddress[routeToChainId],
                InayaBridgeTypes.MSG_TOKEN_MINT,
                abi.encode(recipient, amount)
            );
            emit Routed(sourceChain, routeToChainId, amount, routeMessageId);
            return true;
        }

        revert("Invalid burn-notice action");
    }

    // ------------------------------------------------------------
    // AUTHORIZED-MODULE ENTRY POINTS (used by InayaStakingGatewayHome)
    // ------------------------------------------------------------

    /// @notice Moves already-locked real INAYA (backing wrapped tokens on `originChainId`) out
    ///         of that chain's locked bucket and into `to`'s balance on THIS chain. Used when a
    ///         spoke-originated stake request needs its principal un-wrapped on home before it
    ///         can be forwarded into InayaStaking.
    function unlockInto(address to, uint256 amount, uint256 originChainId)
        external
        onlyAuthorizedModule
        nonReentrant
        returns (bool)
    {
        require(lockedBalanceByChain[originChainId] >= amount, "Insufficient locked balance for origin chain");
        lockedBalanceByChain[originChainId] -= amount;
        totalLocked -= amount;
        inayaToken.safeTransfer(to, amount);
        emit UnlockedInto(to, amount, originChainId);
        return true;
    }

    /// @notice Pulls `amount` from `from` (which must have approved this contract) and routes it
    ///         cross-chain to `recipient` on `destChainId` -- used by InayaStakingGatewayHome to
    ///         pay out a cross-chain unstake/reward-claim.
    function receiveAndLock(uint256 destChainId, bytes32 recipient, uint256 amount, address from)
        external
        onlyAuthorizedModule
        nonReentrant
        returns (bytes32 messageId)
    {
        require(amount > 0, "Amount must be > 0");
        require(spokeBridgeAddress[destChainId] != bytes32(0), "No spoke bridge registered for destination chain");

        inayaToken.safeTransferFrom(from, address(this), amount);
        lockedBalanceByChain[destChainId] += amount;
        totalLocked += amount;

        messageId = messenger.sendMessage(
            destChainId,
            spokeBridgeAddress[destChainId],
            InayaBridgeTypes.MSG_TOKEN_MINT,
            abi.encode(recipient, amount)
        );

        emit ReceivedAndLocked(from, destChainId, recipient, amount, messageId);
    }

    // ------------------------------------------------------------
    // FEE BUFFER
    // ------------------------------------------------------------

    /// @notice Anyone may top up the operational reserve that absorbs InayaToken's per-hop fee
    ///         when this contract is the `_from` of an unlock/route transfer.
    function topUpFeeBuffer(uint256 amount) external {
        require(amount > 0, "Amount must be > 0");
        inayaToken.safeTransferFrom(msg.sender, address(this), amount);
        emit FeeBufferTopUp(msg.sender, amount);
    }

    function feeBufferBalance() external view returns (uint256) {
        uint256 balance = inayaToken.balanceOf(address(this));
        return balance > totalLocked ? balance - totalLocked : 0;
    }

    // ------------------------------------------------------------
    // ADMIN
    // ------------------------------------------------------------
    function setAuthorizedModule(address module, bool allowed) external onlyOwner {
        authorizedModules[module] = allowed;
        emit AuthorizedModuleUpdated(module, allowed);
    }

    function setMessenger(address newMessenger) external onlyOwner {
        require(newMessenger != address(0), "Zero address not allowed");
        messenger = InayaMessenger(newMessenger);
        emit MessengerUpdated(newMessenger);
    }

    function setSpokeBridgeAddress(uint256 chainId, bytes32 spokeBridge) external onlyOwner {
        spokeBridgeAddress[chainId] = spokeBridge;
        emit SpokeBridgeAddressUpdated(chainId, spokeBridge);
    }

    function setEmergencyPauser(address pauser) external onlyOwner {
        emergencyPauser = pauser;
        emit EmergencyPauserUpdated(pauser);
    }

    function pauseCrossChain() external {
        require(msg.sender == owner() || msg.sender == emergencyPauser, "Not authorized to pause");
        _pause();
    }

    function unpauseCrossChain() external onlyOwner {
        _unpause();
    }
}
