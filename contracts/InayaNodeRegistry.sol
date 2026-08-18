// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

// ============================================================
// INAYA NODE OPERATOR REGISTRY & COMMISSION SETTLEMENT
//
// SCOPE NOTE (important — read before presenting to reviewers):
// "Verification of stored data shards" here means an authorized
// verifier (your backend/oracle, via `verifierWallet`) attests that
// a node held its committed shards for the settlement period. This
// is NOT cryptographic proof-of-storage — it's oracle-attested,
// same trust model most DePIN networks start with before adding a
// real proof system. Describe it accurately: "coordinator-verified"
// not "cryptographically verified," until a real proof system
// replaces this verifier pattern.
// ============================================================
contract InayaNodeRegistry is Ownable {
    IERC20 public usdtToken;

    enum Tier { Entry, Mid, Enterprise }

    struct NodeOperator {
        address wallet;
        uint256 capacityGB;
        uint256 uptimeScore;      // 0-10000 basis points, e.g. 9500 = 95.00% uptime
        Tier tier;
        bool isRegistered;
        uint256 totalEarnedUsdt;  // credited at queue time, not release time -- see queueSettlement
    }

    // Commission rates in basis points (10000 = 100%) -- matches the published Operator
    // Manifesto (30/40/50), not the previous 50/60/70 this contract briefly shipped with.
    uint256 public constant ENTRY_COMMISSION_BPS = 3000;      // 30%
    uint256 public constant MID_COMMISSION_BPS = 4000;        // 40%
    uint256 public constant ENTERPRISE_COMMISSION_BPS = 5000; // 50%

    // Settlement timelock: a single compromised verifierWallet key can no longer drain the
    // USDT reserve in one transaction. queueSettlement() records the payout instead of
    // sending it; releaseSettlement() actually pays out, but only after SETTLEMENT_DELAY has
    // passed -- a real window to notice and react to a compromised key before funds leave.
    // 36h split of the suggested 24-48h range: routine weekly payouts aren't meaningfully
    // delayed, but there's still a full day-plus to react.
    uint256 public constant SETTLEMENT_DELAY = 36 hours;

    struct QueuedSettlement {
        address operator;
        uint256 amount;
        uint256 unlockTime;
        bool released;
    }

    QueuedSettlement[] public queuedSettlements;

    // Tier qualification thresholds — adjust to match real business rules
    uint256 public midTierCapacityGB = 500;         // 500 GB+ for Mid tier
    uint256 public enterpriseTierCapacityGB = 5000;  // 5 TB+ for Enterprise tier
    uint256 public minUptimeScoreBps = 9000;         // 90.00% minimum uptime for tier upgrade eligibility

    // Authorized off-chain verifier (your coordinator backend's signing wallet)
    address public verifierWallet;

    mapping(address => NodeOperator) public nodes;
    address[] public registeredNodeAddresses;

    event NodeRegistered(address indexed operator, uint256 capacityGB);
    event NodeCapacityUpdated(address indexed operator, uint256 newCapacityGB, uint256 newUptimeScore, Tier newTier);
    event CommissionSettled(address indexed operator, uint256 revenueAmount, uint256 commissionAmount, Tier tier);
    event VerifierUpdated(address newVerifier);
    event SettlementQueued(uint256 indexed settlementId, address indexed operator, uint256 amount, uint256 unlockTime);
    event SettlementReleased(uint256 indexed settlementId, address indexed operator, uint256 amount);
    event SettlementSkipped(address indexed operator, string reason);

    modifier onlyVerifier() {
        require(msg.sender == verifierWallet || msg.sender == owner(), "Unauthorized: not the verifier");
        _;
    }

    constructor(address _usdtToken, address _verifierWallet) Ownable(msg.sender) {
        usdtToken = IERC20(_usdtToken);
        verifierWallet = _verifierWallet;
    }

    // ------------------------------------------------------------
    // NODE REGISTRATION
    // ------------------------------------------------------------
    function registerNode(uint256 _capacityGB) external {
        require(!nodes[msg.sender].isRegistered, "Already registered");
        require(_capacityGB > 0, "Capacity must be greater than 0");

        nodes[msg.sender] = NodeOperator({
            wallet: msg.sender,
            capacityGB: _capacityGB,
            uptimeScore: 0,
            tier: Tier.Entry,
            isRegistered: true,
            totalEarnedUsdt: 0
        });
        registeredNodeAddresses.push(msg.sender);

        emit NodeRegistered(msg.sender, _capacityGB);
    }

    // ------------------------------------------------------------
    // VERIFIER-REPORTED CAPACITY & UPTIME UPDATES
    // Called by your coordinator backend after aggregating heartbeat
    // data over a settlement period (e.g. weekly).
    // ------------------------------------------------------------
    function updateNodeMetrics(address _operator, uint256 _capacityGB, uint256 _uptimeScoreBps) external onlyVerifier {
        require(nodes[_operator].isRegistered, "Node not registered");
        require(_uptimeScoreBps <= 10000, "Uptime score out of range");

        NodeOperator storage node = nodes[_operator];
        node.capacityGB = _capacityGB;
        node.uptimeScore = _uptimeScoreBps;
        node.tier = _calculateTier(_capacityGB, _uptimeScoreBps);

        emit NodeCapacityUpdated(_operator, _capacityGB, _uptimeScoreBps, node.tier);
    }

    function _calculateTier(uint256 _capacityGB, uint256 _uptimeScoreBps) internal view returns (Tier) {
        if (_uptimeScoreBps < minUptimeScoreBps) return Tier.Entry; // Uptime gate applies regardless of capacity
        if (_capacityGB >= enterpriseTierCapacityGB) return Tier.Enterprise;
        if (_capacityGB >= midTierCapacityGB) return Tier.Mid;
        return Tier.Entry;
    }

    function getCommissionBps(Tier _tier) public pure returns (uint256) {
        if (_tier == Tier.Enterprise) return ENTERPRISE_COMMISSION_BPS;
        if (_tier == Tier.Mid) return MID_COMMISSION_BPS;
        return ENTRY_COMMISSION_BPS;
    }

    // ------------------------------------------------------------
    // COMMISSION SETTLEMENT — queue, then release after SETTLEMENT_DELAY
    // Called by the verifier after confirming a node held its shards for the settlement
    // period. Calculates {tier commission %} of the revenue amount attributable to this
    // node and QUEUES it — no USDT moves in this call. A separate releaseSettlement() call,
    // made by anyone once SETTLEMENT_DELAY has passed, actually pays it out. See
    // SETTLEMENT_DELAY's comment for why: this is what stops a single compromised
    // verifierWallet key from draining the reserve in one transaction.
    //
    // IMPORTANT: this contract must hold sufficient USDT balance at queue time — checked
    // here as a fail-fast sanity check, though the real balance is re-verified at release
    // time too, since other queued settlements may have been released in between.
    // ------------------------------------------------------------
    function queueSettlement(address _operator, uint256 _attributableRevenueUsdt) external onlyVerifier {
        require(nodes[_operator].isRegistered, "Node not registered");
        require(_attributableRevenueUsdt > 0, "Revenue amount must be greater than 0");

        NodeOperator storage node = nodes[_operator];
        uint256 commissionBps = getCommissionBps(node.tier);
        uint256 commissionAmount = (_attributableRevenueUsdt * commissionBps) / 10000;

        require(usdtToken.balanceOf(address(this)) >= commissionAmount, "Insufficient USDT reserve for payout");

        node.totalEarnedUsdt += commissionAmount;

        uint256 settlementId = queuedSettlements.length;
        uint256 unlockTime = block.timestamp + SETTLEMENT_DELAY;
        queuedSettlements.push(QueuedSettlement({
            operator: _operator,
            amount: commissionAmount,
            unlockTime: unlockTime,
            released: false
        }));

        emit CommissionSettled(_operator, _attributableRevenueUsdt, commissionAmount, node.tier);
        emit SettlementQueued(settlementId, _operator, commissionAmount, unlockTime);
    }

    // Batch version — queues multiple nodes' commissions in one transaction, same pattern
    // as the batch asset registration in the custody contract. Every skip condition now
    // emits SettlementSkipped instead of silently `continue`-ing, so a backend watching
    // events can detect and retry them instead of them going unnoticed.
    function queueSettlementsBatch(
        address[] calldata _operators,
        uint256[] calldata _attributableRevenueAmounts
    ) external onlyVerifier {
        require(_operators.length == _attributableRevenueAmounts.length, "Array length mismatch");
        for (uint256 i = 0; i < _operators.length; i++) {
            address operator = _operators[i];
            uint256 revenueAmount = _attributableRevenueAmounts[i];
            NodeOperator storage node = nodes[operator];

            if (!node.isRegistered) {
                emit SettlementSkipped(operator, "not registered");
                continue;
            }
            if (revenueAmount == 0) {
                emit SettlementSkipped(operator, "zero revenue");
                continue;
            }

            uint256 commissionBps = getCommissionBps(node.tier);
            uint256 commissionAmount = (revenueAmount * commissionBps) / 10000;

            if (usdtToken.balanceOf(address(this)) < commissionAmount) {
                emit SettlementSkipped(operator, "insufficient reserve");
                continue;
            }

            node.totalEarnedUsdt += commissionAmount;

            uint256 settlementId = queuedSettlements.length;
            uint256 unlockTime = block.timestamp + SETTLEMENT_DELAY;
            queuedSettlements.push(QueuedSettlement({
                operator: operator,
                amount: commissionAmount,
                unlockTime: unlockTime,
                released: false
            }));

            emit CommissionSettled(operator, revenueAmount, commissionAmount, node.tier);
            emit SettlementQueued(settlementId, operator, commissionAmount, unlockTime);
        }
    }

    // Publicly callable by design — anyone (the operator themselves, a backend relayer,
    // anyone) can trigger a release once its unlock time has passed. No access control
    // beyond the time-lock itself; that's what makes this censorship-resistant instead of
    // just moving the single-key risk from "who can pay" to "who can release."
    function releaseSettlement(uint256 _settlementId) public {
        require(_settlementId < queuedSettlements.length, "Invalid settlement id");
        QueuedSettlement storage s = queuedSettlements[_settlementId];
        require(!s.released, "Already released");
        require(block.timestamp >= s.unlockTime, "Settlement still locked");

        s.released = true; // effects before the external call
        require(usdtToken.transfer(s.operator, s.amount), "USDT release transfer failed");

        emit SettlementReleased(_settlementId, s.operator, s.amount);
    }

    // Batch release — skips (rather than reverts on) already-released, not-yet-unlocked, or
    // out-of-range ids, same non-reverting-batch philosophy as queueSettlementsBatch.
    function releaseSettlementsBatch(uint256[] calldata _settlementIds) external {
        for (uint256 i = 0; i < _settlementIds.length; i++) {
            uint256 id = _settlementIds[i];
            if (id >= queuedSettlements.length) continue;
            QueuedSettlement storage s = queuedSettlements[id];
            if (s.released || block.timestamp < s.unlockTime) continue;

            s.released = true;
            usdtToken.transfer(s.operator, s.amount);
            emit SettlementReleased(id, s.operator, s.amount);
        }
    }

    function getQueuedSettlementsCount() external view returns (uint256) {
        return queuedSettlements.length;
    }

    // ------------------------------------------------------------
    // ADMIN CONFIGURATION
    // ------------------------------------------------------------
    function setVerifierWallet(address _newVerifier) external onlyOwner {
        require(_newVerifier != address(0), "Zero address not allowed");
        verifierWallet = _newVerifier;
        emit VerifierUpdated(_newVerifier);
    }

    function setTierThresholds(uint256 _midTierGB, uint256 _enterpriseTierGB, uint256 _minUptimeBps) external onlyOwner {
        midTierCapacityGB = _midTierGB;
        enterpriseTierCapacityGB = _enterpriseTierGB;
        minUptimeScoreBps = _minUptimeBps;
    }

    function fundReserve(uint256 _amount) external {
        require(usdtToken.transferFrom(msg.sender, address(this), _amount), "USDT funding transfer failed");
    }

    function withdrawExcessReserve(address _to, uint256 _amount) external onlyOwner {
        require(usdtToken.transfer(_to, _amount), "Withdrawal failed");
    }

    function getRegisteredNodeCount() external view returns (uint256) {
        return registeredNodeAddresses.length;
    }
}
