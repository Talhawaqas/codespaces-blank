// test/evidence.test.mjs
//
// Institutional Trust Infrastructure SOW, Phase 2 coverage: getEvidenceTrail()
// correctly merges org_activity with linked AI-action-request lifecycle
// events, verifyOrgEvidenceIntegrity() correctly delegates to the real
// chain verifier (and correctly flags a tampered entry -- same semantics
// as auditChain.js's own verify), exportEvidencePackage() matches the
// existing api/orgs/audit/export shape, and cross-org isolation holds
// throughout.
//
// Run with: node --env-file=.env.local --test test/evidence.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { logOrgActivity } from "../src/lib/org-activity-log.js";
import { proposeAiAction, reviewAiAction } from "../src/lib/ai-action-requests.js";
import { getEvidenceTrail, verifyOrgEvidenceIntegrity, exportEvidencePackage } from "../src/lib/evidence.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-evidence-${RUN_ID}-${label}@example.com`;

let collections;
const cleanup = { orgIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { orgActivity, auditChainEntries, auditChainHeads, aiActionRequests } = collections;
  await orgActivity.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainEntries.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainHeads.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await aiActionRequests.deleteMany({ orgId: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

function newOrgId() {
  const id = new ObjectId();
  cleanup.orgIds.push(id);
  return id;
}

test("getEvidenceTrail: merges org_activity with a linked AI action request's lifecycle, newest first", async () => {
  const orgId = newOrgId();
  const recordId = new ObjectId();
  const actor = email("a");

  await logOrgActivity({ orgId, recordType: "TASK", recordId, actorEmail: actor, action: "TASK_CREATED", previousState: null, newState: "TODO" });

  const { request } = await proposeAiAction({
    orgId, assistantSurface: "business", toolName: "propose_task_status_change",
    targetRecordType: "TASK", targetRecordId: recordId, proposedAction: "start",
    args: { taskId: recordId.toString(), action: "start" },
    requestedContextSummary: "evidence test", actorEmail: actor, canPropose: true,
  });
  await reviewAiAction({ orgId, requestId: request._id, decision: "approve", actorEmail: email("approver"), canApprove: true });

  const { trail, count } = await getEvidenceTrail({ orgId, recordType: "TASK", recordId });
  assert.ok(count >= 3, "should include the org_activity entry plus the proposed+approved AI-action events");
  assert.ok(trail.some((e) => e.action === "TASK_CREATED" && e.source === "org-activity"));
  assert.ok(trail.some((e) => e.action === "AI_ACTION_PROPOSED" && e.source === "ai-action-request"));
  assert.ok(trail.some((e) => e.action === "AI_ACTION_APPROVED" && e.source === "ai-action-request"));
  const timestamps = trail.map((e) => new Date(e.timestamp).getTime());
  assert.deepEqual(timestamps, [...timestamps].sort((a, b) => b - a), "trail must be newest-first");
});

test("SECURITY: cross-org isolation -- a record's evidence trail never includes another org's entries", async () => {
  const orgA = newOrgId();
  const orgB = newOrgId();
  const recordId = new ObjectId(); // deliberately reuse the SAME recordId across orgs
  await logOrgActivity({ orgId: orgA, recordType: "TASK", recordId, actorEmail: email("a"), action: "TASK_CREATED", previousState: null, newState: "TODO" });
  await logOrgActivity({ orgId: orgB, recordType: "TASK", recordId, actorEmail: email("b"), action: "TASK_CREATED", previousState: null, newState: "TODO" });

  const trailA = await getEvidenceTrail({ orgId: orgA, recordType: "TASK", recordId });
  assert.equal(trailA.count, 1);
  assert.equal(trailA.trail[0].actorEmail, email("a"));
});

test("verifyOrgEvidenceIntegrity: valid chain reports valid, a directly-tampered entry is caught", async () => {
  const orgId = newOrgId();
  const recordId = new ObjectId();
  await logOrgActivity({ orgId, recordType: "TASK", recordId, actorEmail: email("c"), action: "TASK_CREATED", previousState: null, newState: "TODO" });
  await logOrgActivity({ orgId, recordType: "TASK", recordId, actorEmail: email("c"), action: "TASK_STARTED", previousState: "TODO", newState: "IN_PROGRESS" });

  const before_ = await verifyOrgEvidenceIntegrity(orgId);
  assert.equal(before_.valid, true);
  assert.equal(before_.count, 2);

  const { auditChainEntries } = collections;
  await auditChainEntries.updateOne({ orgId, seq: 1 }, { $set: { action: "TASK_DELETED_MALICIOUSLY" } });

  const after_ = await verifyOrgEvidenceIntegrity(orgId);
  assert.equal(after_.valid, false);
  assert.equal(after_.brokenAtSeq, 1);
});

test("exportEvidencePackage: matches the existing api/orgs/audit/export JSON shape", async () => {
  const orgId = newOrgId();
  const recordId = new ObjectId();
  await logOrgActivity({ orgId, recordType: "TASK", recordId, actorEmail: email("d"), action: "TASK_CREATED", previousState: null, newState: "TODO" });

  const pkg = await exportEvidencePackage(orgId);
  assert.equal(pkg.count, 1);
  const entry = pkg.entries[0];
  for (const field of ["seq", "prevHash", "entryHash", "recordType", "recordId", "actorEmail", "action", "previousState", "newState", "timestamp", "metadata"]) {
    assert.ok(field in entry, `exported entry must carry ${field}, matching api/orgs/audit/export's shape`);
  }
  assert.equal(entry.recordId, recordId.toString());

  const scoped = await exportEvidencePackage(orgId, { recordType: "TASK", recordId });
  assert.equal(scoped.count, 1);
});
