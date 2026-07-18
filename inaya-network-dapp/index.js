// ============================================================
// INAYA NODE OPERATOR SOFTWARE
// Phase 1 MVP — self-reported capacity + heartbeat, not yet
// cryptographic proof-of-storage. See README for the honest
// scope boundary before presenting this to institutional reviewers.
// ============================================================
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.NODE_PORT || 4500;
const COORDINATOR_URL = process.env.COORDINATOR_URL || 'https://inaya-network.vercel.app/api/nodes';
const NODE_DATA_DIR = process.env.NODE_DATA_DIR || './node-data';
const NODE_CAPACITY_GB = parseFloat(process.env.NODE_CAPACITY_GB || '100');
const OPERATOR_WALLET = process.env.OPERATOR_WALLET; // where USDT commissions get paid

if (!OPERATOR_WALLET) {
  console.error('❌ OPERATOR_WALLET env var is required — this is the address that receives commission payouts.');
  process.exit(1);
}

if (!fs.existsSync(NODE_DATA_DIR)) fs.mkdirSync(NODE_DATA_DIR, { recursive: true });

// Persistent local node identity — survives container restarts if the volume is mounted
const IDENTITY_FILE = path.join(NODE_DATA_DIR, 'node-identity.json');
let nodeIdentity;
if (fs.existsSync(IDENTITY_FILE)) {
  nodeIdentity = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
} else {
  nodeIdentity = { nodeId: uuidv4(), operatorWallet: OPERATOR_WALLET, registeredAt: Date.now() };
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(nodeIdentity, null, 2));
}

// ============================================================
// STATE — in-memory + persisted snapshot of this node's contribution
// ============================================================
const STATE_FILE = path.join(NODE_DATA_DIR, 'node-state.json');
let state = fs.existsSync(STATE_FILE)
  ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  : {
      usedCapacityGB: 0,
      totalCapacityGB: NODE_CAPACITY_GB,
      shardsStored: 0,
      uptimeStartedAt: Date.now(),
      totalEarnedUsdt: '0',
      lastHeartbeatAt: null,
      acceptingNewShards: true,
    };

const persistState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

// ============================================================
// AUTO-SCALING — accept/reject new shard assignments based on
// remaining capacity. Called by the coordinator when it wants to
// place a new shard on this node.
// ============================================================
app.post('/shards/assign', (req, res) => {
  const { shardId, sizeGB } = req.body;
  if (!shardId || typeof sizeGB !== 'number') {
    return res.status(400).json({ accepted: false, reason: 'shardId and sizeGB (number) are required' });
  }

  const remainingGB = state.totalCapacityGB - state.usedCapacityGB;
  if (!state.acceptingNewShards || sizeGB > remainingGB) {
    return res.status(200).json({
      accepted: false,
      reason: !state.acceptingNewShards ? 'Node is not currently accepting new shards' : 'Insufficient remaining capacity',
      remainingGB,
    });
  }

  // In a full implementation, this is where the actual shard bytes would be
  // fetched/pinned locally (e.g., via an embedded IPFS node). For this MVP,
  // acceptance just reserves capacity and logs the assignment.
  state.usedCapacityGB += sizeGB;
  state.shardsStored += 1;
  persistState();

  return res.json({ accepted: true, nodeId: nodeIdentity.nodeId, remainingGB: state.totalCapacityGB - state.usedCapacityGB });
});

// ============================================================
// HEARTBEAT — reports liveness + current stats to the coordinator.
// Uptime consistency feeds into commission tier qualification.
// ============================================================
const sendHeartbeat = async () => {
  state.lastHeartbeatAt = Date.now();
  persistState();
  try {
    await fetch(`${COORDINATOR_URL}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: nodeIdentity.nodeId,
        operatorWallet: nodeIdentity.operatorWallet,
        usedCapacityGB: state.usedCapacityGB,
        totalCapacityGB: state.totalCapacityGB,
        shardsStored: state.shardsStored,
        timestamp: state.lastHeartbeatAt,
      }),
    });
  } catch (err) {
    console.error('⚠️  Heartbeat to coordinator failed (will retry next interval):', err.message);
  }
};
setInterval(sendHeartbeat, 60_000); // every 60s
sendHeartbeat();

// ============================================================
// EARNINGS DASHBOARD ENDPOINT — the operator's own local dashboard
// reads from this. (A hosted web dashboard can also call this if the
// node exposes its port publicly, or the coordinator can proxy it.)
// ============================================================
app.get('/dashboard', (req, res) => {
  const uptimeHours = ((Date.now() - state.uptimeStartedAt) / (1000 * 60 * 60)).toFixed(1);
  res.json({
    nodeId: nodeIdentity.nodeId,
    operatorWallet: nodeIdentity.operatorWallet,
    contribution: {
      usedCapacityGB: state.usedCapacityGB,
      totalCapacityGB: state.totalCapacityGB,
      utilizationPercent: ((state.usedCapacityGB / state.totalCapacityGB) * 100).toFixed(1),
      shardsStored: state.shardsStored,
    },
    uptimeHours,
    totalEarnedUsdt: state.totalEarnedUsdt,
    acceptingNewShards: state.acceptingNewShards,
  });
});

// Manual capacity toggle — lets an operator pause accepting new shards
// (e.g. before planned maintenance) without shutting the node down
app.post('/capacity/pause', (req, res) => {
  state.acceptingNewShards = false;
  persistState();
  res.json({ acceptingNewShards: false });
});
app.post('/capacity/resume', (req, res) => {
  state.acceptingNewShards = true;
  persistState();
  res.json({ acceptingNewShards: true });
});

app.get('/health', (req, res) => res.json({ status: 'ok', nodeId: nodeIdentity.nodeId }));

app.listen(PORT, () => {
  console.log(`🟢 Inaya Node Operator service running`);
  console.log(`   Node ID: ${nodeIdentity.nodeId}`);
  console.log(`   Operator wallet: ${nodeIdentity.operatorWallet}`);
  console.log(`   Capacity: ${state.totalCapacityGB} GB`);
  console.log(`   Dashboard: http://localhost:${PORT}/dashboard`);
});
