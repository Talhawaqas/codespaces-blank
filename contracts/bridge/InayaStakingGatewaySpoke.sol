// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./InayaBridgeTypes.sol";
import "./InayaMessenger.sol";
import "./InayaTokenBridgeSpoke.sol";

// ============================================================
// INAYA STAKING GATEWAY -- SPOKE SIDE (Ethereum Sepolia / Polygon Amoy / Avalanche Fuji)
//
// User-facing "stake cross-chain" entry point on a spoke chain. Burns the caller's wrapped
// INAYA via the spoke bridge's restricted initiateBurnFor, then sends a STAKE_REQUEST message
// to home -- home holds the ONE canonical staking ledger, a spoke never runs staking logic
// itself.
// ============================================================
contract InayaStakingGatewaySpoke is Ownable, Pausable, ReentrancyGuard {
    InayaTokenBridgeSpoke public bridgeContract;
    InayaMessenger public messenger;
    uint256 public immutable homeChainId;
    bytes32 public homeStakingGatewayAddress;
    address public emergencyPauser;

    event StakeRequested(address indexed user, uint256 amount, uint256 lockPeriodDays, bytes32 messageId);
    event BridgeUpdated(address newBridge);
    event MessengerUpdated(address newMessenger);
    event HomeStakingGatewayAddressUpdated(bytes32 homeStakingGateway);
    event EmergencyPauserUpdated(address newPauser);

    constructor(address initialOwner, address _bridge, address _messenger, uint256 _homeChainId, bytes32 _homeStakingGatewayAddress)
        Ownable(initialOwner)
    {
        require(_bridge != address(0) && _messenger != address(0), "Zero address not allowed");
        bridgeContract = InayaTokenBridgeSpoke(_bridge);
        messenger = InayaMessenger(_messenger);
        homeChainId = _homeChainId;
        homeStakingGatewayAddress = _homeStakingGatewayAddress;
    }

    /// @notice Stakes `amount` of the caller's wrapped INAYA on this chain into the single
    ///         canonical staking ledger on home. Mirrors InayaStaking.stake()'s own validation
    ///         so a malformed request never even leaves this chain.
    function stakeCrossChain(uint256 amount, uint256 lockPeriodDays)
        external
        whenNotPaused
        nonReentrant
        returns (bytes32 messageId)
    {
        require(amount > 0, "Cannot stake 0");
        require(
            lockPeriodDays == 0 || lockPeriodDays == 30 || lockPeriodDays == 90,
            "Invalid lock period: use 0, 30, or 90"
        );

        bridgeContract.initiateBurnFor(msg.sender, amount);

        messageId = messenger.sendMessage(
            homeChainId,
            homeStakingGatewayAddress,
            InayaBridgeTypes.MSG_STAKE_REQUEST,
            abi.encode(msg.sender, amount, lockPeriodDays, block.chainid)
        );

        emit StakeRequested(msg.sender, amount, lockPeriodDays, messageId);
    }

    // ------------------------------------------------------------
    // ADMIN
    // ------------------------------------------------------------
    function setBridge(address newBridge) external onlyOwner {
        require(newBridge != address(0), "Zero address not allowed");
        bridgeContract = InayaTokenBridgeSpoke(newBridge);
        emit BridgeUpdated(newBridge);
    }

    function setMessenger(address newMessenger) external onlyOwner {
        require(newMessenger != address(0), "Zero address not allowed");
        messenger = InayaMessenger(newMessenger);
        emit MessengerUpdated(newMessenger);
    }

    function setHomeStakingGatewayAddress(bytes32 addr) external onlyOwner {
        homeStakingGatewayAddress = addr;
        emit HomeStakingGatewayAddressUpdated(addr);
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
