// src/lib/security.js
//
// Backend core of the Inaya Network Security Layer (per
// Inaya_Network_Security_Layer_SOW.md): decentralized threat intelligence
// with node-reported observations, reputation-weighted confirmation, and
// on-chain tamper-evident records for confirmed threats and policy
// versions only -- individual observations NEVER touch the chain (SOW §3).
//
// Flow: a node signs and POSTs an observation (recordSecurityReport) ->
// upserted into security_reports (deduped per node+threat+day, same
// dedup-via-upsert idiom as activity.js) -> computeThreatConfidence
// reputation-weights every independent reporter in the lookback window ->
// once confidence crosses CONFIRM_THRESHOLD_BPS, the backend's relayer
// wallet calls InayaThreatReporter.confirmThreat() exactly once per status
// change. Node reputation is tracked in real time off-chain
// (security_reputation_cache) and only checkpointed to InayaNodeReputation
// periodically via checkpointDirtyReputations() (SOW §9: local decisions
// don't wait for blockchain confirmation).
//
// Same shape as every other src/lib/X.js in this codebase: getXCollections,
// module-level indexesEnsured guard, ensureXIndexes, validateXInput
// functions that throw (fail-closed).

import { ethers } from "ethers";
import { connectToDatabase } from "./mongodb.js";

const RPC_URL = process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545";
const THREAT_REGISTRY_ADDRESS = process.env.NEXT_PUBLIC_THREAT_REGISTRY_ADDRESS;
const THREAT_REPORTER_ADDRESS = process.env.NEXT_PUBLIC_THREAT_REPORTER_ADDRESS;
const NODE_REPUTATION_ADDRESS = process.env.NEXT_PUBLIC_NODE_REPUTATION_ADDRESS;
const SECURITY_POLICY_ADDRESS = process.env.NEXT_PUBLIC_SECURITY_POLICY_ADDRESS;

const REPORTER_ABI = [
  "function confirmThreat(bytes32 threatId, uint8 category, uint16 confidenceBps, bytes32 contributingNodesHash) external",
  "function setThreatStatus(bytes32 threatId, uint8 status, uint16 confidenceBps, bytes32 contributingNodesHash) external",
];
const NODE_REPUTATION_ABI = [
  "function checkpointReputation(address node, uint16 scoreBps, uint256 confirmedDelta, uint256 falsePositiveDelta) external",
];
const SECURITY_POLICY_ABI = [
  "function publishPolicy(uint256 version, bytes32 policyHash, string calldata policyURI) external",
];

// Category/status encodings mirror InayaThreatRegistry.sol's documented uint8 layout exactly --
// changing either list's order would desync on-chain and off-chain meaning.
export const SECURITY_CATEGORIES = ["unknown", "phishing", "malware", "scam", "botnet_c2", "spam", "other"];
export const SECURITY_STATUS = { UNVERIFIED: 0, CONFIRMED: 1, DISPUTED: 2, CLEARED: 3 };
export const SECURITY_STATUS_LABELS = ["unverified", "confirmed", "disputed", "cleared"];

export const CONFIRM_THRESHOLD_BPS = 7500;
export const MIN_INDEPENDENT_REPORTERS = 3; // a single node's word is never enough to confirm anything
export const REPORT_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_REPORTS_PER_NODE_PER_DAY = 200; // anti-spam ceiling, generous for a legitimate node daemon
export const DEFAULT_REPUTATION_BPS = 5000; // neutral starting point for a never-seen node
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000; // same window as metadata-auth.js / watcherPioneer.js

const MAX_INDICATOR_LEN = 253; // max DNS hostname length, generous enough for an IP too
const MAX_EVIDENCE_HASH_LEN = 128;
const MAX_IDENTITY_LEN = 200;
const MAX_DESTINATION_LEN = 300;
const MAX_REASON_LEN = 300;
const SECURITY_EVENT_TYPES = ["block", "warn", "allow", "policy_sync"];

const DEFAULT_POLICY_CONTENT = {
  modes: {
    monitor: { blockOnConfirmed: false, warnOnConfirmed: true },
    protect: { blockOnConfirmed: true, warnOnConfirmed: true, minConfidenceBpsToBlock: CONFIRM_THRESHOLD_BPS },
    strict: { blockOnConfirmed: true, warnOnConfirmed: true, minConfidenceBpsToBlock: 6000 },
  },
  categoryDefaults: Object.fromEntries(SECURITY_CATEGORIES.map((c) => [c, { block: c !== "unknown" }])),
};

