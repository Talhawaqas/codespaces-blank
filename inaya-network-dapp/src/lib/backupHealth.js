// src/lib/backupHealth.js
//
// Backup & Recovery Mechanism (docs/backup-redundancy-architecture.md) -- pure state-machine
// functions computing the 5 backup-health states from real, already-observed replica data. Same
// shape as nodeReputation.js: deterministic math over inputs the caller already has, no I/O, no
// DB, so it's directly unit-testable (see test/backup-health.test.mjs) without mocking anything.
//
// MODEL: each shard (Alpha/Beta) has a target replica count R (configurable per-asset,
// BACKUP_TARGET_REPLICA_COUNT default) and a list of replicas, each independently checked by the
// Tier-1 pin-status cron (api/backup/cron/check-pins) and occasionally the Tier-2 content-hash
// cron (api/backup/cron/verify-integrity). A replica only flips to "unreachable" after
// CONSECUTIVE_FAILURE_THRESHOLD consecutive Tier-1 misses -- a single miss is a "wavering"
// replica: still counted as retrievable (redundancy-wise), but enough to knock the asset out of
// a clean "Protected" state, matching the SOW's requirement that a temporary interruption must
// not immediately trigger permanent recovery, while still being visible as thinner than fully
// healthy. A Tier-2 content-hash mismatch (real corruption) is never given grace -- it flips a
// replica straight to "failed."

export const CONSECUTIVE_FAILURE_THRESHOLD = 3;

export const HEALTH_STATES = {
  PROTECTED: "Protected",
  REBUILDING: "Rebuilding",
  DEGRADED: "Degraded",
  RECOVERY_REQUIRED: "RecoveryRequired",
  RECOVERY_FAILED: "RecoveryFailed",
};

const STATE_SEVERITY = {
  [HEALTH_STATES.PROTECTED]: 0,
  [HEALTH_STATES.REBUILDING]: 1,
  [HEALTH_STATES.DEGRADED]: 2,
  [HEALTH_STATES.RECOVERY_REQUIRED]: 3,
  [HEALTH_STATES.RECOVERY_FAILED]: 4,
};

/** One replica's per-check status, in [0,1] grace toward "unreachable": 'healthy' (clean),
 *  'wavering' (missed the latest check, but under CONSECUTIVE_FAILURE_THRESHOLD -- still
 *  retrievable), 'unreachable' (crossed the threshold), or 'failed' (Tier-2 hash mismatch,
 *  immediate, no grace regardless of consecutiveFailures). */
export function classifyReplicaStatus({ consecutiveFailures = 0, corrupted = false, lastCheckOk = true }) {
  if (corrupted) return "failed";
  if (consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) return "unreachable";
  if (lastCheckOk === false) return "wavering";
  return "healthy";
}

function isRetrievable(status) {
  return status === "healthy" || status === "wavering";
}

/** Count of a shard's replicas still considered retrievable right now (healthy + wavering). */
export function countHealthyReplicas(replicas) {
  return replicas.filter((r) => isRetrievable(classifyReplicaStatus(r))).length;
}

/** One shard's health state, given its replica list, target replica count, and whether a re-pin
 *  job is currently in-flight for it (Rebuilding always wins -- it's the freshest information,
 *  overriding what the stale pre-rebuild replica statuses would otherwise say). */
export function computeShardHealthState({ replicas, targetReplicaCount, rebuildInFlight = false }) {
  if (rebuildInFlight) return HEALTH_STATES.REBUILDING;
  if (!targetReplicaCount || targetReplicaCount < 1) {
    throw new Error("computeShardHealthState: targetReplicaCount must be >= 1.");
  }

  const statuses = replicas.map((r) => classifyReplicaStatus(r));
  const retrievableCount = statuses.filter(isRetrievable).length;
  const hasCrossedThreshold = statuses.some((s) => s === "unreachable" || s === "failed");
  const allChecksClean = statuses.every((s) => s === "healthy");

  if (retrievableCount === 0) return HEALTH_STATES.RECOVERY_FAILED;
  if (hasCrossedThreshold && retrievableCount < targetReplicaCount) return HEALTH_STATES.RECOVERY_REQUIRED;
  if (retrievableCount >= targetReplicaCount && allChecksClean) return HEALTH_STATES.PROTECTED;
  return HEALTH_STATES.DEGRADED;
}

/** Combines the two shards' independent states into one asset-level state -- worst-of-both,
 *  since a file is only as protected as its weaker shard (both are required to reconstruct it;
 *  see the architecture doc's honesty note on the underlying 2-of-2 bisection this doesn't change). */
export function combineShardStates(states) {
  return states.reduce((worst, s) => (STATE_SEVERITY[s] > STATE_SEVERITY[worst] ? s : worst), HEALTH_STATES.PROTECTED);
}

/** Convenience wrapper computing the full asset-level state directly from both shards' raw
 *  replica lists -- what api/backup/status and the check-pins/recover crons actually call. */
export function computeAssetHealthState({ shardAlpha, shardBeta, targetReplicaCount }) {
  const alphaState = computeShardHealthState({
    replicas: shardAlpha.replicas,
    targetReplicaCount,
    rebuildInFlight: shardAlpha.rebuildInFlight,
  });
  const betaState = computeShardHealthState({
    replicas: shardBeta.replicas,
    targetReplicaCount,
    rebuildInFlight: shardBeta.rebuildInFlight,
  });
  return combineShardStates([alphaState, betaState]);
}

/** True if `state` warrants queuing a recovery job (crossed a real failure, not just under-target). */
export function needsRecovery(state) {
  return state === HEALTH_STATES.RECOVERY_REQUIRED;
}
