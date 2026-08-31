// test/audit-chain.test.mjs
//
// Phase 2 (Cryptographic Audit Trail) coverage: appendAuditEntry chains
// correctly across multiple calls, verifyChainIntegrity confirms a clean
// chain and catches a direct-DB tamper, and logOrgActivity's best-effort
// wiring actually produces a chain entry per event. Same node --test +
// real Atlas + RUN_ID-fixtures convention as every other test file here.
//
// Run with: node --env-file=.env.local --test test/audit-chain.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { appendAuditEntry, verifyChainIntegrity, listAuditChain } from "../src/lib/auditChain.js";
import { logOrgActivity } from "../src/lib/org-activity-log.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-audit-${RUN_ID}-${label}@example.com`;

let collections;
const cleanup = { orgIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { auditChainEntries, auditChainHeads, orgActivity } = collections;
  await auditChainEntries.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainHeads.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgActivity.deleteMany({ orgId: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

function newOrgId() {
  const id = new ObjectId();
  cleanup.orgIds.push(id);
  return id;
}

test("appendAuditEntry: a run of events chains correctly and verifies clean", async () => {
  const orgId = newOrgId();
  const recordId = new ObjectId();

  const e1 = await appendAuditEntry({ orgId, recordType: "TASK", recordId, actorEmail: email("a"), action: "CREATED" });
  const e2 = await appendAuditEntry({ orgId, recordType: "TASK", recordId, actorEmail: email("a"), action: "started", previousState: "TODO", newState: "IN_PROGRESS" });
  const e3 = await appendAuditEntry({ orgId, recordType: "TASK", recordId, actorEmail: email("a"), action: "completed", previousState: "IN_PROGRESS", newState: "DONE" });

  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  assert.equal(e3.seq, 3);
  assert.equal(e2.prevHash, e1.entryHash);
  assert.equal(e3.prevHash, e2.entryHash);

  const result = await verifyChainIntegrity(orgId);
  assert.equal(result.valid, true);
  assert.equal(result.count, 3);
});

test("verifyChainIntegrity: a direct DB edit to a past entry is caught", async () => {
  const orgId = newOrgId();
  const recordId = new ObjectId();

  await appendAuditEntry({ orgId, recordType: "TASK", recordId, actorEmail: email("b"), action: "CREATED" });
  await appendAuditEntry({ orgId, recordType: "TASK", recordId, actorEmail: email("b"), action: "started" });
  await appendAuditEntry({ orgId, recordType: "TASK", recordId, actorEmail: email("b"), action: "completed" });

  const clean = await verifyChainIntegrity(orgId);
  assert.equal(clean.valid, true);

  // Simulate exactly the threat model this exists to catch: someone with
  // direct DB access edits a past entry's recorded action, bypassing
  // appendAuditEntry entirely.
  const { auditChainEntries } = collections;
  await auditChainEntries.updateOne({ orgId, seq: 2 }, { $set: { action: "tampered" } });

  const tampered = await verifyChainIntegrity(orgId);
  assert.equal(tampered.valid, false);
  assert.equal(tampered.brokenAtSeq, 2);
});

test("logOrgActivity: writing an event also produces a matching chain entry", async () => {
  const orgId = newOrgId();
  const recordId = new ObjectId();

  await logOrgActivity({ orgId, recordType: "TASK", recordId, actorEmail: email("c"), action: "created", previousState: null, newState: "TODO" });

  const chain = await listAuditChain(orgId);
  assert.equal(chain.length, 1);
  assert.equal(chain[0].action, "created");
  assert.equal(chain[0].recordType, "TASK");

  const result = await verifyChainIntegrity(orgId);
  assert.equal(result.valid, true);
});

test("appendAuditEntry: two orgs' chains are fully independent", async () => {
  const orgA = newOrgId();
  const orgB = newOrgId();
  const recordId = new ObjectId();

  await appendAuditEntry({ orgId: orgA, recordType: "TASK", recordId, actorEmail: email("d"), action: "a1" });
  await appendAuditEntry({ orgId: orgB, recordType: "TASK", recordId, actorEmail: email("d"), action: "b1" });
  const a2 = await appendAuditEntry({ orgId: orgA, recordType: "TASK", recordId, actorEmail: email("d"), action: "a2" });

  assert.equal(a2.seq, 2);
  const chainA = await listAuditChain(orgA);
  const chainB = await listAuditChain(orgB);
  assert.equal(chainA.length, 2);
  assert.equal(chainB.length, 1);
});
