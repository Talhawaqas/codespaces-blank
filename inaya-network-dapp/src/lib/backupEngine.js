// src/lib/backupEngine.js
//
// Backup & Recovery Mechanism (docs/backup-redundancy-architecture.md) -- shared logic behind
// every /api/backup/* route. Keeps the route files themselves thin (matching this codebase's
// existing convention, e.g. api/nodes/heartbeat's route.js is a thin wrapper around
// nodeReputation.js's pure scoring function). MongoDB access mirrors api/nodes/heartbeat/
// route.js's own pattern exactly (clientPromise -> client.db('inaya_network')).
//
// Two Mongo collections:
//   backup_replicas: one doc per (fileHash, shardId, provider) -- provider, cid, providerRef
//     (what fetchReplica/getPinStatus actually need -- see pinningProviders/*.js), contentHash
//     (captured at pin time, the integrity check recovery uses), consecutiveFailures,
//     lastCheckOk, corrupted, pinnedAt, lastCheckedAt.
//   backup_state: one doc per fileHash -- cached healthState, lastStateChangeAt, whether a
//     rebuild is in-flight per shard, and whether the asset has been registered on InayaBackupRegistry
//     yet (registration + state-transition writes happen here, on a cron boundary, never inline
//     during upload -- see the architecture doc's storage-efficiency section).

import clientPromise from "./mongodb.js";
import { ethers } from "ethers";
import { getProvider, listAvailableProviders, sha256Hex } from "./pinningProviders/index.js";
import { computeAssetHealthState, needsRecovery, HEALTH_STATES, CONSECUTIVE_FAILURE_THRESHOLD } from "./backupHealth.js";

const DB_NAME = "inaya_network";
const SHARD_IDS = ["alpha", "beta"];

export function getTargetReplicaCount() {
  return Number(process.env.BACKUP_TARGET_REPLICA_COUNT || 2);
}

async function getCollections() {
  const client = await clientPromise;
  const db = client.db(DB_NAME);
  return { replicas: db.collection("backup_replicas"), state: db.collection("backup_state") };
}

// ------------------------------------------------------------------
// On-chain sync -- InayaBackupRegistry, called only at state-machine boundary
// crossings (never on every routine poll). Same Path-A backend-operator-key
// pattern every other onlyOwner contract call in this codebase already uses
// (e.g. scripts/wire-*-spoke.mjs's DEPLOYER_PRIVATE_KEY-signed calls).
// ------------------------------------------------------------------

const BACKUP_REGISTRY_ABI = [
  "function registerRedundancyCommitment(bytes32 fileHash, uint8 targetReplicaCount, bytes32 replicaSetHash) external",
  "function updateRedundancyCommitment(bytes32 fileHash, uint8 targetReplicaCount, bytes32 replicaSetHash) external",
  "function setBackupHealthState(bytes32 fileHash, uint8 newState) external",
  "function getBackupRecord(bytes32 fileHash) external view returns (tuple(address owner, uint8 targetReplicaCount, bytes32 replicaSetHash, uint8 healthState, uint256 registeredAt, uint256 lastStateChangeAt))",
];

const HEALTH_STATE_ENUM = {
  [HEALTH_STATES.PROTECTED]: 0,
  [HEALTH_STATES.REBUILDING]: 1,
  [HEALTH_STATES.DEGRADED]: 2,
  [HEALTH_STATES.RECOVERY_REQUIRED]: 3,
  [HEALTH_STATES.RECOVERY_FAILED]: 4,
};

function getBackupRegistryContract() {
  const address = process.env.NEXT_PUBLIC_BACKUP_REGISTRY_ADDRESS;
  const rpcUrl = process.env.BSC_TESTNET_RPC;
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!address || !rpcUrl || !privateKey) return null; // not deployed/configured yet -- callers treat on-chain sync as best-effort
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  return new ethers.Contract(address, BACKUP_REGISTRY_ABI, wallet);
}

/** Hashes the current replica topology (provider + providerRef per replica, sorted for
 *  determinism) -- what actually goes on-chain is this hash, never the topology itself, per the
 *  SOW's "no large backup data on-chain" scope limit and InayaBackupRegistry.sol's own doc comment. */
