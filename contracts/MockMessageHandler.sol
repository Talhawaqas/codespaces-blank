// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./bridge/InayaBridgeTypes.sol";
import "./bridge/IInayaMessageHandler.sol";

// Test-only handler standing in for a real bridge/gateway module so InayaMessenger's
// dispatch/retry/failure-status behavior can be exercised in isolation.
contract MockMessageHandler is IInayaMessageHandler {
    enum Mode { Succeed, ReturnFalse, RevertWithReason, RevertWithoutReason }

    Mode public mode = Mode.Succeed;
    uint256 public callCount;
    InayaBridgeTypes.Message public lastMessage;

    function setMode(Mode _mode) external {
        mode = _mode;
    }

    function onMessage(InayaBridgeTypes.Message calldata message) external returns (bool) {
        callCount++;
        lastMessage = message;

        if (mode == Mode.Succeed) return true;
        if (mode == Mode.ReturnFalse) return false;
        if (mode == Mode.RevertWithReason) revert("mock handler reverted");
        revert();
    }
}
