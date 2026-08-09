// test/document-workflow.test.mjs
//
// Phase 2 coverage per the SOW's explicit list: valid/invalid/unauthorized
// transitions, organization isolation, activity log creation + ordering,
// reject->revise->resubmit, approve->archive, duplicate/replayed requests.
//
// Tests transitionDocument()/logDocumentActivity() directly (src/lib/
// document-workflow.js) rather than the HTTP routes — same reasoning as
// referral-webhook-logic.test.mjs: the routes are thin wrappers (auth +
// param parsing) around this function, and importing route.js pulls in
// next/server, which plain `node --test` can't resolve outside Next's own
// bundler. Document fixtures are inserted directly into org_documents
// rather than going through the real upload route, since that route makes
// a genuine on-chain call — not something a unit test should depend on.
//
// Run with: node --test test/document-workflow.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { transitionDocument } from "../src/lib/document-workflow.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-wf-${RUN_ID}-${label}@example.com`;

let collections;
const cleanup = { orgIds: [], docIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { orgs, orgMembers, departments, projects, orgDocuments, documentActivity } = collections;
  await orgMembers.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await departments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await projects.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgDocuments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await documentActivity.deleteMany({ documentId: { $in: cleanup.docIds } });
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

// ============================================================
// Fixtures
// ============================================================
async function makeOrgWithDepartment(label) {
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `${label} Co`, ownerEmail: email(`${label}-owner`), createdAt: now });
  cleanup.orgIds.push(orgResult.insertedId);
  const orgId = orgResult.insertedId;

  const deptResult = await collections.departments.insertOne({ orgId, name: "Finance", createdAt: now });
  const projResult = await collections.projects.insertOne({ orgId, departmentId: deptResult.insertedId, name: "Q3", createdAt: now });

  const ownerEmail = email(`${label}-owner`);
  await collections.orgMembers.insertOne({ orgId, email: ownerEmail, role: "owner", departmentIds: [], status: "active", invitedAt: now, joinedAt: now });
  const owner = await collections.orgMembers.findOne({ orgId, email: ownerEmail });

  const memberEmail = email(`${label}-member`);
  await collections.orgMembers.insertOne({ orgId, email: memberEmail, role: "member", departmentIds: [deptResult.insertedId], status: "active", invitedAt: now, joinedAt: now });
  const member = await collections.orgMembers.findOne({ orgId, email: memberEmail });

  return { orgId, departmentId: deptResult.insertedId, projectId: projResult.insertedId, owner, member, ownerEmail, memberEmail };
}

async function makeDocument({ orgId, departmentId, projectId, status }) {
  const now = new Date().toISOString();
  const result = await collections.orgDocuments.insertOne({
    orgId,
    departmentId,
    projectId,
    filename: "test.pdf",
    fileHash: `0xtest-${randomUUID()}`,
    sizeBytes: 1024,
    cidAlpha: "cidA",
    cidBeta: "cidB",
    uploadedByEmail: "uploader@example.com",
    txHash: "0xfake",
    status,
    createdAt: now,
    deletedAt: null,
  });
  cleanup.docIds.push(result.insertedId);
  return result.insertedId;
}

async function getActivity(documentId) {
  return collections.documentActivity.find({ documentId }).sort({ timestamp: 1 }).toArray();
}

