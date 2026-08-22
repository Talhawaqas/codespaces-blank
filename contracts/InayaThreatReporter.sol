// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @dev Minimal external interface into InayaThreatRegistry. category/status are passed as plain
///      uint8 (see that contract's header for the encoding) so this file never needs to import
///      or duplicate the registry's own type declarations.
interface IInayaThreatRegistry {
    function isRegistered(bytes32 threatId) external view returns (bool);
    function registerThreat(bytes32 threatId, uint8 category) external;
    function updateThreatStatus(bytes32 threatId, uint8 status, uint16 confidenceBps, bytes32 contributingNodesHash) external;
}

/// @title InayaThreatReporter
/// @notice The only path by which a threat becomes CONFIRMED on-chain. Individual node
///         observations are never submitted here — they're collected and reputation-weighted
///         off-chain by the Inaya backend (src/lib/security.js's computeThreatConfidence); once
///         a threat crosses the confidence threshold, the backend's relayer wallet calls
///         confirmThreat() exactly once per status change. Keeps this contract's gas cost and
///         attack surface tiny: no per-report bookkeeping on-chain at all (Security Layer SOW §3).
contract InayaThreatReporter is Ownable {
    IInayaThreatRegistry public immutable registry;

    /// @dev The backend relayer wallet — the only address allowed to call confirmThreat/
    ///      setThreatStatus. Same trust model as InayaNodeRegistry's verifierWallet: a single hot
    ///      wallet funded just enough for gas, rotatable by the owner if it's ever compromised.
    address public relayer;

    uint8 public constant STATUS_CONFIRMED = 1;
    uint8 public constant STATUS_DISPUTED = 2;
    uint8 public constant STATUS_CLEARED = 3;

    event RelayerUpdated(address indexed previousRelayer, address indexed newRelayer);
    event ThreatConfirmed(bytes32 indexed threatId, uint8 category, uint16 confidenceBps, bytes32 contributingNodesHash);
    event ThreatStatusChanged(bytes32 indexed threatId, uint8 status, uint16 confidenceBps, bytes32 contributingNodesHash);

    modifier onlyRelayer() {
        require(msg.sender == relayer, "Caller is not the authorized relayer");
        _;
    }

    constructor(address _registry, address _relayer) Ownable(msg.sender) {
        require(_registry != address(0), "Registry address required");
        require(_relayer != address(0), "Relayer address required");
        registry = IInayaThreatRegistry(_registry);
        relayer = _relayer;
    }

    function setRelayer(address _relayer) external onlyOwner {
        require(_relayer != address(0), "Relayer address required");
        emit RelayerUpdated(relayer, _relayer);
        relayer = _relayer;
    }

    /// @notice Confirms a threat has crossed the off-chain reputation-weighted confidence
    ///         threshold. Registers it in the registry first if this is the first time it's
    ///         been seen on-chain, then always records the CONFIRMED status.
    function confirmThreat(
        bytes32 _threatId,
        uint8 _category,
        uint16 _confidenceBps,
        bytes32 _contributingNodesHash
    ) external onlyRelayer {
        require(_confidenceBps <= 10000, "confidenceBps must be <= 10000");
        if (!registry.isRegistered(_threatId)) {
            registry.registerThreat(_threatId, _category);
        }
        registry.updateThreatStatus(_threatId, STATUS_CONFIRMED, _confidenceBps, _contributingNodesHash);
        emit ThreatConfirmed(_threatId, _category, _confidenceBps, _contributingNodesHash);
    }

    /// @notice Governance override for a previously confirmed threat — e.g. a false positive
    ///         cleared after human review (SOW §19's "administrative/governance controls"
    ///         anti-abuse requirement). Still relayer-gated so it flows through the same backend
    ///         admin route (isAdminAuthenticated) as everything else, not a separate on-chain-only
    ///         admin path.
    function setThreatStatus(
        bytes32 _threatId,
        uint8 _status,
        uint16 _confidenceBps,
        bytes32 _contributingNodesHash
    ) external onlyRelayer {
        require(_confidenceBps <= 10000, "confidenceBps must be <= 10000");
        require(registry.isRegistered(_threatId), "Unknown threat");
        registry.updateThreatStatus(_threatId, _status, _confidenceBps, _contributingNodesHash);
        emit ThreatStatusChanged(_threatId, _status, _confidenceBps, _contributingNodesHash);
    }
}
