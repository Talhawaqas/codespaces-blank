// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title InayaProofRegistry
/// @notice Stores a Merkle root per asset (keyed by the same fileHash used in InayaCustody) and
///         verifies chunk-level proofs against it. Kept separate from InayaCustody so the proof
///         logic can be upgraded independently of the ownership/CID mapping.
///
///         Path A (today): `verifyChunkProof` is onlyOwner because your own backend fetches the
///         chunk and checks it. Path B (later): remove onlyOwner, require the caller to be a
///         staked node from InayaNodeRegistry, and add a slash() call on failure.
contract InayaProofRegistry is Ownable {
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

    constructor() Ownable(msg.sender) {}

    /// @param _node The storage node operator accountable for this asset. Pass address(0) if you
    ///              haven't wired up node assignment yet (e.g. everything is still on Pinata) —
    ///              the contract still works, you just won't get per-node reliability stats until
    ///              you start passing real operator addresses.
    function registerMerkleRoot(
        bytes32 _fileHash,
        bytes32 _merkleRoot,
        uint256 _chunkCount,
        address _node
    ) external {
        require(assetProofs[_fileHash].registeredAt == 0, "Already registered");
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