// ============================================================
// Valid transitions
// ============================================================
test("valid transition: submit moves DRAFT -> PENDING for a department member", async () => {
  const org = await makeOrgWithDepartment("valid-submit");
  const docId = await makeDocument({ ...org, status: "DRAFT" });

  const result = await transitionDocument({ orgId: org.orgId, documentId: docId, action: "submit", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(result.error, undefined);
  assert.equal(result.document.status, "PENDING");
});

test("valid transition: startReview, approve, archive, restore all succeed for owner in sequence", async () => {
  const org = await makeOrgWithDepartment("valid-chain");
  const docId = await makeDocument({ ...org, status: "PENDING" });

  const r1 = await transitionDocument({ orgId: org.orgId, documentId: docId, action: "startReview", membership: org.owner, actorEmail: org.ownerEmail });
  assert.equal(r1.document.status, "UNDER_REVIEW");

  const r2 = await transitionDocument({ orgId: org.orgId, documentId: docId, action: "approve", membership: org.owner, actorEmail: org.ownerEmail });
  assert.equal(r2.document.status, "APPROVED");

  const r3 = await transitionDocument({ orgId: org.orgId, documentId: docId, action: "archive", membership: org.owner, actorEmail: org.ownerEmail });
  assert.equal(r3.document.status, "ARCHIVED");

  const r4 = await transitionDocument({ orgId: org.orgId, documentId: docId, action: "restore", membership: org.owner, actorEmail: org.ownerEmail });
  assert.equal(r4.document.status, "APPROVED");
});

// ============================================================
// Invalid transitions
// ============================================================
test("invalid transition: submit fails when document is not in DRAFT", async () => {
  const org = await makeOrgWithDepartment("invalid-wrong-state");
  const docId = await makeDocument({ ...org, status: "APPROVED" });

  const result = await transitionDocument({ orgId: org.orgId, documentId: docId, action: "submit", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(result.status, 409);
  assert.match(result.error, /isn't in DRAFT state/);

  const doc = await collections.orgDocuments.findOne({ _id: docId });
  assert.equal(doc.status, "APPROVED", "state must be unchanged after a rejected transition");
});

test("invalid transition: cannot skip straight from DRAFT to APPROVED (no such action exists)", async () => {
  const org = await makeOrgWithDepartment("invalid-skip");
  const docId = await makeDocument({ ...org, status: "DRAFT" });

  // There is no single action that goes DRAFT -> APPROVED — attempting
  // "approve" on a DRAFT document must fail because approve requires
  // UNDER_REVIEW, not because of some special-cased skip check.
  const result = await transitionDocument({ orgId: org.orgId, documentId: docId, action: "approve", membership: org.owner, actorEmail: org.ownerEmail });
  assert.equal(result.status, 409);
});

test("invalid transition: unknown action name is rejected", async () => {
  const org = await makeOrgWithDepartment("invalid-unknown");
  const docId = await makeDocument({ ...org, status: "DRAFT" });

  const result = await transitionDocument({ orgId: org.orgId, documentId: docId, action: "deleteForever", membership: org.owner, actorEmail: org.ownerEmail });
  assert.equal(result.status, 400);
});

// ============================================================
// Unauthorized transitions
// ============================================================
test("unauthorized: a plain member cannot startReview, approve, reject, archive, or restore", async () => {
  const org = await makeOrgWithDepartment("unauthorized-member");
  const statesAndActions = [
    ["PENDING", "startReview"],
    ["UNDER_REVIEW", "approve"],
    ["UNDER_REVIEW", "reject"],
    ["APPROVED", "archive"],
    ["ARCHIVED", "restore"],
  ];
  for (const [status, action] of statesAndActions) {
    const docId = await makeDocument({ ...org, status });
    const result = await transitionDocument({ orgId: org.orgId, documentId: docId, action, membership: org.member, actorEmail: org.memberEmail });
    assert.equal(result.status, 403, `member should be blocked from "${action}"`);
  }
});

test("unauthorized: a member with no access to the document's department cannot even submit", async () => {
  const org = await makeOrgWithDepartment("unauthorized-dept");
  const docId = await makeDocument({ ...org, status: "DRAFT" });

  const outsiderEmail = email("unauthorized-dept-outsider");
  const now = new Date().toISOString();
  await collections.orgMembers.insertOne({ orgId: org.orgId, email: outsiderEmail, role: "member", departmentIds: [], status: "active", invitedAt: now, joinedAt: now });
  const outsider = await collections.orgMembers.findOne({ orgId: org.orgId, email: outsiderEmail });

  const result = await transitionDocument({ orgId: org.orgId, documentId: docId, action: "submit", membership: outsider, actorEmail: outsiderEmail });
  assert.equal(result.status, 403);
});

// ============================================================
// Organization isolation
// ============================================================
test("organization isolation: a document from org A is invisible to a member of org B, even with the right role", async () => {
  const orgA = await makeOrgWithDepartment("isolation-a");
  const orgB = await makeOrgWithDepartment("isolation-b");
  const docInA = await makeDocument({ ...orgA, status: "PENDING" });

  // orgB's owner tries to act on orgA's document, passing orgB's orgId
  // (as a real caller would — the route always scopes to the org they're
  // authenticated into) but orgA's documentId.
  const result = await transitionDocument({ orgId: orgB.orgId, documentId: docInA, action: "startReview", membership: orgB.owner, actorEmail: orgB.ownerEmail });
  assert.equal(result.status, 404, "the document must not be found when queried under the wrong org");

  const doc = await collections.orgDocuments.findOne({ _id: docInA });
  assert.equal(doc.status, "PENDING", "cross-org access attempt must not have changed anything");
});

// ============================================================
// Activity log: creation + fields
// ============================================================
test("activity log: a successful transition creates exactly one correctly-shaped entry", async () => {
  const org = await makeOrgWithDepartment("activity-fields");
  const docId = await makeDocument({ ...org, status: "DRAFT" });

  await transitionDocument({ orgId: org.orgId, documentId: docId, action: "submit", membership: org.member, actorEmail: org.memberEmail, note: "ready for review" });

  const events = await getActivity(docId);
  assert.equal(events.length, 1);
  const [e] = events;
  assert.ok(e.eventId);
  assert.equal(e.organizationId.toString(), org.orgId.toString());
  assert.equal(e.documentId.toString(), docId.toString());
  assert.equal(e.actorId, org.memberEmail);
  assert.equal(e.action, "SUBMITTED");
  assert.equal(e.previousState, "DRAFT");
  assert.equal(e.newState, "PENDING");
  assert.ok(e.timestamp);
  assert.equal(e.metadata.note, "ready for review");
});

test("activity log: a rejected transition (wrong state, unauthorized) creates NO entry", async () => {
  const org = await makeOrgWithDepartment("activity-no-entry");
  const docId = await makeDocument({ ...org, status: "APPROVED" });

  await transitionDocument({ orgId: org.orgId, documentId: docId, action: "submit", membership: org.member, actorEmail: org.memberEmail });
  await transitionDocument({ orgId: org.orgId, documentId: docId, action: "archive", membership: org.member, actorEmail: org.memberEmail }); // unauthorized

  const events = await getActivity(docId);
  assert.equal(events.length, 0);
});

// ============================================================
// Activity ordering
// ============================================================
test("activity ordering: entries come back in chronological order across multiple transitions", async () => {
  const org = await makeOrgWithDepartment("activity-order");
  const docId = await makeDocument({ ...org, status: "DRAFT" });

  await transitionDocument({ orgId: org.orgId, documentId: docId, action: "submit", membership: org.member, actorEmail: org.memberEmail });
  await transitionDocument({ orgId: org.orgId, documentId: docId, action: "startReview", membership: org.owner, actorEmail: org.ownerEmail });
  await transitionDocument({ orgId: org.orgId, documentId: docId, action: "approve", membership: org.owner, actorEmail: org.ownerEmail });

  const events = await getActivity(docId);
  assert.deepEqual(events.map((e) => e.action), ["SUBMITTED", "REVIEW_STARTED", "APPROVED"]);
  const timestamps = events.map((e) => new Date(e.timestamp).getTime());
  const sorted = [...timestamps].sort((a, b) => a - b);
  assert.deepEqual(timestamps, sorted);
});

// ============================================================
// Full lifecycle cycles
// ============================================================
test("full cycle: submit -> startReview -> reject -> revise -> submit again (resubmission)", async () => {
  const org = await makeOrgWithDepartment("cycle-reject-revise");
  const docId = await makeDocument({ ...org, status: "DRAFT" });

  await transitionDocument({ orgId: org.orgId, documentId: docId, action: "submit", membership: org.member, actorEmail: org.memberEmail });
  await transitionDocument({ orgId: org.orgId, documentId: docId, action: "startReview", membership: org.owner, actorEmail: org.ownerEmail });
  const rejected = await transitionDocument({ orgId: org.orgId, documentId: docId, action: "reject", membership: org.owner, actorEmail: org.ownerEmail, note: "missing signature" });
  assert.equal(rejected.document.status, "REJECTED");

  const revised = await transitionDocument({ orgId: org.orgId, documentId: docId, action: "revise", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(revised.document.status, "DRAFT");

  const resubmitted = await transitionDocument({ orgId: org.orgId, documentId: docId, action: "submit", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(resubmitted.document.status, "PENDING");

  const events = await getActivity(docId);
  assert.deepEqual(events.map((e) => e.action), ["SUBMITTED", "REVIEW_STARTED", "REJECTED", "REVISED", "SUBMITTED"]);
});

test("full cycle: submit -> startReview -> approve -> archive", async () => {
  const org = await makeOrgWithDepartment("cycle-approve-archive");
  const docId = await makeDocument({ ...org, status: "DRAFT" });

  await transitionDocument({ orgId: org.orgId, documentId: docId, action: "submit", membership: org.member, actorEmail: org.memberEmail });
  await transitionDocument({ orgId: org.orgId, documentId: docId, action: "startReview", membership: org.owner, actorEmail: org.ownerEmail });
  await transitionDocument({ orgId: org.orgId, documentId: docId, action: "approve", membership: org.owner, actorEmail: org.ownerEmail });
  const archived = await transitionDocument({ orgId: org.orgId, documentId: docId, action: "archive", membership: org.owner, actorEmail: org.ownerEmail });

  assert.equal(archived.document.status, "ARCHIVED");
  const events = await getActivity(docId);
  assert.deepEqual(events.map((e) => e.action), ["SUBMITTED", "REVIEW_STARTED", "APPROVED", "ARCHIVED"]);
});

// ============================================================
// Duplicate / replayed requests
// ============================================================
test("duplicate/replayed request: firing the same transition twice fails cleanly the second time, with only one activity entry", async () => {
  const org = await makeOrgWithDepartment("duplicate-request");
  const docId = await makeDocument({ ...org, status: "DRAFT" });

  const first = await transitionDocument({ orgId: org.orgId, documentId: docId, action: "submit", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(first.document.status, "PENDING");

  const replay = await transitionDocument({ orgId: org.orgId, documentId: docId, action: "submit", membership: org.member, actorEmail: org.memberEmail });
  assert.equal(replay.status, 409, "the replayed request must be rejected, not silently reapplied");

  const doc = await collections.orgDocuments.findOne({ _id: docId });
  assert.equal(doc.status, "PENDING", "state must still reflect only the first, successful transition");

  const events = await getActivity(docId);
  assert.equal(events.length, 1, "the replay must not have logged a second activity entry");
});

test("duplicate/replayed request: concurrent submits on the same DRAFT document — only one wins", async () => {
  const org = await makeOrgWithDepartment("concurrent-request");
  const docId = await makeDocument({ ...org, status: "DRAFT" });

  const [a, b] = await Promise.all([
    transitionDocument({ orgId: org.orgId, documentId: docId, action: "submit", membership: org.member, actorEmail: org.memberEmail }),
    transitionDocument({ orgId: org.orgId, documentId: docId, action: "submit", membership: org.member, actorEmail: org.memberEmail }),
  ]);
  const results = [a, b];
  const succeeded = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);
  assert.equal(succeeded.length, 1, "exactly one of the two concurrent submits should win");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].status, 409);

  const events = await getActivity(docId);
  assert.equal(events.length, 1, "concurrent duplicate submits must still only produce one activity entry");
});
