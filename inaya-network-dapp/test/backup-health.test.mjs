// test/backup-health.test.mjs
//
// Backup & Recovery Mechanism (docs/backup-redundancy-architecture.md) coverage for the pure
// state-machine functions -- no DB needed, deterministic classification over synthetic replica
// inputs. Same shape as test/node-reputation.test.mjs.
//
// Run with: node --test test/backup-health.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyReplicaStatus,
  countHealthyReplicas,
  computeShardHealthState,
  combineShardStates,
  computeAssetHealthState,
  needsRecovery,
  HEALTH_STATES,
  CONSECUTIVE_FAILURE_THRESHOLD,
} from "../src/lib/backupHealth.js";

function healthyReplica() {
  return { consecutiveFailures: 0, corrupted: false, lastCheckOk: true };
}
function waveringReplica(consecutiveFailures = 1) {
  return { consecutiveFailures, corrupted: false, lastCheckOk: false };
}
function unreachableReplica() {
  return { consecutiveFailures: CONSECUTIVE_FAILURE_THRESHOLD, corrupted: false, lastCheckOk: false };
}
function corruptedReplica() {
  return { consecutiveFailures: 0, corrupted: true, lastCheckOk: true };
}

test("classifyReplicaStatus: a clean replica is healthy", () => {
  assert.equal(classifyReplicaStatus(healthyReplica()), "healthy");
});

test("classifyReplicaStatus: a single miss under threshold is wavering, not unreachable (temporary blips get grace)", () => {
  assert.equal(classifyReplicaStatus(waveringReplica(1)), "wavering");
  assert.equal(classifyReplicaStatus(waveringReplica(CONSECUTIVE_FAILURE_THRESHOLD - 1)), "wavering");
});

test("classifyReplicaStatus: crossing CONSECUTIVE_FAILURE_THRESHOLD flips to unreachable", () => {
  assert.equal(classifyReplicaStatus(unreachableReplica()), "unreachable");
});

test("classifyReplicaStatus: a Tier-2 hash mismatch is 'failed' immediately, regardless of consecutiveFailures (no grace for real corruption)", () => {
  assert.equal(classifyReplicaStatus(corruptedReplica()), "failed");
  assert.equal(classifyReplicaStatus({ consecutiveFailures: 0, corrupted: true, lastCheckOk: true }), "failed");
});

test("countHealthyReplicas: counts healthy + wavering as retrievable, excludes unreachable/failed", () => {
  const replicas = [healthyReplica(), waveringReplica(), unreachableReplica(), corruptedReplica()];
  assert.equal(countHealthyReplicas(replicas), 2);
});

test("computeShardHealthState: Protected requires retrievable >= target AND every check clean", () => {
  const state = computeShardHealthState({ replicas: [healthyReplica(), healthyReplica()], targetReplicaCount: 2 });
  assert.equal(state, HEALTH_STATES.PROTECTED);
});

test("computeShardHealthState: a single wavering replica knocks Protected down to Degraded, even though it's still retrievable", () => {
  const state = computeShardHealthState({ replicas: [healthyReplica(), waveringReplica()], targetReplicaCount: 2 });
  assert.equal(state, HEALTH_STATES.DEGRADED);
});

test("computeShardHealthState: fewer replicas than target (never fully replicated), all clean -> Degraded, not Recovery Required (nothing has actually failed)", () => {
  const state = computeShardHealthState({ replicas: [healthyReplica()], targetReplicaCount: 2 });
  assert.equal(state, HEALTH_STATES.DEGRADED);
});

test("computeShardHealthState: a replica crossing the failure threshold, dropping retrievable below target -> Recovery Required", () => {
  const state = computeShardHealthState({ replicas: [healthyReplica(), unreachableReplica()], targetReplicaCount: 2 });
  assert.equal(state, HEALTH_STATES.RECOVERY_REQUIRED);
});

test("computeShardHealthState: a Tier-2 corrupted replica also triggers Recovery Required when it drops below target", () => {
  const state = computeShardHealthState({ replicas: [healthyReplica(), corruptedReplica()], targetReplicaCount: 2 });
  assert.equal(state, HEALTH_STATES.RECOVERY_REQUIRED);
});