// ============================================================
// Small local helpers (duplicated rather than imported -- same convention
// watcherPioneer.js's header comment documents: this repo prefers a small
// per-file copy over coupling unrelated features to one shared utility).
// ============================================================

export function normalizeWallet(address) {
  if (typeof address !== "string") return "";
  return address.trim().toLowerCase();
}

export function normalizeIndicator(indicator) {
  if (typeof indicator !== "string") return "";
  return indicator.trim().toLowerCase();
}

/** The on-chain threatId is keccak256 of the normalized indicator -- computed off-chain so the
 *  plaintext domain/IP never has to be written on-chain (SOW §5/§15). */
export function computeThreatId(indicator) {
  return ethers.keccak256(ethers.toUtf8Bytes(normalizeIndicator(indicator)));
}

export function categoryToIndex(name) {
  const idx = SECURITY_CATEGORIES.indexOf(String(name || "").toLowerCase());
  return idx === -1 ? 0 : idx;
}

export function indexToCategory(idx) {
  return SECURITY_CATEGORIES[idx] ?? "unknown";
}

function getRelayerWallet() {
  if (!process.env.RELAYER_PRIVATE_KEY) return null;
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  return new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
}

function hashPolicyContent(content) {
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(content)));
}

// ============================================================
// Collections
//   security_reports           -- raw signed observations, deduped per node+threat+day
//   security_threats            -- aggregated view, _id = threatId (the keccak256 hash itself)
//   security_policy             -- single "current" doc, versioned
//   security_events             -- per-device block/warn/allow decision history
//   security_reputation_cache   -- off-chain real-time mirror of on-chain checkpoints
// ============================================================

export async function getSecurityCollections() {
  const { db } = await connectToDatabase();
  return {
    db,
    reports: db.collection("security_reports"),
    threats: db.collection("security_threats"),
    policy: db.collection("security_policy"),
    events: db.collection("security_events"),
    reputationCache: db.collection("security_reputation_cache"),
  };
}

let indexesEnsured = false;

export async function ensureSecurityIndexes() {
  if (indexesEnsured) return;
  const { reports, threats, events, reputationCache, policy } = await getSecurityCollections();

  await Promise.all([
    reports.createIndex({ nodeAddress: 1, threatId: 1, date: 1 }, { unique: true }),
    reports.createIndex({ threatId: 1, createdAt: -1 }),
    reports.createIndex({ nodeAddress: 1, createdAt: -1 }),
    threats.createIndex({ status: 1, lastUpdated: -1 }),
    events.createIndex({ identityId: 1, createdAt: -1 }),
    reputationCache.createIndex({ dirty: 1 }),
    // version:0 -- deliberately NOT yet on-chain (InayaSecurityPolicy.currentVersion() starts
    // at 0 too). The first real admin publishPolicy() call bumps to version 1 both here and
    // on-chain, keeping the two counters in lockstep. See publishPolicy()'s comment.
    policy.updateOne(
      { _id: "current" },
      {
        $setOnInsert: {
          _id: "current",
          version: 0,
          content: DEFAULT_POLICY_CONTENT,
          hash: hashPolicyContent(DEFAULT_POLICY_CONTENT),
          publishedAt: new Date(),
        },
      },
      { upsert: true }
    ),
  ]);

  indexesEnsured = true;
}

// ============================================================
// Signed threat-report verification -- same technique as metadata-auth.js's
// verifyMetadataAuth / watcherPioneer.js's verifyWatcherAuth (message
// reconstruction + ethers.verifyMessage + freshness window, fail-closed by
// throwing). Independent message schema, implemented locally per this
// codebase's established precedent of not coupling unrelated auth flows
// to one shared file.
// ============================================================

/** Builds the exact string a reporting node (mobile/desktop background service, or the
 *  node-daemon's `report` command) must sign. Keep in lockstep with every client that signs
 *  security reports. */
export function buildSecurityReportMessage({ indicator, category, confidenceBps, evidenceHash, timestamp }) {
  const lines = [
    "Inaya Security Report",
    `indicator: ${normalizeIndicator(indicator)}`,
    `category: ${String(category)}`,
    `confidenceBps: ${confidenceBps}`,
  ];
  if (evidenceHash) lines.push(`evidenceHash: ${evidenceHash}`);
  lines.push(`timestamp: ${timestamp}`);
  return lines.join("\n");
}

