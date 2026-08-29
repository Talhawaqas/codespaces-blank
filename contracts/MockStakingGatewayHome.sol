// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./bridge/IInayaStakingGatewayHome.sol";

// Test-only stand-in for InayaStakingGatewayHome so InayaStaking's withdrawTo/claimRewardTo can
// be unit-tested in isolation from the real bridge -- records what it was called with and
// returns a fixed messageId. The full real-gateway/real-bridge flow is covered separately by
// Test/CrossChainIntegration.test.js.
contract MockStakingGatewayHome is IInayaStakingGatewayHome {
    address public bridgeAddr;
    bytes32 public constant FIXED_MESSAGE_ID = keccak256("mock-message-id");

    uint256 public forwardWithdrawalCallCount;
    uint256 public forwardClaimCallCount;
    address public lastUser;
    uint256 public lastAmount;
    uint256 public lastDestChainId;
    bytes32 public lastDestRecipient;

    constructor(address _bridgeAddr) {
        bridgeAddr = _bridgeAddr;
    }

    function bridge() external view returns (address) {
        return bridgeAddr;
    }

    function forwardWithdrawal(address user, uint256 amount, uint256 destChainId, bytes32 destRecipient)
        external
        returns (bytes32)
    {
        forwardWithdrawalCallCount++;
        lastUser = user;
        lastAmount = amount;
        lastDestChainId = destChainId;
        lastDestRecipient = destRecipient;
        return FIXED_MESSAGE_ID;
    }

    function forwardClaim(address user, uint256 amount, uint256 destChainId, bytes32 destRecipient)
        external
        returns (bytes32)
    {
        forwardClaimCallCount++;
        lastUser = user;
        lastAmount = amount;
        lastDestChainId = destChainId;
        lastDestRecipient = destRecipient;
        return FIXED_MESSAGE_ID;
    }
}
