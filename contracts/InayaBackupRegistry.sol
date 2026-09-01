// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @dev Minimal read-only view of InayaCustody — same pattern as InayaProofRegistry.sol's own
///      IInayaCustody, so registerRedundancyCommitment can verify the caller's asset actually
///      exists and who really owns it, instead of trusting a self-reported argument.
interface IInayaCustody {
    function assets(bytes32 _fileHash) external view returns (
        address owner,
        string memory shardACID,
        string memory shardBCID,
        uint256 timestamp
    );
}

/// @title InayaBackupRegistry
/// @notice Records a redundancy commitment and current backup-health state per asset (keyed by
///         the same fileHash InayaCustody/InayaProofRegistry use). Kept as its own contract
///         rather than folded into InayaProofRegistry: that contract's data (a Merkle root) is
///         written once at upload and verified via chunk proofs; this contract's data (replica
///         count + a 5-state health enum) is written repeatedly over an asset's life as the
///         off-chain backup coordinator observes real replica health. Coupling the two would
///         bloat an already-shipped, narrowly-scoped contract for no shared benefit.
///
///         Per the SOW's own on-chain scope limit, only identifiers/commitments/state live here:
///         `_replicaSetHash` is a hash of the current replica-provider topology (which CIDs live
///         on which pinning provider) computed off-chain — the actual topology, replica CIDs,
///         and content hashes stay in the coordinator's database, never on-chain. This mirrors
///         InayaProofRegistry storing only a Merkle root, never the chunk data itself.
///
///         Path A (today, same as InayaProofRegistry.verifyChunkProof): every write here is
///         onlyOwner because the backend coordinator is the sole health-observer — there is no
///         staked, decentralized set of health-reporters to trust instead yet. Because there is
///         exactly one authorized caller, a stale/out-of-order write is an operational bug in
///         that one backend, not a spoofing risk from an untrusted third party — so this contract
///         does not add its own sequence/nonce scheme on top of onlyOwner, consistent with how
///         InayaProofRegistry doesn't either.
contract InayaBackupRegistry is Ownable {
    /// @dev Set once at deploy time, mirrors InayaProofRegistry's own immutable custody reference.
    IInayaCustody public immutable custody;

    enum BackupHealthState {
        Protected,
        Rebuilding,
        Degraded,
        RecoveryRequired,
        RecoveryFailed
    }

    struct BackupRecord {
        address owner;                 // matches InayaCustody's recorded owner at registration time
        uint8 targetReplicaCount;      // configurable redundancy target (SOW §3: "redundancy must be configurable")
        bytes32 replicaSetHash;        // hash of the off-chain replica-provider topology, not the topology itself
        BackupHealthState healthState;
        uint256 registeredAt;
        uint256 lastStateChangeAt;
    }

    mapping(bytes32 => BackupRecord) public backupRecords;

    event RedundancyCommitmentRegistered(
        bytes32 indexed fileHash,
        address indexed owner,
        uint8 targetReplicaCount,
        bytes32 replicaSetHash
    );
    event RedundancyCommitmentUpdated(bytes32 indexed fileHash, uint8 targetReplicaCount, bytes32 replicaSetHash);
    event BackupHealthChanged(bytes32 indexed fileHash, BackupHealthState previousState, BackupHealthState newState);

    constructor(address _custody) Ownable(msg.sender) {
        require(_custody != address(0), "Custody address required");
        custody = IInayaCustody(_custody);
    }

    /// @notice One-time registration of an asset's redundancy target, right after its shards have
    ///         first been replicated to the configured number of providers. Reverts if the
    ///         fileHash isn't a real, already-registered InayaCustody asset, or if it's already
    ///         been registered here (no re-registration path — use updateRedundancyCommitment for
    ///         a changed target, or setBackupHealthState for an observed health transition).
    function registerRedundancyCommitment(
        bytes32 _fileHash,
        uint8 _targetReplicaCount,
        bytes32 _replicaSetHash
    ) external onlyOwner {
        require(backupRecords[_fileHash].registeredAt == 0, "Already registered");
        require(_targetReplicaCount > 0, "targetReplicaCount must be > 0");

        (address recordedOwner, , , ) = custody.assets(_fileHash);
        require(recordedOwner != address(0), "Asset not found in InayaCustody");

        backupRecords[_fileHash] = BackupRecord({
            owner: recordedOwner,
            targetReplicaCount: _targetReplicaCount,
            replicaSetHash: _replicaSetHash,
            healthState: BackupHealthState.Protected,
            registeredAt: block.timestamp,
            lastStateChangeAt: block.timestamp
        });

        emit RedundancyCommitmentRegistered(_fileHash, recordedOwner, _targetReplicaCount, _replicaSetHash);
    }

    /// @notice Updates the target replica count and/or the replica-topology hash for an
    ///         already-registered asset — e.g. after a re-replication restores the set to a new
    ///         provider. Does not itself change healthState; call setBackupHealthState separately.
    function updateRedundancyCommitment(
        bytes32 _fileHash,
        uint8 _targetReplicaCount,
        bytes32 _replicaSetHash
    ) external onlyOwner {
        BackupRecord storage record = backupRecords[_fileHash];
        require(record.registeredAt != 0, "Unknown asset");
        require(_targetReplicaCount > 0, "targetReplicaCount must be > 0");

        record.targetReplicaCount = _targetReplicaCount;
        record.replicaSetHash = _replicaSetHash;
        emit RedundancyCommitmentUpdated(_fileHash, _targetReplicaCount, _replicaSetHash);
    }

    /// @notice Records an observed backup-health state transition. A no-op (no event, no storage
    ///         write) if the new state equals the current one — the coordinator's poll loop calls
    ///         this on every check-pins/recovery sweep, and only a genuine boundary crossing
    ///         should cost gas or appear in the audit trail (SOW §6's storage-efficiency
    ///         requirement, applied here to on-chain writes specifically).
    function setBackupHealthState(bytes32 _fileHash, BackupHealthState _newState) external onlyOwner {
        BackupRecord storage record = backupRecords[_fileHash];
        require(record.registeredAt != 0, "Unknown asset");

        BackupHealthState previous = record.healthState;
        if (previous == _newState) return;

        record.healthState = _newState;
        record.lastStateChangeAt = block.timestamp;
        emit BackupHealthChanged(_fileHash, previous, _newState);
    }

    function getBackupRecord(bytes32 _fileHash) external view returns (BackupRecord memory) {
        return backupRecords[_fileHash];
    }
}