export function verifySecurityReportAuth({ nodeAddress, indicator, category, confidenceBps, evidenceHash, message, signature, timestamp }) {
  if (!nodeAddress || !message || !signature || typeof timestamp !== "number") {
    throw new Error("Missing auth fields — nodeAddress, message, signature, and timestamp are all required.");
  }
  if (Date.now() - timestamp > MAX_SIGNATURE_AGE_MS) {
    throw new Error("Signature expired — please retry.");
  }

  const expectedMessage = buildSecurityReportMessage({ indicator, category, confidenceBps, evidenceHash, timestamp });
  if (message !== expectedMessage) {
    throw new Error("Signed message doesn't match the request fields — possible tampering.");
  }

  const recovered = ethers.verifyMessage(message, signature);
  if (recovered.toLowerCase() !== nodeAddress.toLowerCase()) {
    throw new Error("Signature does not match the claiming node address.");
  }
}

// ============================================================
// Validation
// ============================================================

export function validateSecurityReportInput({ indicator, category, confidenceBps, evidenceHash }) {
  const clean = normalizeIndicator(indicator);
  if (!clean || clean.length > MAX_INDICATOR_LEN) {
    throw new Error("A valid indicator (domain or IP) is required.");
  }
  if (typeof confidenceBps !== "number" || Number.isNaN(confidenceBps) || confidenceBps < 0 || confidenceBps > 10000) {
    throw new Error("confidenceBps must be a number between 0 and 10000.");
  }
  if (evidenceHash != null && (typeof evidenceHash !== "string" || evidenceHash.length > MAX_EVIDENCE_HASH_LEN)) {
    throw new Error("evidenceHash must be a short string if provided.");
  }
  return {
    indicator: clean,
    category: categoryToIndex(category),
    confidenceBps: Math.round(confidenceBps),
    evidenceHash: evidenceHash || null,
  };
}

export function validateSecurityEventInput({ identityId, surface, eventType, destination, decision, reason, confidenceBps, category }) {
  if (!identityId || typeof identityId !== "string" || identityId.length > MAX_IDENTITY_LEN) {
    throw new Error("identityId is required.");
  }
  if (!SECURITY_EVENT_TYPES.includes(eventType)) {
    throw new Error(`eventType must be one of: ${SECURITY_EVENT_TYPES.join(", ")}`);
  }
  if (destination != null && (typeof destination !== "string" || destination.length > MAX_DESTINATION_LEN)) {
    throw new Error("destination is too long.");
  }
  if (reason != null && (typeof reason !== "string" || reason.length > MAX_REASON_LEN)) {
    throw new Error("reason is too long.");
  }
  return {
    identityId: identityId.trim(),
    surface: typeof surface === "string" ? surface.slice(0, 40) : "unknown",
    eventType,
    destination: destination || null,
    decision: decision || eventType,
    reason: reason || null,
    confidenceBps: typeof confidenceBps === "number" ? Math.round(confidenceBps) : null,
    category: category != null ? categoryToIndex(category) : null,
  };
}

// ============================================================
// On-chain relayer calls -- every one of these is best-effort: a Mongo
// write always happens regardless of chain outcome, and a missing
// relayer/contract-address config degrades to "skipped" rather than
// throwing, so local dev and test/security.test.mjs work before the
// contracts are ever deployed.
// ============================================================

async function confirmThreatOnChain({ threatId, category, confidenceBps, contributingNodesHash }) {
  const relayer = getRelayerWallet();
  if (!relayer || !THREAT_REPORTER_ADDRESS) {
    console.warn("security.js: on-chain confirmThreat skipped — relayer or THREAT_REPORTER_ADDRESS not configured");
    return { attempted: false, success: false, txHash: null };
  }
  try {
    const reporter = new ethers.Contract(THREAT_REPORTER_ADDRESS, REPORTER_ABI, relayer);
    const tx = await reporter.confirmThreat(threatId, category, confidenceBps, contributingNodesHash || ethers.ZeroHash);
    const receipt = await tx.wait();
    return { attempted: true, success: true, txHash: receipt.hash };
  } catch (err) {
    console.error("security.js: on-chain confirmThreat failed:", err);
    return { attempted: true, success: false, txHash: null, error: err.message };
  }
}

