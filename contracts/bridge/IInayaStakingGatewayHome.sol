// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IInayaStakingGatewayHome
/// @notice The narrow surface InayaStaking calls into for cross-chain withdraw/claim payouts.
///         Kept as a standalone interface (rather than InayaStaking importing the concrete
///         gateway contract) so InayaStaking never depends on the gateway's implementation --
///         the gateway is what depends on InayaStaking, not the other way around.
interface IInayaStakingGatewayHome {
    /// @notice The InayaTokenBridgeHome address InayaStaking must approve before calling
    ///         forwardWithdrawal/forwardClaim -- the bridge, not this gateway, is what actually
    ///         pulls the tokens via transferFrom.
    function bridge() external view returns (address);

    function forwardWithdrawal(address user, uint256 amount, uint256 destChainId, bytes32 destRecipient)
        external
        returns (bytes32 messageId);

    function forwardClaim(address user, uint256 amount, uint256 destChainId, bytes32 destRecipient)
        external
        returns (bytes32 messageId);
}
