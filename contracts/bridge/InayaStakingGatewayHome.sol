// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./InayaBridgeTypes.sol";
import "./IInayaMessageHandler.sol";
import "./IInayaStakingGatewayHome.sol";
import "./InayaMessenger.sol";
import "./InayaTokenBridgeHome.sol";
import "../InayaStaking.sol";

// ============================================================
// INAYA STAKING GATEWAY -- HOME SIDE (BSC Testnet only)
//
// The one address InayaStaking.crossChainGateway trusts to call stakeFor() -- deliberately
// narrower than trusting the whole InayaMessenger (which routes many other message types too).
// Also the one address InayaStaking calls back into to route a cross-chain withdraw/claim
// payout through the bridge.
// ============================================================
contract InayaStakingGatewayHome is Ownable, IInayaMessageHandler, IInayaStakingGatewayHome {
    using SafeERC20 for IERC20;

    InayaStaking public staking;
    InayaTokenBridgeHome public bridgeContract;
    InayaMessenger public messenger;

    // $INAYA charges a flat transfer fee on every hop. unlockInto() delivers exactly `amount`
    // into this gateway's balance -- the SUBSEQUENT hop into InayaStaking (stakeFor's
    // transferFrom) needs an extra fee's worth of both allowance and real balance beyond
    // `amount`, which this small owner-funded reserve covers, mirroring InayaTokenBridgeHome's
    // own feeBufferBalance/topUpFeeBuffer pattern for its unlock-side hop.
    uint256 public feeMargin = 1e15; // 0.001 INAYA, comfortably above the real 0.0001 fee

    event StakeRequestProcessed(address indexed user, uint256 amount, uint256 lockPeriodDays, uint256 indexed originChainId);
    event StakingUpdated(address newStaking);
    event BridgeUpdated(address newBridge);
    event MessengerUpdated(address newMessenger);
    event FeeMarginUpdated(uint256 newFeeMargin);
    event FeeBufferTopUp(address indexed from, uint256 amount);

    modifier onlyMessenger() {
        require(msg.sender == address(messenger), "Caller is not the messenger");
        _;
    }

    modifier onlyStaking() {
        require(msg.sender == address(staking), "Caller is not InayaStaking");
        _;
    }

    constructor(address initialOwner, address _staking, address _bridge, address _messenger) Ownable(initialOwner) {
        require(_staking != address(0) && _bridge != address(0) && _messenger != address(0), "Zero address not allowed");
        staking = InayaStaking(_staking);
        bridgeContract = InayaTokenBridgeHome(_bridge);
        messenger = InayaMessenger(_messenger);
    }

    /// @notice The bridge address InayaStaking must approve before calling forwardWithdrawal/forwardClaim.
    function bridge() external view returns (address) {
        return address(bridgeContract);
    }

    // ------------------------------------------------------------
    // INBOUND MESSAGE HANDLER (msgType = STAKE_REQUEST, spoke -> home only)
    // ------------------------------------------------------------
    function onMessage(InayaBridgeTypes.Message calldata message) external onlyMessenger returns (bool) {
        require(message.msgType == InayaBridgeTypes.MSG_STAKE_REQUEST, "Unexpected msgType");

        (address user, uint256 amount, uint256 lockPeriodDays, uint256 originChainId) =
            abi.decode(message.payload, (address, uint256, uint256, uint256));

        // The real INAYA backing this stake has been sitting locked against `originChainId`
        // since the user originally bridged in -- un-wrap it into this gateway's own balance
        // before it can be handed to InayaStaking.
        bridgeContract.unlockInto(address(this), amount, originChainId);

        IERC20 token = staking.stakingToken();
        token.forceApprove(address(staking), amount + feeMargin);
        staking.stakeFor(user, amount, lockPeriodDays, originChainId);

        emit StakeRequestProcessed(user, amount, lockPeriodDays, originChainId);
        return true;
    }

    // ------------------------------------------------------------
    // CALLED BY InayaStaking (withdrawTo / claimRewardTo)
    // ------------------------------------------------------------
    // `user` isn't needed here -- the tokens being routed always come from InayaStaking's own
    // balance regardless of which user triggered the withdrawal/claim -- but it's kept in the
    // signature to match IInayaStakingGatewayHome and for event/off-chain-indexing clarity.
    function forwardWithdrawal(address /* user */, uint256 amount, uint256 destChainId, bytes32 destRecipient)
        external
        onlyStaking
        returns (bytes32 messageId)
    {
        return bridgeContract.receiveAndLock(destChainId, destRecipient, amount, address(staking));
    }

    function forwardClaim(address /* user */, uint256 amount, uint256 destChainId, bytes32 destRecipient)
        external
        onlyStaking
        returns (bytes32 messageId)
    {
        return bridgeContract.receiveAndLock(destChainId, destRecipient, amount, address(staking));
    }

    /// @notice Anyone may top up this gateway's small operational reserve (see feeMargin's doc).
    function topUpFeeBuffer(uint256 amount) external {
        require(amount > 0, "Amount must be > 0");
        staking.stakingToken().safeTransferFrom(msg.sender, address(this), amount);
        emit FeeBufferTopUp(msg.sender, amount);
    }

    // ------------------------------------------------------------
    // ADMIN
    // ------------------------------------------------------------
    function setFeeMargin(uint256 newFeeMargin) external onlyOwner {
        feeMargin = newFeeMargin;
        emit FeeMarginUpdated(newFeeMargin);
    }

    function setStaking(address newStaking) external onlyOwner {
        require(newStaking != address(0), "Zero address not allowed");
        staking = InayaStaking(newStaking);
        emit StakingUpdated(newStaking);
    }

    function setBridge(address newBridge) external onlyOwner {
        require(newBridge != address(0), "Zero address not allowed");
        bridgeContract = InayaTokenBridgeHome(newBridge);
        emit BridgeUpdated(newBridge);
    }

    function setMessenger(address newMessenger) external onlyOwner {
        require(newMessenger != address(0), "Zero address not allowed");
        messenger = InayaMessenger(newMessenger);
        emit MessengerUpdated(newMessenger);
    }
}