function computeReplicaSetHash(allReplicas) {
  const sorted = [...allReplicas]
    .map((r) => `${r.shardId}:${r.provider}:${r.providerRef}`)
    .sort();
  return ethers.id(sorted.join("|"));
}

/** Best-effort on-chain sync -- registers the commitment on first Protected state, updates the
 *  topology hash whenever it changes, and writes a health-state transition. Never throws: a
 *  failed on-chain write degrades to "off-chain state is authoritative, on-chain is stale until
 *  the next cron pass retries" rather than blocking the off-chain recovery pipeline that actually
 *  protects user data. Returns the tx hash on success, null otherwise. */
async function syncOnChain({ fileHash, allReplicas, healthState, alreadyRegistered }) {
  const contract = getBackupRegistryContract();
  if (!contract) return null;

  const replicaSetHash = computeReplicaSetHash(allReplicas);
  const target = getTargetReplicaCount();

  try {
    if (!alreadyRegistered) {
      const tx = await contract.registerRedundancyCommitment(fileHash, target, replicaSetHash);
      await tx.wait();
      return tx.hash;
    }
    const tx = await contract.updateRedundancyCommitment(fileHash, target, replicaSetHash);
    await tx.wait();
    const tx2 = await contract.setBackupHealthState(fileHash, HEALTH_STATE_ENUM[healthState]);
    await tx2.wait();
    return tx2.hash;
  } catch (err) {
    console.error(`backupEngine: on-chain sync failed for ${fileHash}:`, err.message);
    return null;
  }
}

// ------------------------------------------------------------------
// Replica recording + status
// ------------------------------------------------------------------

async function recordReplica({ fileHash, shardId, provider, cid, providerRef, contentHash }) {
  const { replicas } = await getCollections();
  await replicas.updateOne(
    { fileHash, shardId, provider },
    {
      $set: {
        fileHash, shardId, provider, cid, providerRef, contentHash,
        lastCheckedAt: new Date(), lastCheckOk: true, consecutiveFailures: 0, corrupted: false,
      },
      $setOnInsert: { pinnedAt: new Date() },
    },
    { upsert: true }
  );
}

async function loadShardReplicaDocs(fileHash, shardId) {
  const { replicas } = await getCollections();
  return replicas.find({ fileHash, shardId }).toArray();
}

function docToHealthInput(doc) {
  return { consecutiveFailures: doc.consecutiveFailures || 0, corrupted: !!doc.corrupted, lastCheckOk: doc.lastCheckOk !== false };
}

/** Recomputes the asset's health state from current replica docs and upserts backup_state --
 *  called after any replica-status-changing event (new pin, Tier-1/Tier-2 check, recovery). Only
 *  syncs on-chain if the computed state differs from what's cached (a real boundary crossing). */
async function recomputeAndSyncState(fileHash) {
  const { state } = await getCollections();
  const target = getTargetReplicaCount();

  const [alphaDocs, betaDocs] = await Promise.all([loadShardReplicaDocs(fileHash, "alpha"), loadShardReplicaDocs(fileHash, "beta")]);
  const stateDoc = await state.findOne({ fileHash });
  const rebuildInFlight = stateDoc?.rebuildInFlight || {};

  const healthState = computeAssetHealthState({
    shardAlpha: { replicas: alphaDocs.map(docToHealthInput), rebuildInFlight: !!rebuildInFlight.alpha },
    shardBeta: { replicas: betaDocs.map(docToHealthInput), rebuildInFlight: !!rebuildInFlight.beta },
    targetReplicaCount: target,
  });

  const previousHealthState = stateDoc?.healthState || null;
  const isBoundaryCrossing = previousHealthState !== healthState;

  let onChainTx = stateDoc?.lastOnChainTx || null;
  if (isBoundaryCrossing) {
    onChainTx = await syncOnChain({
      fileHash,
      allReplicas: [...alphaDocs, ...betaDocs],
      healthState,
      alreadyRegistered: !!stateDoc?.registeredOnChain,
    });
  }

  await state.updateOne(
    { fileHash },
    {
      $set: {
        fileHash,
        healthState,
        targetReplicaCount: target,
        ...(isBoundaryCrossing ? { lastStateChangeAt: new Date() } : {}),
        ...(onChainTx ? { lastOnChainTx: onChainTx, registeredOnChain: true } : {}),
      },
      $setOnInsert: { firstSeenAt: new Date() },
    },
    { upsert: true }
  );

  return healthState;
}

