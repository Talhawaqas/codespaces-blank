// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @title InayaThreatRegistry
/// @notice Tamper-evident record of confirmed security threats. Holds only opaque threatId
///         hashes (keccak256 of the normalized indicator, e.g. domain/IP) plus category/status/
///         confidence — never the plaintext indicator itself (Security Layer SOW §5/§15:
///         "sensitive data should not be written to the blockchain in plaintext"). The backend
///         holds the plaintext<->hash mapping and is the only thing that ever resolves a real
///         domain/IP against this registry.
///
///         SCOPE NOTE: this contract never receives individual raw observations — only the
///         paired InayaThreatReporter contract (set once at deploy, owner-rotatable) can write
///         into it, and only for threats that already crossed a reputation-weighted confidence
///         threshold off-chain. The chain is the tamper-evident anchor for VERIFIED threats, not
///         a place to process every report a node ever submits (SOW §3).
///
///         Category: 0=Unknown 1=Phishing 2=Malware 3=Scam 4=BotnetC2 5=Spam 6=Other
///         Status:   0=Unverified 1=Confirmed 2=Disputed 3=Cleared
///         (kept as plain uint8 rather than Solidity enums so this registry and
///         InayaThreatReporter never need to share an enum type declaration.)
contract InayaThreatRegistry is Ownable {
    struct Threat {
        uint8 category;
        uint8 status;
        uint16 confidenceBps;          // 0-10000
        uint256 firstSeen;
        uint256 lastUpdated;
        bytes32 contributingNodesHash; // keccak256 of the sorted reporting-node address list
    }

    mapping(bytes32 => Threat) public threats;

    /// @dev Only this address may call registerThreat/updateThreatStatus.
    address public reporter;

    event ReporterUpdated(address indexed previousReporter, address indexed newReporter);
    event ThreatRegistered(bytes32 indexed threatId, uint8 category, uint256 timestamp);
    event ThreatStatusUpdated(bytes32 indexed threatId, uint8 status, uint16 confidenceBps, bytes32 contributingNodesHash);

    modifier onlyReporter() {
        require(msg.sender == reporter, "Caller is not the authorized reporter");
        _;
    }

    constructor(address _reporter) Ownable(msg.sender) {
        require(_reporter != address(0), "Reporter address required");
        reporter = _reporter;
    }

    /// @notice Owner-only escape hatch to point at a redeployed reporter contract.
    function setReporter(address _reporter) external onlyOwner {
        require(_reporter != address(0), "Reporter address required");
        emit ReporterUpdated(reporter, _reporter);
        reporter = _reporter;
    }

    function isRegistered(bytes32 _threatId) external view returns (bool) {
        return threats[_threatId].firstSeen != 0;
    }

    function registerThreat(bytes32 _threatId, uint8 _category) external onlyReporter {
        require(threats[_threatId].firstSeen == 0, "Threat already registered");
        threats[_threatId] = Threat({
            category: _category,
            status: 0,
            confidenceBps: 0,
            firstSeen: block.timestamp,
            lastUpdated: block.timestamp,
            contributingNodesHash: bytes32(0)
        });
        emit ThreatRegistered(_threatId, _category, block.timestamp);
    }

    function updateThreatStatus(
        bytes32 _threatId,
        uint8 _status,
        uint16 _confidenceBps,
        bytes32 _contributingNodesHash
    ) external onlyReporter {
        require(_confidenceBps <= 10000, "confidenceBps must be <= 10000");
        require(threats[_threatId].firstSeen != 0, "Unknown threat");
        Threat storage t = threats[_threatId];
        t.status = _status;
        t.confidenceBps = _confidenceBps;
        t.contributingNodesHash = _contributingNodesHash;
        t.lastUpdated = block.timestamp;
        emit ThreatStatusUpdated(_threatId, _status, _confidenceBps, _contributingNodesHash);
    }

    function getThreat(bytes32 _threatId) external view returns (Threat memory) {
        return threats[_threatId];
    }
}