test("computeShardHealthState: zero retrievable replicas -> Recovery Failed", () => {
  const state = computeShardHealthState({ replicas: [unreachableReplica(), corruptedReplica()], targetReplicaCount: 2 });
  assert.equal(state, HEALTH_STATES.RECOVERY_FAILED);
});

test("computeShardHealthState: Recovery Failed even with an empty replica list (nothing was ever pinned)", () => {
  const state = computeShardHealthState({ replicas: [], targetReplicaCount: 2 });
  assert.equal(state, HEALTH_STATES.RECOVERY_FAILED);
});

test("computeShardHealthState: rebuildInFlight always wins, overriding whatever the replica statuses would otherwise say", () => {
  const state = computeShardHealthState({
    replicas: [healthyReplica(), healthyReplica()],
    targetReplicaCount: 2,
    rebuildInFlight: true,
  });
  assert.equal(state, HEALTH_STATES.REBUILDING);
});

test("computeShardHealthState: rejects a target replica count below 1", () => {
  assert.throws(() => computeShardHealthState({ replicas: [], targetReplicaCount: 0 }), /targetReplicaCount/);
});

test("combineShardStates: worst-of-both -- a file is only as protected as its weaker shard", () => {
  assert.equal(combineShardStates([HEALTH_STATES.PROTECTED, HEALTH_STATES.PROTECTED]), HEALTH_STATES.PROTECTED);
  assert.equal(combineShardStates([HEALTH_STATES.PROTECTED, HEALTH_STATES.DEGRADED]), HEALTH_STATES.DEGRADED);
  assert.equal(combineShardStates([HEALTH_STATES.RECOVERY_FAILED, HEALTH_STATES.PROTECTED]), HEALTH_STATES.RECOVERY_FAILED);
  assert.equal(combineShardStates([HEALTH_STATES.DEGRADED, HEALTH_STATES.RECOVERY_REQUIRED]), HEALTH_STATES.RECOVERY_REQUIRED);
});

test("computeAssetHealthState: both shards fully protected -> Protected", () => {
  const shard = { replicas: [healthyReplica(), healthyReplica()], rebuildInFlight: false };
  const state = computeAssetHealthState({ shardAlpha: shard, shardBeta: shard, targetReplicaCount: 2 });
  assert.equal(state, HEALTH_STATES.PROTECTED);
});

test("computeAssetHealthState: only Beta has a failed replica -> asset-level Recovery Required (worst-of-both)", () => {
  const good = { replicas: [healthyReplica(), healthyReplica()], rebuildInFlight: false };
  const bad = { replicas: [healthyReplica(), unreachableReplica()], rebuildInFlight: false };
  const state = computeAssetHealthState({ shardAlpha: good, shardBeta: bad, targetReplicaCount: 2 });
  assert.equal(state, HEALTH_STATES.RECOVERY_REQUIRED);
});

test("computeAssetHealthState: both shards independently hit zero retrievable replicas -> Recovery Failed (matches the honest 2-of-2 limitation: losing either shard entirely loses the file)", () => {
  const dead = { replicas: [unreachableReplica()], rebuildInFlight: false };
  const state = computeAssetHealthState({ shardAlpha: dead, shardBeta: dead, targetReplicaCount: 2 });
  assert.equal(state, HEALTH_STATES.RECOVERY_FAILED);
});

test("needsRecovery: true only for Recovery Required, false for every other state including Recovery Failed (that needs manual intervention, not an automated retry)", () => {
  assert.equal(needsRecovery(HEALTH_STATES.RECOVERY_REQUIRED), true);
  for (const s of [HEALTH_STATES.PROTECTED, HEALTH_STATES.REBUILDING, HEALTH_STATES.DEGRADED, HEALTH_STATES.RECOVERY_FAILED]) {
    assert.equal(needsRecovery(s), false, `expected needsRecovery(${s}) to be false`);
  }
});