// ------------------------------------------------------------------
// Public API -- called by the /api/backup/* routes
// ------------------------------------------------------------------

/** Called right after a shard's primary provider pin succeeds (api/upload/route.js). Records the
 *  primary replica, then fans out to every OTHER configured provider (today: just Filebase, once
 *  credentials exist). Best-effort per secondary provider -- one failing doesn't roll back the
 *  primary pin or block the upload response; the check-pins cron is the safety net that notices
 *  and retries via the recovery workflow. */
export async function replicateShard({ fileHash, shardId, content, primaryProvider, primaryCid }) {
  if (!SHARD_IDS.includes(shardId)) throw new Error(`backupEngine.replicateShard: shardId must be one of ${SHARD_IDS.join("/")}, got "${shardId}"`);

  await recordReplica({ fileHash, shardId, provider: primaryProvider, cid: primaryCid, providerRef: primaryCid, contentHash: sha256Hex(content) });

  const results = [{ provider: primaryProvider, cid: primaryCid, status: "primary" }];
  const secondaryProviders = listAvailableProviders().filter((p) => p !== primaryProvider);

  for (const providerName of secondaryProviders) {
    try {
      const adapter = getProvider(providerName);
      const pinResult = await adapter.pin(content, { name: `${fileHash}_${shardId}` });
      await recordReplica({ fileHash, shardId, provider: pinResult.provider, cid: pinResult.cid, providerRef: pinResult.providerRef, contentHash: pinResult.contentHash });
      results.push({ provider: providerName, cid: pinResult.cid, status: "replicated" });
    } catch (err) {
      results.push({ provider: providerName, status: "failed", error: err.message });
    }
  }

  const healthState = await recomputeAndSyncState(fileHash);
  return { fileHash, shardId, replicas: results, healthState };
}

/** Full status detail for one asset -- backs getBackupStatus/getRedundancyStatus. */
export async function getBackupStatus(fileHash) {
  const { state } = await getCollections();
  const target = getTargetReplicaCount();

  const [alphaDocs, betaDocs, stateDoc] = await Promise.all([
    loadShardReplicaDocs(fileHash, "alpha"),
    loadShardReplicaDocs(fileHash, "beta"),
    state.findOne({ fileHash }),
  ]);

  const summarizeShard = (docs) => ({
    replicaCount: docs.length,
    targetReplicaCount: target,
    replicas: docs.map((d) => ({ provider: d.provider, cid: d.cid, corrupted: !!d.corrupted, consecutiveFailures: d.consecutiveFailures || 0, lastCheckedAt: d.lastCheckedAt })),
  });

  return {
    fileHash,
    targetReplicaCount: target,
    healthState: stateDoc?.healthState || HEALTH_STATES.RECOVERY_FAILED,
    lastStateChangeAt: stateDoc?.lastStateChangeAt || null,
    shardAlpha: summarizeShard(alphaDocs),
    shardBeta: summarizeShard(betaDocs),
  };
}

// ------------------------------------------------------------------
// Tier 1 -- pin-status check (cheap, frequent)
// ------------------------------------------------------------------

/** Checks every recorded replica's pin status with its provider. A miss increments
 *  consecutiveFailures (grace, per backupHealth.js's threshold) rather than immediately failing.
 *  A successful check resets consecutiveFailures to 0. After sweeping all replicas for an asset,
 *  recomputes and syncs its state. Returns a summary for the cron's response body. */
