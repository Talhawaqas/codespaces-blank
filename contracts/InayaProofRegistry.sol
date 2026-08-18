// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @dev Minimal read-only view of InayaCustody — the only function this contract needs is the
///      one that tells it who actually owns a given fileHash, so registerMerkleRoot can verify
///      against it instead of trusting a self-reported msg.sender.
interface IInayaCustody {
    function assets(bytes32 _fileHash) external view returns (
        address owner,
        string memory shardACID,
        string memory shardBCID,
        uint256 timestamp
    );
}

/// @title InayaProofRegistry
/// @notice Stores a Merkle root per asset (keyed by the same fileHash used in InayaCustody) and
///         verifies chunk-level proofs against it. Kept separate from InayaCustody so the proof
///         logic can be upgraded independently of the ownership/CID mapping.
///
///         Path A (today): `verifyChunkProof` is onlyOwner because your own backend fetches the
///         chunk and checks it. Path B (later): remove onlyOwner, require the caller to be a
///         staked node from InayaNodeRegistry, and add a slash() call on failure.
contract InayaProofRegistry is Ownable {
    /// @dev Source of truth for asset ownership — set once at deploy time and never changed,
    ///      matching InayaCustody's own address being immutable in practice (a fresh deploy
    ///      there would need a fresh deploy here too, since the two are meant to stay paired).
    IInayaCustody public immutable custody;

    /// @dev Owner-curated allowlist of storage node operators, consistent with the Path A
    ///      centralized-trust model this contract already uses for verifyChunkProof — there's no
    ///      staking/slashing infrastructure (InayaNodeRegistry) to check against yet, so the
    ///      backend operator is the trust anchor for "is this a real node" the same way it
    ///      already is for "is this chunk proof valid." address(0) (no node assigned yet) is
    ///      always allowed regardless of this mapping — that's the documented "haven't wired up
    ///      node assignment yet" case, not an attribution someone is making up.
    struct AssetProof {
        bytes32 merkleRoot;
        uint256 chunkCount;
        address owner;              // the uploader (matches InayaCustody's owner)
        address node;                // which node operator is accountable for hosting this asset
        uint256 registeredAt;
        uint256 lastVerifiedAt;
        uint256 challengesPassed;
        uint256 challengesFailed;
    }

    mapping(bytes32 => AssetProof) public assetProofs;
    mapping(address => bool) public isRegisteredNode;

    // Per-node aggregate reliability — survives across every asset a node has ever hosted.
    mapping(address => uint256) public nodePassCount;
    mapping(address => uint256) public nodeFailCount;

    event MerkleRootRegistered(
        bytes32 indexed fileHash,
        bytes32 merkleRoot,
        uint256 chunkCount,
        address indexed owner,
        address indexed node
    );
    event ChallengeIssued(bytes32 indexed fileHash, uint256 leafIndex, uint256 deadline);
    event ProofVerified(bytes32 indexed fileHash, uint256 leafIndex, bool success, address indexed node);
    event NodeRegistrationChanged(address indexed node, bool isRegistered);

    constructor(address _custody) Ownable(msg.sender) {
        require(_custody != address(0), "Custody address required");
        custody = IInayaCustody(_custody);
    }

    /// @notice Owner-only curation of which addresses may be attributed as a hosting node in
    ///         registerMerkleRoot — see isRegisteredNode's comment for why this exists.
    function setNodeRegistered(address _node, bool _isRegistered) external onlyOwner {
        require(_node != address(0), "Cannot register the zero address");
        isRegisteredNode[_node] = _isRegistered;
        emit NodeRegistrationChanged(_node, _isRegistered);
    }

    /// @param _node The storage node operator accountable for this asset. Pass address(0) if you
    ///              haven't wired up node assignment yet (e.g. everything is still on Pinata) —
    ///              the contract still works, you just won't get per-node reliability stats until
    ///              you start passing real operator addresses. Any non-zero value must already be
    ///              approved via setNodeRegistered, or the call reverts — see isRegisteredNode.
    function registerMerkleRoot(
        bytes32 _fileHash,
        bytes32 _merkleRoot,
        uint256 _chunkCount,
        address _node
    ) external {
        require(assetProofs[_fileHash].registeredAt == 0, "Already registered");

        // The whole point of this check: msg.sender is never trusted as "the owner" on its own —
        // it has to match what InayaCustody, the actual source of truth for who uploaded this
        // file, already recorded. Without this, anyone could front-run a legitimate uploader's
        // own pending fileHash and permanently lock them out (registerMerkleRoot has no update
        // path once registered).
        (address recordedOwner, , , ) = custody.assets(_fileHash);
        require(recordedOwner != address(0), "Asset not found in InayaCustody");
        require(msg.sender == recordedOwner, "Caller is not the Custody-recorded owner");

        require(_node == address(0) || isRegisteredNode[_node], "Node not registered");

        assetProofs[_fileHash] = AssetProof({
            merkleRoot: _merkleRoot,
            chunkCount: _chunkCount,
            owner: msg.sender,
            node: _node,
            registeredAt: block.timestamp,
            lastVerifiedAt: 0,
            challengesPassed: 0,
            challengesFailed: 0
        });
        emit MerkleRootRegistered(_fileHash, _merkleRoot, _chunkCount, msg.sender, _node);
    }

    function verifyChunkProof(
        bytes32 _fileHash,
        uint256 _leafIndex,
        bytes32 _leaf,
        bytes32[] calldata _proof
    ) external onlyOwner returns (bool) {
        AssetProof storage record = assetProofs[_fileHash];
        require(record.registeredAt != 0, "Unknown asset");

        bool valid = MerkleProof.verify(_proof, record.merkleRoot, _leaf);
        if (valid) {
            record.lastVerifiedAt = block.timestamp;
            record.challengesPassed += 1;
            nodePassCount[record.node] += 1;
        } else {
            record.challengesFailed += 1;
            nodeFailCount[record.node] += 1;
        }
        emit ProofVerified(_fileHash, _leafIndex, valid, record.node);
        return valid;
    }

    function getNodeReliability(address _node) external view returns (uint256 passed, uint256 failed) {
        return (nodePassCount[_node], nodeFailCount[_node]);
    }

    function getAssetProof(bytes32 _fileHash) external view returns (AssetProof memory) {
        return assetProofs[_fileHash];
    }
}
