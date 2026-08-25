// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @title InayaAutomationRegistry
/// @notice A transparent RECORD of what Inaya's off-chain automation worker is approved to do
///         and what it has actually done -- never a privileged executor. This contract holds
///         no special calling rights over any targetContract and never forwards or proxies a
///         call to one. That's deliberate, not a missing feature: it's what makes "automation
///         cannot bypass smart-contract authorization" true by construction rather than by
///         policy. The worker calls a task's target function directly, under whatever access
///         control that function already enforces on its own (e.g. InayaNodeRegistry's
///         releaseSettlementsBatch() is permissionless and time-locked already -- this registry
///         doesn't grant it anything, it only logs that the worker is supposed to be checking it
///         and records what happened when it did.
contract InayaAutomationRegistry is Ownable {
    struct Task {
        address targetContract;
        bytes4 functionSelector;
        string conditionDescription;
        bool active;
        uint256 lastExecution;
        uint256 nextEligible;
        uint256 consecutiveFailures;
        bool exists;
    }

    mapping(bytes32 => Task) public tasks;
    bytes32[] public taskIds;

    address public worker;

    event TaskRegistered(bytes32 indexed taskId, address targetContract, bytes4 functionSelector, string conditionDescription);
    event TaskStatusChanged(bytes32 indexed taskId, bool active);
    event TaskExecutionRecorded(bytes32 indexed taskId, bool success, uint256 nextEligible, bytes32 txHash);
    event WorkerUpdated(address newWorker);

    modifier onlyWorkerOrOwner() {
        require(msg.sender == worker || msg.sender == owner(), "Unauthorized: not the automation worker");
        _;
    }

    constructor(address _worker) Ownable(msg.sender) {
        require(_worker != address(0), "worker address required");
        worker = _worker;
    }

    function registerTask(bytes32 _taskId, address _targetContract, bytes4 _functionSelector, string calldata _conditionDescription) external onlyOwner {
        require(!tasks[_taskId].exists, "Task already registered");
        require(_targetContract != address(0), "targetContract address required");

        tasks[_taskId] = Task({
            targetContract: _targetContract,
            functionSelector: _functionSelector,
            conditionDescription: _conditionDescription,
            active: true,
            lastExecution: 0,
            nextEligible: block.timestamp,
            consecutiveFailures: 0,
            exists: true
        });
        taskIds.push(_taskId);

        emit TaskRegistered(_taskId, _targetContract, _functionSelector, _conditionDescription);
    }

    function setTaskActive(bytes32 _taskId, bool _active) external onlyOwner {
        require(tasks[_taskId].exists, "Unknown task");
        tasks[_taskId].active = _active;
        emit TaskStatusChanged(_taskId, _active);
    }

    function setWorker(address _newWorker) external onlyOwner {
        require(_newWorker != address(0), "worker address required");
        worker = _newWorker;
        emit WorkerUpdated(_newWorker);
    }

    /// @notice Purely an audit-trail write -- see the module note above. nextEligible is
    ///         worker-supplied rather than a fixed on-chain timer, since task-specific cadence
    ///         ("check again in an hour" vs "check again next block") is knowledge that belongs
    ///         with whoever understands the task, not a one-size-fits-all value here.
    function recordExecution(bytes32 _taskId, bool _success, uint256 _nextEligible, bytes32 _txHash) external onlyWorkerOrOwner {
        require(tasks[_taskId].exists, "Unknown task");
        Task storage t = tasks[_taskId];
        t.lastExecution = block.timestamp;
        t.nextEligible = _nextEligible;
        t.consecutiveFailures = _success ? 0 : t.consecutiveFailures + 1;
        emit TaskExecutionRecorded(_taskId, _success, _nextEligible, _txHash);
    }

    function getTaskCount() external view returns (uint256) {
        return taskIds.length;
    }
}