export async function runCheckPinsSweep({ limit = 200 } = {}) {
  const { replicas } = await getCollections();
  const docs = await replicas.find({}).limit(limit).toArray();
  const affectedFileHashes = new Set();
  let checked = 0, missed = 0;

  for (const doc of docs) {
    checked += 1;
    let ok;
    try {
      const adapter = getProvider(doc.provider);
      ok = await adapter.getPinStatus(doc.providerRef);
    } catch (err) {
      ok = false; // a transient API error is treated the same as a miss -- grace via consecutiveFailures either way
    }

    if (!ok) missed += 1;
    await replicas.updateOne(
      { _id: doc._id },
      ok
        ? { $set: { lastCheckedAt: new Date(), lastCheckOk: true, consecutiveFailures: 0 } }
        : { $set: { lastCheckedAt: new Date(), lastCheckOk: false }, $inc: { consecutiveFailures: 1 } }
    );
    affectedFileHashes.add(doc.fileHash);
  }

  const stateChanges = [];
  for (const fileHash of affectedFileHashes) {
    const healthState = await recomputeAndSyncState(fileHash);
    stateChanges.push({ fileHash, healthState });
  }

  return { checked, missed, assetsAffected: stateChanges.length, stateChanges };
}

// ------------------------------------------------------------------
// Tier 2 -- content-integrity check (expensive, batched/rotated)
// ------------------------------------------------------------------

/** Actually fetches replica bytes and compares against the contentHash captured at pin time.
 *  Rotated: only checks replicas whose lastIntegrityCheckAt is oldest/missing, bounded by `limit`
 *  per run, so a large asset base isn't fully re-fetched every single day (storage-efficiency
 *  requirement, applied to bandwidth/read cost here). A mismatch is real corruption -- never
 *  given grace, flips `corrupted: true` immediately. */
export async function runVerifyIntegritySweep({ limit = 25 } = {}) {
  const { replicas } = await getCollections();
  const docs = await replicas
    .find({})
    .sort({ lastIntegrityCheckAt: 1 })
    .limit(limit)
    .toArray();

  const affectedFileHashes = new Set();
  let checked = 0, corrupted = 0;

  for (const doc of docs) {
    checked += 1;
    let matches = false;
    try {
      const adapter = getProvider(doc.provider);
      const content = await adapter.fetchReplica(doc.providerRef);
      matches = sha256Hex(content) === doc.contentHash;
    } catch {
      matches = true; // a fetch failure is a Tier-1 concern (availability), not evidence of corruption -- don't flag content as bad on a network error
    }

    await replicas.updateOne({ _id: doc._id }, { $set: { lastIntegrityCheckAt: new Date(), corrupted: !matches } });
    if (!matches) corrupted += 1;
    affectedFileHashes.add(doc.fileHash);
  }

  const stateChanges = [];
  for (const fileHash of affectedFileHashes) {
    const healthState = await recomputeAndSyncState(fileHash);
    stateChanges.push({ fileHash, healthState });
  }

  return { checked, corrupted, assetsAffected: stateChanges.length, stateChanges };
}

// ------------------------------------------------------------------
// Recovery workflow
// ------------------------------------------------------------------

async function markRebuildInFlight(fileHash, shardId, inFlight) {
  const { state } = await getCollections();
  await state.updateOne({ fileHash }, { $set: { [`rebuildInFlight.${shardId}`]: inFlight } }, { upsert: true });
}

/** Recovers one shard of one asset: finds a currently-healthy replica of that SAME shard as the
 *  source, re-fetches it, verifies its content hash against what was captured at original pin
 *  time (never trusting the fetch alone -- rejects and leaves the shard in Recovery Required if
 *  the hash doesn't match), then re-pins to whichever configured provider doesn't already have a
 *  healthy replica of this shard, restoring the target replica count. */
