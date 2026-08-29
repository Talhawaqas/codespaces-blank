// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./InayaBridgeTypes.sol";

/// @title IInayaMessageHandler
/// @notice Implemented by every module (bridge, staking gateway) that InayaMessenger can
///         dispatch an inbound message to. Registered per-msgType via
///         InayaMessenger.setHandler -- a given msgType can only ever reach its one
///         designated handler.
interface IInayaMessageHandler {
    /// @return success Whether the message was handled successfully. A `false` return
    ///         (or a revert, which InayaMessenger catches) marks the message Failed and
    ///         retryable -- it must NOT partially apply state and return false/revert,
    ///         since a retry re-runs this call from scratch with the same fields.
    function onMessage(InayaBridgeTypes.Message calldata message) external returns (bool success);
}