async function setThreatStatusOnChain({ threatId, status, confidenceBps, contributingNodesHash }) {
  const relayer = getRelayerWallet();
  if (!relayer || !THREAT_REPORTER_ADDRESS) {
    console.warn("security.js: on-chain setThreatStatus skipped — relayer or THREAT_REPORTER_ADDRESS not configured");
    return { attempted: false, success: false, txHash: null };
  }
  try {
    const reporter = new ethers.Contract(THREAT_REPORTER_ADDRESS, REPORTER_ABI, relayer);
    const tx = await reporter.setThreatStatus(threatId, status, confidenceBps, contributingNodesHash || ethers.ZeroHash);
    const receipt = await tx.wait();
    return { attempted: true, success: true, txHash: receipt.hash };
  } catch (err) {
    console.error("security.js: on-chain setThreatStatus failed:", err);
    return { attempted: true, success: false, txHash: null, error: err.message };
  }
}

/** Real-time off-chain reputation update -- moves a node's score toward 100% as its reports lead
 *  to confirmed threats, gets pulled down hard by false positives (3x weight, deliberately
 *  asymmetric: being wrong once should cost more than being right once earns — SOW §19's
 *  "reputation decay" / anti-abuse intent). The on-chain checkpoint happens separately and
 *  periodically, not per-call — see checkpointDirtyReputations(). */
async function bumpNodeReputation(node, { confirmedDelta = 0, falsePositiveDelta = 0 }) {
  const { reputationCache } = await getSecurityCollections();
  const existing = await reputationCache.findOne({ _id: node });
  const totalConfirmed = (existing?.totalConfirmed || 0) + confirmedDelta;
  const totalFalsePositive = (existing?.totalFalsePositive || 0) + falsePositiveDelta;
  const weightedTotal = totalConfirmed + totalFalsePositive * 3;
  const scoreBps = weightedTotal === 0 ? DEFAULT_REPUTATION_BPS : Math.round((totalConfirmed / weightedTotal) * 10000);

  await reputationCache.updateOne(
    { _id: node },
    {
      $set: { scoreBps, totalConfirmed, totalFalsePositive, updatedAt: new Date(), dirty: true },
      $setOnInsert: { checkpointedTotalConfirmed: 0, checkpointedTotalFalsePositive: 0, checkpointedAt: null },
    },
    { upsert: true }
  );
}

// ============================================================
// Core report + confidence-aggregation flow
// ============================================================

/** Verifies the signature, rate-limits the reporting node, upserts the observation (deduped per
 *  node+threat+day, same idiom as activity.js), and re-runs confidence aggregation for the
 *  threat. Throws on any rejection — the route translates that into an HTTP 4xx. */
export async function recordSecurityReport(input) {
  verifySecurityReportAuth(input);
  const clean = validateSecurityReportInput(input);
  const nodeAddress = normalizeWallet(input.nodeAddress);
  const { reports, threats } = await getSecurityCollections();

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentCount = await reports.countDocuments({ nodeAddress, createdAt: { $gte: since } });
  if (recentCount >= MAX_REPORTS_PER_NODE_PER_DAY) {
    throw new Error("Rate limit exceeded — too many reports from this node in the last 24 hours.");
  }

  const threatId = computeThreatId(clean.indicator);
  const date = new Date().toISOString().slice(0, 10);

  await reports.updateOne(
    { nodeAddress, threatId, date },
    {
      $setOnInsert: {
        nodeAddress,
        threatId,
        indicator: clean.indicator,
        category: clean.category,
        confidenceBps: clean.confidenceBps,
        evidenceHash: clean.evidenceHash,
        date,
        createdAt: new Date(),
      },
    },
    { upsert: true }
  );

  await threats.updateOne(
    { _id: threatId },
    {
      $setOnInsert: {
        _id: threatId,
        indicator: clean.indicator,
        category: clean.category,
        status: SECURITY_STATUS.UNVERIFIED,
        confidenceBps: 0,
        contributingNodes: [],
        contributingNodesHash: null,
        firstSeen: new Date(),
        onChainConfirmedAt: null,
        onChainTxHash: null,
      },
      $set: { lastUpdated: new Date() },
    },
    { upsert: true }
  );

  return computeThreatConfidence(threatId);
}