async function recoverShard(fileHash, shardId) {
  await markRebuildInFlight(fileHash, shardId, true);
  try {
    const { replicas } = await getCollections();
    const docs = await loadShardReplicaDocs(fileHash, shardId);

    const source = docs.find((d) => !d.corrupted && (d.consecutiveFailures || 0) === 0);
    if (!source) return { shardId, status: "no-healthy-source" };

    const sourceAdapter = getProvider(source.provider);
    const content = await sourceAdapter.fetchReplica(source.providerRef);
    if (sha256Hex(content) !== source.contentHash) {
      return { shardId, status: "source-integrity-mismatch" }; // reject -- do not propagate bad data
    }

    const healthyProviders = new Set(docs.filter((d) => !d.corrupted && (d.consecutiveFailures || 0) === 0).map((d) => d.provider));
    const targetProviderName = listAvailableProviders().find((p) => !healthyProviders.has(p));
    if (!targetProviderName) return { shardId, status: "no-target-provider-available" };

    const targetAdapter = getProvider(targetProviderName);
    const pinResult = await targetAdapter.pin(content, { name: `${fileHash}_${shardId}_recovered_${Date.now()}` });
    await recordReplica({ fileHash, shardId, provider: pinResult.provider, cid: pinResult.cid, providerRef: pinResult.providerRef, contentHash: pinResult.contentHash });

    // Drop the failed/corrupted replica record for this provider so it stops being counted --
    // it will be re-created fresh next time that provider is chosen as a recovery target.
    await replicas.deleteMany({
      fileHash, shardId,
      $or: [{ corrupted: true }, { consecutiveFailures: { $gte: CONSECUTIVE_FAILURE_THRESHOLD } }],
    });

    return { shardId, status: "recovered", provider: targetProviderName, cid: pinResult.cid };
  } finally {
    await markRebuildInFlight(fileHash, shardId, false);
  }
}

/** Recovery sweep: finds every asset whose cached state is Recovery Required and attempts to
 *  recover whichever shard(s) triggered it. Safe to run frequently -- recoverShard is a no-op
 *  (returns "no-healthy-source") if there's nothing to do. */
export async function runRecoverySweep({ limit = 50 } = {}) {
  const { state } = await getCollections();
  const candidates = await state.find({ healthState: HEALTH_STATES.RECOVERY_REQUIRED }).limit(limit).toArray();

  const results = [];
  for (const doc of candidates) {
    for (const shardId of SHARD_IDS) {
      const shardDocs = await loadShardReplicaDocs(doc.fileHash, shardId);
      const shardHealth = computeAssetHealthState({
        shardAlpha: shardId === "alpha" ? { replicas: shardDocs.map(docToHealthInput), rebuildInFlight: false } : { replicas: [], rebuildInFlight: false },
        shardBeta: shardId === "beta" ? { replicas: shardDocs.map(docToHealthInput), rebuildInFlight: false } : { replicas: [], rebuildInFlight: false },
        targetReplicaCount: getTargetReplicaCount(),
      });
      if (!needsRecovery(shardHealth) && shardHealth !== HEALTH_STATES.RECOVERY_FAILED) continue;

      const result = await recoverShard(doc.fileHash, shardId);
      results.push({ fileHash: doc.fileHash, ...result });
    }
    await recomputeAndSyncState(doc.fileHash);
  }

  return { assetsChecked: candidates.length, results };
}

/** User-requested recovery -- api/backup/recover's authenticated POST calls this after verifying
 *  the caller's signature and on-chain ownership. Just forces an immediate recovery sweep for
 *  this one asset rather than waiting for the next cron pass. */
export async function requestRecoveryFor(fileHash) {
  for (const shardId of SHARD_IDS) {
    const shardDocs = await loadShardReplicaDocs(fileHash, shardId);
    const healthy = shardDocs.filter((d) => !d.corrupted && (d.consecutiveFailures || 0) === 0).length;
    if (healthy < getTargetReplicaCount()) await recoverShard(fileHash, shardId);
  }
  return recomputeAndSyncState(fileHash);
}

export async function getRecoveryStatus(fileHash) {
  const { state } = await getCollections();
  const doc = await state.findOne({ fileHash });
  return {
    fileHash,
    healthState: doc?.healthState || HEALTH_STATES.RECOVERY_FAILED,
    rebuildInFlight: doc?.rebuildInFlight || { alpha: false, beta: false },
    lastStateChangeAt: doc?.lastStateChangeAt || null,
  };
}
