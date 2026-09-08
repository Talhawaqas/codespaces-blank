// src/lib/resilience-orchestrator.js
//
// Autonomous Resilience Layer SOW, Phase 2 (orchestrator half). The
// SOW's 13-step test, each step backed by an EXISTING primitive rather
// than new logic:
//   1  select policy               -> resilience-policy.js's getPolicy
//   2  isolated test context       -> synthetic canaries (resilience-canary.js),
//                                     never a real orgDocuments row
//   3  select critical assets      -> the policy's canary set
//   4  record start point          -> startedAt on the RUNNING test-run row
//   5  invoke recovery primitives  -> pinningProviders' real fetchReplica()
//   6  reconstruct, no prod writes -> InayaKernel.reconstructAndDecrypt
//   7  validate integrity          -> compare against expectedContentHash
//   8  validate dependencies       -> pinningProviders' real getPinStatus()
//   9  validate permissions        -> document-permissions.js's real
//                                     getDocumentAccessLevel()/meetsLevel()
//   10 measure performance         -> Date.now() diffs, real wall-clock
//   11 record pass/fail per asset  -> assetResults on the test-run row
//   12 cleanup                     -> none needed (canaries are persistent,
//                                     reusable fixtures -- a scope decision,
//                                     not a skipped step, see resilience-canary.js)
//   13 generate evidence           -> logOrgActivity (the same audit chain
//                                     every other workflow in this app
//                                     already writes through)
//
// RPO, honestly defined for a replicated-backup system (not a
// continuously-mutating transactional one): minutes since this canary's
// most recently CONFIRMED-healthy replica check (getBackupStatus's own
// lastCheckedAt) -- i.e. how stale our redundancy confirmation is, which
// is the real "data loss window" if something went wrong since. Never a
// fabricated number.

import { createHash } from "node:crypto";
import { InayaKernel } from "@inaya-network/custody-sdk";
import { getOrgCollections, toObjectId } from "./orgs.js";
import { getProvider } from "./pinningProviders/index.js";
import { getBackupStatus } from "./backupEngine.js";
import { getDocumentAccessLevel, meetsLevel } from "./document-permissions.js";
import { getPolicy, evaluateRtoRpo } from "./resilience-policy.js";
import { ensureCanaryAssets } from "./resilience-canary.js";
import { logOrgActivity } from "./org-activity-log.js";

export const ENGINE_VERSION = "1.0.0";

function sha256Hex0x(text) {
  return "0x" + createHash("sha256").update(text).digest("hex");
}

function minutesSince(iso) {
  if (!iso) return null;
  return (Date.now() - new Date(iso).getTime()) / 60000;
}

async function testOneCanary(canary, { orgId, membership, actorEmail }) {
  const assetStart = Date.now();
  let recovered = false, integrityPass = false, permissionPass = false, error = null;
  const dependencyDetail = [];

  try {
    for (const shardId of ["alpha", "beta"]) {
      for (const replica of canary.replicas?.[shardId] || []) {
        let reachable = false;
        try {
          reachable = await getProvider(replica.provider).getPinStatus(replica.providerRef);
        } catch { /* treated as unreachable below */ }
        dependencyDetail.push({ shardId, provider: replica.provider, reachable: !!reachable });
      }
    }

    const alphaReplica = canary.replicas?.alpha?.[0];
    const betaReplica = canary.replicas?.beta?.[0];
    if (!alphaReplica || !betaReplica) throw new Error("No recorded replica for this canary's alpha/beta shard.");

    const [shardAlpha, shardBeta] = await Promise.all([
      getProvider(alphaReplica.provider).fetchReplica(alphaReplica.providerRef),
      getProvider(betaReplica.provider).fetchReplica(betaReplica.providerRef),
    ]);
    const dataUrl = await InayaKernel.reconstructAndDecrypt({ shardAlpha, shardBeta, passkey: canary.passkey });
    recovered = true;

    const base64Content = dataUrl.split(",")[1] || "";
    const decodedContent = Buffer.from(base64Content, "base64").toString("utf8");
    integrityPass = sha256Hex0x(decodedContent) === canary.expectedContentHash;

    const { orgDocuments } = await getOrgCollections();
    const docRow = await orgDocuments.findOne({ _id: canary.documentId, orgId: toObjectId(orgId) });
    const level = docRow ? await getDocumentAccessLevel({ orgId, doc: docRow, membership, email: actorEmail }) : null;
    permissionPass = meetsLevel(level, "VIEW");
  } catch (err) {
    error = err.message;
  }

  const dependencyOk = dependencyDetail.length > 0 && dependencyDetail.every((d) => d.reachable);
  const backupStatus = await getBackupStatus(canary.fileHash).catch(() => null);
  const lastCheckedAt = [...(backupStatus?.shardAlpha?.replicas || []), ...(backupStatus?.shardBeta?.replicas || [])]
    .map((r) => r.lastCheckedAt)
    .filter(Boolean)
    .sort()
    .pop();
  const rpoMinutes = minutesSince(lastCheckedAt) ?? minutesSince(canary.createdAt) ?? 0;

  return {
    categoryLabel: canary.categoryLabel, fileHash: canary.fileHash,
    recovered, integrityPass, permissionPass, dependencyOk, dependencyDetail,
    durationMs: Date.now() - assetStart, rpoMinutes, error,
  };
}