/** Reputation-weighted aggregation over every independent node that reported this threatId
 *  within REPORT_LOOKBACK_MS. Crossing CONFIRM_THRESHOLD_BPS triggers the on-chain confirmThreat
 *  relayer call exactly once (on the transition into CONFIRMED, not on every subsequent report). */
export async function computeThreatConfidence(threatId) {
  const { reports, threats, reputationCache } = await getSecurityCollections();
  const since = new Date(Date.now() - REPORT_LOOKBACK_MS);
  const recentReports = await reports.find({ threatId, createdAt: { $gte: since } }).toArray();
  const independentNodes = [...new Set(recentReports.map((r) => r.nodeAddress))];

  const threat = await threats.findOne({ _id: threatId });
  if (!threat) return null;

  if (independentNodes.length < MIN_INDEPENDENT_REPORTERS) {
    await threats.updateOne(
      { _id: threatId },
      { $set: { confidenceBps: 0, contributingNodes: independentNodes, lastUpdated: new Date() } }
    );
    return { threatId, confidenceBps: 0, status: threat.status, contributingNodes: independentNodes, confirmed: false };
  }

  const repDocs = await reputationCache.find({ _id: { $in: independentNodes } }).toArray();
  const repByNode = new Map(repDocs.map((d) => [d._id, d.scoreBps]));
  const avgScore = independentNodes.reduce((sum, n) => sum + (repByNode.get(n) ?? DEFAULT_REPUTATION_BPS), 0) / independentNodes.length;
  // Extra independent reporters beyond the minimum add confidence too, up to a capped bonus --
  // 4 agreeing nodes should be more convincing than 3, even at the same average reputation.
  const bonus = Math.min(1500, (independentNodes.length - MIN_INDEPENDENT_REPORTERS) * 200);
  const confidenceBps = Math.min(10000, Math.round(avgScore + bonus));

  const wasAlreadyConfirmed = threat.status === SECURITY_STATUS.CONFIRMED;
  const willConfirm = confidenceBps >= CONFIRM_THRESHOLD_BPS;

  const sortedNodes = [...independentNodes].sort();
  const contributingNodesHash = willConfirm
    ? ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address[]"], [sortedNodes]))
    : threat.contributingNodesHash || null;

  const update = { confidenceBps, contributingNodes: independentNodes, lastUpdated: new Date() };
  if (willConfirm) {
    update.status = SECURITY_STATUS.CONFIRMED;
    update.contributingNodesHash = contributingNodesHash;
  }
  await threats.updateOne({ _id: threatId }, { $set: update });

  let onChain = { attempted: false, success: false, txHash: null };
  if (willConfirm && !wasAlreadyConfirmed) {
    onChain = await confirmThreatOnChain({ threatId, category: threat.category, confidenceBps, contributingNodesHash });
    if (onChain.success) {
      await threats.updateOne({ _id: threatId }, { $set: { onChainConfirmedAt: new Date(), onChainTxHash: onChain.txHash } });
    }
    await Promise.all(independentNodes.map((node) => bumpNodeReputation(node, { confirmedDelta: 1 })));
  }

  return {
    threatId,
    confidenceBps,
    status: willConfirm ? SECURITY_STATUS.CONFIRMED : threat.status,
    contributingNodes: independentNodes,
    confirmed: willConfirm,
    onChain,
  };
}

/** Periodic (cron-triggered) on-chain reputation checkpoint — see
 *  src/app/api/security/cron/checkpoint-reputation/route.js. Sends only the DELTA since the
 *  last checkpoint (the contract's checkpointReputation increments, it doesn't overwrite), so
 *  this must track what was already checkpointed, not just the running total. */
