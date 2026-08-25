// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./InayaOracleRegistry.sol";

/// @title InayaOracleAdapter
/// @notice The standardized interface other Inaya contracts will read oracle data through.
///         Approval alone (InayaOracleRegistry) never makes data trusted -- every submission
///         here is checked on-chain, not just assumed honest because it came from a registered
///         address: not from the future, not already stale by the time it arrives, not faster
///         than the source's configured minimum interval (replay/spam protection), and not an
///         outlier beyond a configurable max deviation from the previous value. A submission
///         that fails any of these reverts the whole transaction -- nothing partially-invalid
///         is ever recorded.
///
/// @dev Values are uint256 -- every data type this ecosystem actually has (prices, node counts,
///      capacity, uptime bps) is non-negative, so there's no need for signed-integer handling.
contract InayaOracleAdapter is Ownable {
    InayaOracleRegistry public immutable registry;

    struct DataPoint {
        uint256 value;
        uint256 reportedTimestamp; // the timestamp the submitter claims the value was true as of
        uint256 submittedAt;       // block.timestamp when it landed on-chain -- staleness is measured from this, not the reported one
    }

    mapping(bytes32 => DataPoint) public latestData;

    uint256 public maxStalenessSeconds = 1 hours;
    uint256 public maxDeviationBps = 2000; // 20% -- a single update can't move a value by more than this

    event DataSubmitted(bytes32 indexed sourceId, uint256 value, uint256 reportedTimestamp, address indexed submitter);

    constructor(address _registry) Ownable(msg.sender) {
        require(_registry != address(0), "registry address required");
        registry = InayaOracleRegistry(_registry);
    }

    function submitData(bytes32 _sourceId, uint256 _value, uint256 _reportedTimestamp) external {
        require(registry.isAuthorizedSubmitter(_sourceId, msg.sender), "Not an authorized submitter for this source");
        require(_reportedTimestamp <= block.timestamp, "Timestamp cannot be in the future");
        require(block.timestamp - _reportedTimestamp <= maxStalenessSeconds, "Data is already stale at submission time");

        DataPoint storage existing = latestData[_sourceId];
        if (existing.submittedAt > 0) {
            uint256 minInterval = registry.getUpdateFrequency(_sourceId);
            require(block.timestamp - existing.submittedAt >= minInterval, "Submitted faster than this source's minimum update interval");

            if (existing.value > 0) {
                uint256 diff = _value > existing.value ? _value - existing.value : existing.value - _value;
                uint256 deviationBps = (diff * 10000) / existing.value;
                require(deviationBps <= maxDeviationBps, "Deviation from previous value exceeds max allowed");
            }
        }

        latestData[_sourceId] = DataPoint({ value: _value, reportedTimestamp: _reportedTimestamp, submittedAt: block.timestamp });
        emit DataSubmitted(_sourceId, _value, _reportedTimestamp, msg.sender);
    }

    function getLatestData(bytes32 _sourceId) external view returns (uint256 value, uint256 reportedTimestamp, uint256 submittedAt) {
        DataPoint storage d = latestData[_sourceId];
        return (d.value, d.reportedTimestamp, d.submittedAt);
    }

    /// @notice A source that has never received a submission is stale by definition -- there is
    ///         no "default trusted value," only real data or an explicit stale signal.
    function isStale(bytes32 _sourceId) external view returns (bool) {
        DataPoint storage d = latestData[_sourceId];
        if (d.submittedAt == 0) return true;
        return block.timestamp - d.submittedAt > maxStalenessSeconds;
    }

    function setMaxStaleness(uint256 _seconds) external onlyOwner {
        maxStalenessSeconds = _seconds;
    }

    function setMaxDeviationBps(uint256 _bps) external onlyOwner {
        maxDeviationBps = _bps;
    }
}
