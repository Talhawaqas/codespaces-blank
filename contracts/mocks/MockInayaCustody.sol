// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev Test-only stand-in for the real (source-unavailable, ABI-only) InayaCustody contract —
///      exposes just enough of assets(bytes32) to exercise InayaBackupRegistry's/
///      InayaProofRegistry's owner-cross-check logic in isolation, without needing the real
///      deployed contract's bytecode.
contract MockInayaCustody {
    struct Asset {
        address owner;
        string shardACID;
        string shardBCID;
        uint256 timestamp;
    }

    mapping(bytes32 => Asset) public assets;

    function setAsset(bytes32 fileHash, address owner, string calldata shardACID, string calldata shardBCID, uint256 timestamp) external {
        assets[fileHash] = Asset({ owner: owner, shardACID: shardACID, shardBCID: shardBCID, timestamp: timestamp });
    }
}