export async function checkpointDirtyReputations() {
  const { reputationCache } = await getSecurityCollections();
  const dirty = await reputationCache.find({ dirty: true }).toArray();
  if (dirty.length === 0) return { checkpointed: 0, skipped: 0 };

  const relayer = getRelayerWallet();
  if (!relayer || !NODE_REPUTATION_ADDRESS) {
    console.warn("security.js: reputation checkpoint skipped — relayer or NODE_REPUTATION_ADDRESS not configured");
    return { checkpointed: 0, skipped: dirty.length };
  }

  const contract = new ethers.Contract(NODE_REPUTATION_ADDRESS, NODE_REPUTATION_ABI, relayer);
  let checkpointed = 0;
  for (const doc of dirty) {
    const confirmedDelta = doc.totalConfirmed - (doc.checkpointedTotalConfirmed || 0);
    const falsePositiveDelta = doc.totalFalsePositive - (doc.checkpointedTotalFalsePositive || 0);
    try {
      const tx = await contract.checkpointReputation(doc._id, doc.scoreBps, confirmedDelta, falsePositiveDelta);
      await tx.wait();
      await reputationCache.updateOne(
        { _id: doc._id },
        {
          $set: {
            dirty: false,
            checkpointedAt: new Date(),
            checkpointedTotalConfirmed: doc.totalConfirmed,
            checkpointedTotalFalsePositive: doc.totalFalsePositive,
          },
        }
      );
      checkpointed++;
    } catch (err) {
      console.error(`security.js: checkpoint failed for node ${doc._id}:`, err);
    }
  }
  return { checkpointed, skipped: dirty.length - checkpointed };
}

// ============================================================
// Reads
// ============================================================

export async function getThreatByIndicator(indicator) {
  const threatId = computeThreatId(indicator);
  const { threats } = await getSecurityCollections();
  const threat = await threats.findOne({ _id: threatId });
  if (!threat) {
    return { threatId, known: false, status: SECURITY_STATUS.UNVERIFIED, statusLabel: SECURITY_STATUS_LABELS[0], confidenceBps: 0, category: null };
  }
  return { ...threat, known: true, statusLabel: SECURITY_STATUS_LABELS[threat.status] };
}

export async function getReputationSnapshot(nodeAddress) {
  const wallet = normalizeWallet(nodeAddress);
  const { reputationCache } = await getSecurityCollections();
  const doc = await reputationCache.findOne({ _id: wallet });
  if (!doc) {
    return { nodeAddress: wallet, scoreBps: DEFAULT_REPUTATION_BPS, totalConfirmed: 0, totalFalsePositive: 0, checkpointed: false };
  }
  return {
    nodeAddress: wallet,
    scoreBps: doc.scoreBps,
    totalConfirmed: doc.totalConfirmed,
    totalFalsePositive: doc.totalFalsePositive,
    checkpointed: !!doc.checkpointedAt,
  };
}

/** Incremental sync feed for client threat caches — `sinceIso` is the client's last-synced
 *  timestamp; omitted, it returns every currently-CONFIRMED threat (a full first sync). */
export async function getSecurityFeed(sinceIso) {
  const { threats } = await getSecurityCollections();
  const filter = sinceIso ? { lastUpdated: { $gt: new Date(sinceIso) } } : { status: SECURITY_STATUS.CONFIRMED };
  const items = await threats.find(filter).sort({ lastUpdated: -1 }).limit(500).toArray();
  return { items, generatedAt: new Date().toISOString() };
}

/** Aggregate, public-safe network stats for the public transparency page (/security) — counts
 *  and an average only, never raw node addresses (those stay admin-only, see
 *  adminListNodeReputations). */
export async function getPublicSecurityStats() {
  const { threats, reputationCache } = await getSecurityCollections();
  const [confirmedThreatsCount, reportingNodesCount, repDocs] = await Promise.all([
    threats.countDocuments({ status: SECURITY_STATUS.CONFIRMED }),
    reputationCache.countDocuments({}),
    reputationCache.find({}, { projection: { scoreBps: 1 } }).toArray(),
  ]);
  const avgReputationBps = repDocs.length
    ? Math.round(repDocs.reduce((sum, d) => sum + (d.scoreBps || 0), 0) / repDocs.length)
    : null;
  return { confirmedThreatsCount, reportingNodesCount, avgReputationBps };
}

export async function recordSecurityEvent(input) {
  const clean = validateSecurityEventInput(input);
  const { events } = await getSecurityCollections();
  const doc = { ...clean, createdAt: new Date() };
  const { insertedId } = await events.insertOne(doc);
  return { ...doc, _id: insertedId };
}

export async function getRecentSecurityEvents(identityId, limit = 20) {
  const { events } = await getSecurityCollections();
  return events.find({ identityId }).sort({ createdAt: -1 }).limit(Math.min(limit, 100)).toArray();
}

// ============================================================
// Policy — starts as a versioned Mongo doc (same pragmatic "config, not a
// rule-builder UI" pattern as learnConfig.js), backend-signed so a client
// can verify it offline once cached (SOW §10) without a live RPC call.
// ============================================================

