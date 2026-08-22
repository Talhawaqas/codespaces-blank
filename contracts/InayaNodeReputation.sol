// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @title InayaNodeReputation
/// @notice Periodic, tamper-evident checkpoints of each reporting node's reputation score.
///         Real-time reputation lives off-chain (Security Layer SOW §9: "local decisions don't
///         wait for blockchain confirmation") — the backend recomputes scores continuously in
///         MongoDB as reports come in, and only checkpoints the current score here on a cadence
///         (e.g. daily, or on a significant change), the same "batch the on-chain writes"
///         philosophy as InayaThreatReporter. A single malicious node reporting garbage can only
///         ever move its OWN checkpoint down over time — it can't touch any other node's record.
contract InayaNodeReputation is Ownable {
    struct Reputation {
        uint16 scoreBps;             // 0-10000, higher = more trusted
        uint256 totalConfirmed;      // cumulative count of this node's reports that led to a CONFIRMED threat
        uint256 totalFalsePositive;  // cumulative count of this node's reports later marked Cleared/Disputed
        uint256 lastCheckpoint;
    }

    mapping(address => Reputation) public reputations;

    uint16 public constant DEFAULT_SCORE_BPS = 5000; // neutral starting reputation for an unseen node

    /// @dev Same trust model as InayaThreatReporter's relayer — a single backend-controlled hot
    ///      wallet, rotatable by the owner.
    address public relayer;

    event RelayerUpdated(address indexed previousRelayer, address indexed newRelayer);
    event ReputationCheckpointed(
        address indexed node,
        uint16 scoreBps,
        uint256 totalConfirmed,
        uint256 totalFalsePositive,
        uint256 timestamp
    );

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

    function checkpointReputation(
        address _node,
        uint16 _scoreBps,
        uint256 _confirmedDelta,
        uint256 _falsePositiveDelta
    ) external onlyRelayer {
        require(_node != address(0), "Node address required");
        require(_scoreBps <= 10000, "scoreBps must be <= 10000");
        Reputation storage r = reputations[_node];
        r.scoreBps = _scoreBps;
        r.totalConfirmed += _confirmedDelta;
        r.totalFalsePositive += _falsePositiveDelta;
        r.lastCheckpoint = block.timestamp;
        emit ReputationCheckpointed(_node, _scoreBps, r.totalConfirmed, r.totalFalsePositive, block.timestamp);
    }

    /// @notice Returns DEFAULT_SCORE_BPS (neutral, not zero) for a node that's never been
    ///         checkpointed yet, so an unseen node isn't punished as if it had a proven-bad record.
    function getReputation(address _node) external view returns (Reputation memory) {
        Reputation memory r = reputations[_node];
        if (r.lastCheckpoint == 0) {
            r.scoreBps = DEFAULT_SCORE_BPS;
        }
        return r;
    }
}
