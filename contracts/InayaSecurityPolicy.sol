// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @title InayaSecurityPolicy
/// @notice Tamper-evident version history for the security policy bundle (allow/block category
///         defaults, mode thresholds, etc.). The real policy JSON is served by the backend
///         (GET /api/security/policy); clients hash what they downloaded and compare it against
///         the latest record here to confirm it hasn't been tampered with in transit or at rest
///         — satisfies Security Layer SOW §10's "signature/status verification" and
///         "versioning" requirements without putting the policy content itself on-chain.
contract InayaSecurityPolicy is Ownable {
    struct PolicyVersion {
        bytes32 policyHash; // keccak256 of the canonical policy JSON the backend serves
        string policyURI;   // where to fetch it (backend URL or an IPFS CID)
        uint256 publishedAt;
    }

    uint256 public currentVersion;
    mapping(uint256 => PolicyVersion) public policyVersions;

    /// @dev Same relayer trust model as the rest of this layer — the backend admin route
    ///      (isAdminAuthenticated-gated) is the only thing that ever calls publishPolicy.
    address public relayer;

    event RelayerUpdated(address indexed previousRelayer, address indexed newRelayer);
    event PolicyPublished(uint256 indexed version, bytes32 policyHash, string policyURI, uint256 timestamp);

    modifier onlyRelayer() {
        require(msg.sender == relayer, "Caller is not the authorized relayer");
        _;
    }

    constructor(address _relayer) Ownable(msg.sender) {
        require(_relayer != address(0), "Relayer address required");
        relayer = _relayer;
    }

    function setRelayer(address _relayer) external onlyOwner {
        require(_relayer != address(0), "Relayer address required");
        emit RelayerUpdated(relayer, _relayer);
        relayer = _relayer;
    }

    /// @notice Versions must increment by exactly 1 — prevents a compromised relayer from
    ///         skipping ahead or overwriting history; every version stays permanently readable.
    function publishPolicy(uint256 _version, bytes32 _policyHash, string calldata _policyURI) external onlyRelayer {
        require(_version == currentVersion + 1, "Version must increment by exactly 1");
        require(_policyHash != bytes32(0), "Policy hash required");
        policyVersions[_version] = PolicyVersion({
            policyHash: _policyHash,
            policyURI: _policyURI,
            publishedAt: block.timestamp
        });
        currentVersion = _version;
        emit PolicyPublished(_version, _policyHash, _policyURI, block.timestamp);
    }

    function getCurrentPolicy() external view returns (PolicyVersion memory) {
        return policyVersions[currentVersion];
    }

    function getPolicy(uint256 _version) external view returns (PolicyVersion memory) {
        return policyVersions[_version];
    }
}