export async function getCurrentPolicy() {
  const { policy } = await getSecurityCollections();
  const doc = await policy.findOne({ _id: "current" });
  if (!doc) return null; // only possible before ensureSecurityIndexes() has ever run
  const relayer = getRelayerWallet();
  const signature = relayer ? await relayer.signMessage(ethers.getBytes(doc.hash)) : null;
  return {
    version: doc.version,
    content: doc.content,
    hash: doc.hash,
    signature,
    relayerAddress: relayer?.address || null,
    publishedAt: doc.publishedAt,
  };
}

/** Bumps the version by exactly 1 both in Mongo and on-chain, matching
 *  InayaSecurityPolicy.sol's "must increment by exactly 1" invariant — the two counters start in
 *  lockstep (both 0 pre-launch) precisely because the initial seed in ensureSecurityIndexes()
 *  never calls on-chain publishPolicy itself. */
export async function publishPolicy(newContent) {
  const { policy } = await getSecurityCollections();
  const current = await policy.findOne({ _id: "current" });
  const nextVersion = (current?.version || 0) + 1;
  const hash = hashPolicyContent(newContent);
  const publishedAt = new Date();

  await policy.updateOne(
    { _id: "current" },
    { $set: { version: nextVersion, content: newContent, hash, publishedAt } },
    { upsert: true }
  );

  let onChain = { attempted: false, success: false, txHash: null };
  const relayer = getRelayerWallet();
  if (relayer && SECURITY_POLICY_ADDRESS) {
    try {
      const contract = new ethers.Contract(SECURITY_POLICY_ADDRESS, SECURITY_POLICY_ABI, relayer);
      const tx = await contract.publishPolicy(nextVersion, hash, "backend:/api/security/policy");
      const receipt = await tx.wait();
      onChain = { attempted: true, success: true, txHash: receipt.hash };
    } catch (err) {
      console.error("security.js: on-chain publishPolicy failed:", err);
      onChain = { attempted: true, success: false, txHash: null, error: err.message };
    }
  } else {
    console.warn("security.js: on-chain policy publish skipped — relayer or SECURITY_POLICY_ADDRESS not configured");
  }

  return { version: nextVersion, hash, publishedAt, onChain };
}

// ============================================================
// Admin
// ============================================================

export async function adminListThreats({ status } = {}) {
  const { threats } = await getSecurityCollections();
  const filter = status != null ? { status } : {};
  return threats.find(filter).sort({ lastUpdated: -1 }).limit(500).toArray();
}

export async function adminListNodeReputations() {
  const { reputationCache } = await getSecurityCollections();
  return reputationCache.find({}).sort({ scoreBps: -1 }).limit(500).toArray();
}

/** Manual quarantine/dismiss override (SOW §19's "administrative/governance controls" anti-abuse
 *  requirement) — still routes through the relayer-gated on-chain setThreatStatus, so an admin
 *  override is exactly as auditable as an automatic confirmation, not a silent side-channel. */
export async function adminOverrideThreatStatus(threatId, status, confidenceBps = 0) {
  const { threats } = await getSecurityCollections();
  const threat = await threats.findOne({ _id: threatId });
  if (!threat) throw new Error("Unknown threat.");

  await threats.updateOne({ _id: threatId }, { $set: { status, confidenceBps, lastUpdated: new Date() } });

  // A threat an admin is confirming may never have crossed the algorithmic threshold, which
  // means it was never registered on-chain either -- InayaThreatReporter.setThreatStatus()
  // requires an existing on-chain record and reverts "Unknown threat" otherwise (caught live
  // during manual verification of this exact path). confirmThreatOnChain registers-if-new
  // before setting CONFIRMED, so it's the correct call for a CONFIRMED override; setThreatStatus
  // remains correct for DISPUTED/CLEARED, which only ever apply to an already-confirmed threat.
  const onChain =
    status === SECURITY_STATUS.CONFIRMED
      ? await confirmThreatOnChain({ threatId, category: threat.category, confidenceBps, contributingNodesHash: threat.contributingNodesHash })
      : await setThreatStatusOnChain({ threatId, status, confidenceBps, contributingNodesHash: threat.contributingNodesHash });

  if (onChain.success) {
    await threats.updateOne({ _id: threatId }, { $set: { onChainConfirmedAt: new Date(), onChainTxHash: onChain.txHash } });
  }

  return { threatId, status, confidenceBps, onChain };
}
