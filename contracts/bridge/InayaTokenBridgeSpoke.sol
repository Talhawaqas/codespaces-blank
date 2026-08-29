// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./InayaBridgeTypes.sol";
import "./IInayaMessageHandler.sol";
import "./InayaMessenger.sol";
import "./InayaWrappedINAYA.sol";

// ============================================================
// INAYA TOKEN BRIDGE -- SPOKE SIDE (Ethereum Sepolia / Polygon Amoy / Avalanche Fuji)
//
// The mint/burn side of the bridge on a given spoke chain. Sole minter/burner of that chain's
// InayaWrappedINAYA. Never holds real $INAYA itself -- every wrapped token it mints is backed
// 1:1 by a lock already held on home (BSC Testnet) by InayaTokenBridgeHome.
// ============================================================
contract InayaTokenBridgeSpoke is Ownable, Pausable, ReentrancyGuard, IInayaMessageHandler {
    InayaWrappedINAYA public wrappedToken;
    InayaMessenger public messenger;
    uint256 public immutable homeChainId;
    bytes32 public homeBridgeAddress;
    address public emergencyPauser;

    mapping(address => bool) public authorizedInitiators; // e.g. InayaStakingGatewaySpoke

    event BridgedToHome(address indexed from, bytes32 recipient, uint256 amount, bytes32 messageId);
    event BridgedToSpoke(address indexed from, uint256 indexed finalDestChainId, bytes32 recipient, uint256 amount, bytes32 messageId);
    event MintedFromMessage(address indexed to, uint256 amount, bytes32 indexed sourceMessageId);
    event BurnedForInitiator(address indexed caller, uint256 amount, address indexed initiator);
    event AuthorizedInitiatorUpdated(address indexed module, bool allowed);
    event MessengerUpdated(address newMessenger);
    event HomeBridgeAddressUpdated(bytes32 homeBridge);
    event EmergencyPauserUpdated(address newPauser);

    modifier onlyMessenger() {
        require(msg.sender == address(messenger), "Caller is not the messenger");
        _;
    }

    modifier onlyAuthorizedInitiator() {
        require(authorizedInitiators[msg.sender], "Caller is not an authorized initiator");
        _;
    }

    constructor(address initialOwner, address _wrappedToken, address _messenger, uint256 _homeChainId, bytes32 _homeBridgeAddress)
        Ownable(initialOwner)
    {
        require(_wrappedToken != address(0) && _messenger != address(0), "Zero address not allowed");
        wrappedToken = InayaWrappedINAYA(_wrappedToken);
        messenger = InayaMessenger(_messenger);
        homeChainId = _homeChainId;
        homeBridgeAddress = _homeBridgeAddress;
    }

    // ------------------------------------------------------------
    // USER-FACING
    // ------------------------------------------------------------

    /// @notice Burns the caller's wrapped INAYA and requests home unlock it straight to `recipient`.
    function bridgeToHome(bytes32 recipient, uint256 amount) external whenNotPaused nonReentrant returns (bytes32 messageId) {
        require(amount > 0, "Amount must be > 0");
        wrappedToken.burn(msg.sender, amount);

        messageId = messenger.sendMessage(
            homeChainId,
            homeBridgeAddress,
            InayaBridgeTypes.MSG_TOKEN_BURN_NOTICE,
            abi.encode(InayaBridgeTypes.BURN_ACTION_PLAIN, recipient, amount, uint256(0))
        );

        emit BridgedToHome(msg.sender, recipient, amount, messageId);
    }

    /// @notice Burns the caller's wrapped INAYA and requests home re-route the equivalent lock
    ///         on to a different spoke chain (`finalDestChainId`) -- home decides all routing,
    ///         no spoke ever bridges directly to another spoke.
    function bridgeToSpoke(uint256 finalDestChainId, bytes32 recipient, uint256 amount)
        external
        whenNotPaused
        nonReentrant
        returns (bytes32 messageId)
    {
        require(amount > 0, "Amount must be > 0");
        require(finalDestChainId != homeChainId, "Use bridgeToHome for the home chain");
        wrappedToken.burn(msg.sender, amount);

        messageId = messenger.sendMessage(
            homeChainId,
            homeBridgeAddress,
            InayaBridgeTypes.MSG_TOKEN_BURN_NOTICE,
            abi.encode(InayaBridgeTypes.BURN_ACTION_ROUTE, recipient, amount, finalDestChainId)
        );

        emit BridgedToSpoke(msg.sender, finalDestChainId, recipient, amount, messageId);
    }

    // ------------------------------------------------------------
    // AUTHORIZED-INITIATOR ENTRY POINT (used by InayaStakingGatewaySpoke)
    // ------------------------------------------------------------

    /// @notice Burns `caller`'s wrapped INAYA on behalf of an authorized initiator module. Does
    ///         NOT itself send a cross-chain message -- the calling module composes and sends
    ///         its own message (e.g. STAKE_REQUEST) after this returns.
    function initiateBurnFor(address caller, uint256 amount) external onlyAuthorizedInitiator whenNotPaused returns (bool) {
        wrappedToken.burn(caller, amount);
        emit BurnedForInitiator(caller, amount, msg.sender);
        return true;
    }

    // ------------------------------------------------------------
    // INBOUND MESSAGE HANDLER (msgType = TOKEN_MINT)
    // ------------------------------------------------------------
    function onMessage(InayaBridgeTypes.Message calldata message) external onlyMessenger whenNotPaused returns (bool) {
        require(message.msgType == InayaBridgeTypes.MSG_TOKEN_MINT, "Unexpected msgType");

        (bytes32 recipient, uint256 amount) = abi.decode(message.payload, (bytes32, uint256));
        address to = InayaBridgeTypes.bytes32ToAddress(recipient);

        wrappedToken.mint(to, amount);
        emit MintedFromMessage(to, amount, InayaBridgeTypes.hashMessage(message));
        return true;
    }

    // ------------------------------------------------------------
    // ADMIN
    // ------------------------------------------------------------
    function setAuthorizedInitiator(address module, bool allowed) external onlyOwner {
        authorizedInitiators[module] = allowed;
        emit AuthorizedInitiatorUpdated(module, allowed);
    }

    function setMessenger(address newMessenger) external onlyOwner {
        require(newMessenger != address(0), "Zero address not allowed");
        messenger = InayaMessenger(newMessenger);
        emit MessengerUpdated(newMessenger);
    }

    function setHomeBridgeAddress(bytes32 _homeBridgeAddress) external onlyOwner {
        homeBridgeAddress = _homeBridgeAddress;
        emit HomeBridgeAddressUpdated(_homeBridgeAddress);
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