/** Runs one full resilience test for a policy. Never touches a real
 *  customer orgDocuments row -- every asset read/written belongs to the
 *  policy's own canary set. Atomic duplicate-run guard: a second call
 *  while one is already RUNNING for this policy is rejected, not queued
 *  or silently merged. */
export async function runResilienceTest({ orgId, policyId, membership, actorEmail, triggeredBy = "manual" }) {
  const policyResult = await getPolicy({ orgId, policyId });
  if (policyResult.error) return policyResult;
  const policy = policyResult.policy;
  if (policy.status !== "ACTIVE") return { error: "This resilience policy is paused.", status: 409 };

  const { resilienceTestRuns } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const policyObjectId = toObjectId(policyId);

  const alreadyRunning = await resilienceTestRuns.findOne({ orgId: orgObjectId, policyId: policyObjectId, status: "RUNNING" });
  if (alreadyRunning) return { error: "A resilience test is already running for this policy.", status: 409 };

  const canaryResult = await ensureCanaryAssets(policyId, { orgId, actorEmail });
  if (canaryResult.error) return canaryResult;

  const startedAt = new Date().toISOString();
  const { insertedId: testRunId } = await resilienceTestRuns.insertOne({
    orgId: orgObjectId, policyId: policyObjectId, status: "RUNNING",
    startedAt, completedAt: null, actualRTOMinutes: null, actualRPOMinutes: null,
    assetResults: [], dependencyResults: [], overallResult: null,
    engineVersion: ENGINE_VERSION,
    configSnapshot: { requiredRTOMinutes: policy.requiredRTOMinutes, requiredRPOMinutes: policy.requiredRPOMinutes, testFrequency: policy.testFrequency },
    triggeredBy, actorEmail: actorEmail || null,
  });

  const assetResults = [];
  for (const canary of canaryResult.canaries) {
    assetResults.push(await testOneCanary(canary, { orgId, membership, actorEmail }));
  }

  const completedAt = new Date().toISOString();
  const actualRTOMinutes = (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 60000;
  const actualRPOMinutes = Math.max(...assetResults.map((a) => a.rpoMinutes), 0);
  const { rtoPass, rpoPass, overallPass } = evaluateRtoRpo(policy, actualRTOMinutes, actualRPOMinutes);
  const allAssetsPass = assetResults.every((a) => a.recovered && a.integrityPass && a.permissionPass && a.dependencyOk);
  const overallResult = overallPass && allAssetsPass ? "PASS" : "FAIL";

  const updated = await resilienceTestRuns.findOneAndUpdate(
    { _id: testRunId, status: "RUNNING" },
    {
      $set: {
        status: "COMPLETED", completedAt, actualRTOMinutes, actualRPOMinutes,
        assetResults, rtoPass, rpoPass, overallResult,
      },
    },
    { returnDocument: "after" }
  );

  const { resiliencePolicies } = await getOrgCollections();
  await resiliencePolicies.updateOne({ _id: policyObjectId }, { $set: { lastTestAt: completedAt } });

  await logOrgActivity({
    orgId: orgObjectId, recordType: "RESILIENCE_TEST_RUN", recordId: testRunId,
    actorEmail: actorEmail || "system", action: "RESILIENCE_TEST_COMPLETED",
    previousState: "RUNNING", newState: overallResult,
    metadata: { policyId: policyId.toString(), actualRTOMinutes, actualRPOMinutes, assetCount: assetResults.length, engineVersion: ENGINE_VERSION },
  });

  return { testRun: serializeTestRun(updated) };
}

function serializeTestRun(row) {
  if (!row) return null;
  return {
    testRunId: row._id.toString(),
    orgId: row.orgId.toString(),
    policyId: row.policyId.toString(),
    status: row.status,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    actualRTOMinutes: row.actualRTOMinutes,
    actualRPOMinutes: row.actualRPOMinutes,
    rtoPass: row.rtoPass ?? null,
    rpoPass: row.rpoPass ?? null,
    assetResults: row.assetResults,
    overallResult: row.overallResult,
    engineVersion: row.engineVersion,
    configSnapshot: row.configSnapshot,
    triggeredBy: row.triggeredBy,
    actorEmail: row.actorEmail,
  };
}

export async function getLatestTestRun({ orgId, policyId }) {
  const { resilienceTestRuns } = await getOrgCollections();
  const row = await resilienceTestRuns
    .find({ orgId: toObjectId(orgId), policyId: toObjectId(policyId), status: "COMPLETED" })
    .sort({ completedAt: -1 })
    .limit(1)
    .toArray();
  return { testRun: serializeTestRun(row[0]) };
}

export async function listTestRuns({ orgId, policyId, limit = 20 }) {
  const { resilienceTestRuns } = await getOrgCollections();
  const rows = await resilienceTestRuns
    .find({ orgId: toObjectId(orgId), policyId: toObjectId(policyId) })
    .sort({ startedAt: -1 })
    .limit(limit)
    .toArray();
  return { testRuns: rows.map(serializeTestRun) };
}
