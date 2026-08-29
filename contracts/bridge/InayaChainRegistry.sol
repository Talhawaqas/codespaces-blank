// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

// ============================================================
// INAYA CHAIN REGISTRY
//
// Owner-managed registry of remote chains this deployment is willing to
// exchange bridge messages with, and, per chain, exactly which sender
// contracts on that chain are trusted as the claimed origin of an inbound
// message. A chain can have more than one trusted sender (e.g. home trusts
// both a spoke's TokenBridgeSpoke and its StakingGatewaySpoke).
//
// Deployed identically (same code) on every chain in the topology -- adding
// a new remote chain later is an owner call here, never a redeploy of
// InayaMessenger itself. `chainFamily` is purely informational (off-chain
// tooling/UI hint, e.g. EVM vs Solana) -- no on-chain logic anywhere
// branches on it.
// ============================================================
contract InayaChainRegistry is Ownable {
    struct RemoteChain {
        bool registered;
        bool active;
        uint8 chainFamily;
        string label;
    }

    mapping(uint256 => RemoteChain) public remoteChains;
    uint256[] public registeredChainIds;

    // chainId => trusted sender contract id (bytes32; a left-padded EVM
    // address or a native 32-byte program id) => trusted?
    mapping(uint256 => mapping(bytes32 => bool)) public trustedRemoteContracts;

    event RemoteChainRegistered(uint256 indexed chainId, uint8 chainFamily, string label);
    event RemoteChainActiveSet(uint256 indexed chainId, bool active);
    event TrustedRemoteContractSet(uint256 indexed chainId, bytes32 indexed remoteContract, bool trusted);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function registerRemoteChain(uint256 chainId, uint8 chainFamily, string calldata label) external onlyOwner {
        require(!remoteChains[chainId].registered, "Chain already registered");
        remoteChains[chainId] = RemoteChain({ registered: true, active: true, chainFamily: chainFamily, label: label });
        registeredChainIds.push(chainId);
        emit RemoteChainRegistered(chainId, chainFamily, label);
    }

    function setRemoteChainActive(uint256 chainId, bool active) external onlyOwner {
        require(remoteChains[chainId].registered, "Chain not registered");
        remoteChains[chainId].active = active;
        emit RemoteChainActiveSet(chainId, active);
    }

    function setTrustedRemoteContract(uint256 chainId, bytes32 remoteContract, bool trusted) external onlyOwner {
        require(remoteChains[chainId].registered, "Chain not registered");
        trustedRemoteContracts[chainId][remoteContract] = trusted;
        emit TrustedRemoteContractSet(chainId, remoteContract, trusted);
    }

    /// @notice true iff `chainId` is registered+active AND `remoteContract` is currently trusted for it.
    function isTrustedRemote(uint256 chainId, bytes32 remoteContract) external view returns (bool) {
        RemoteChain storage c = remoteChains[chainId];
        return c.registered && c.active && trustedRemoteContracts[chainId][remoteContract];
    }

    function isChainActive(uint256 chainId) external view returns (bool) {
        RemoteChain storage c = remoteChains[chainId];
        return c.registered && c.active;
    }

    function getRemoteChain(uint256 chainId) external view returns (uint8 chainFamily, bool active, string memory label) {
        RemoteChain storage c = remoteChains[chainId];
        return (c.chainFamily, c.active, c.label);
    }

    function getRegisteredChainIds() external view returns (uint256[] memory) {
        return registeredChainIds;
    }
}
