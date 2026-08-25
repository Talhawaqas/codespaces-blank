// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @title InayaOracleRegistry
/// @notice Owner-approved list of oracle data sources. This contract holds no data itself --
///         it only answers "is this address currently allowed to submit for this source?" for
///         InayaOracleAdapter (which is where actual values live). Keeping the two apart means
///         a compromised or misbehaving submitter can be deactivated here without touching any
///         already-recorded data, and a new data type never requires redesigning either
///         contract -- just one more registerSource() call.
contract InayaOracleRegistry is Ownable {
    struct Source {
        string dataType;
        address submitter;
        bool active;
        uint256 updateFrequency; // minimum seconds between submissions, enforced by the Adapter
        bool exists;
    }

    mapping(bytes32 => Source) public sources;
    bytes32[] public sourceIds;

    event SourceRegistered(bytes32 indexed sourceId, string dataType, address submitter, uint256 updateFrequency);
    event SourceStatusChanged(bytes32 indexed sourceId, bool active);
    event SourceSubmitterUpdated(bytes32 indexed sourceId, address newSubmitter);

    constructor() Ownable(msg.sender) {}

    function registerSource(bytes32 _sourceId, string calldata _dataType, address _submitter, uint256 _updateFrequency) external onlyOwner {
        require(!sources[_sourceId].exists, "Source already registered");
        require(_submitter != address(0), "submitter address required");

        sources[_sourceId] = Source({
            dataType: _dataType,
            submitter: _submitter,
            active: true,
            updateFrequency: _updateFrequency,
            exists: true
        });
        sourceIds.push(_sourceId);

        emit SourceRegistered(_sourceId, _dataType, _submitter, _updateFrequency);
    }

    function setSourceActive(bytes32 _sourceId, bool _active) external onlyOwner {
        require(sources[_sourceId].exists, "Unknown source");
        sources[_sourceId].active = _active;
        emit SourceStatusChanged(_sourceId, _active);
    }

    /// @notice Mechanically identical to setSourceActive(id, false) -- named separately because
    ///         the SOW calls out "emergency source disabling" as its own explicit capability for
    ///         incident response, not something you should have to infer from a boolean setter.
    function emergencyDisable(bytes32 _sourceId) external onlyOwner {
        require(sources[_sourceId].exists, "Unknown source");
        sources[_sourceId].active = false;
        emit SourceStatusChanged(_sourceId, false);
    }

    function updateSubmitter(bytes32 _sourceId, address _newSubmitter) external onlyOwner {
        require(sources[_sourceId].exists, "Unknown source");
        require(_newSubmitter != address(0), "submitter address required");
        sources[_sourceId].submitter = _newSubmitter;
        emit SourceSubmitterUpdated(_sourceId, _newSubmitter);
    }

    function isAuthorizedSubmitter(bytes32 _sourceId, address _submitter) external view returns (bool) {
        Source storage s = sources[_sourceId];
        return s.exists && s.active && s.submitter == _submitter;
    }

    function getUpdateFrequency(bytes32 _sourceId) external view returns (uint256) {
        return sources[_sourceId].updateFrequency;
    }

    function getSourceCount() external view returns (uint256) {
        return sourceIds.length;
    }
}
