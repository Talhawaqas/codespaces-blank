// test/government-cases.test.mjs
//
// Transition legality (illegal state jumps rejected, atomic-conflict safe)
// plus the citizen-record-link access check a case inherits when linked.
//
// Run with: node --env-file=.env.local --test test/government-cases.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { createCase, transitionCase, getCase, listCases } from "../src/lib/government-cases.js";
import { createCitizenRecord, assignCitizenRecord } from "../src/lib/citizen-records.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `gov-cases-${RUN_ID}@example.com`;
const OWNER_MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
const STAFF_EMAIL = `gov-cases-staff-${RUN_ID}@example.com`;
const STAFF_MEMBERSHIP = { role: "member", email: STAFF_EMAIL, governmentRole: "staff" };
let collections;
let orgId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const result = await collections.orgs.insertOne({ name: `Government Cases Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "government", createdAt: now });
  orgId = result.insertedId;
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: orgId }),
    collections.governmentCases.deleteMany({ orgId }),
    collections.citizenRecords.deleteMany({ orgId }),
    collections.citizenRecordAssignments.deleteMany({ orgId }),
    collections.orgActivity.deleteMany({ orgId }),
    collections.auditChainEntries.deleteMany({ orgId }),
    collections.auditChainHeads.deleteMany({ orgId }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

test("a case walks OPEN -> ASSIGNED -> IN_PROGRESS -> PENDING_REVIEW -> RESOLVED -> CLOSED through legal transitions only", async () => {
  const { case: created } = await createCase({ orgId, category: "citizen_services", priority: "medium", title: "Test Case", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  assert.equal(created.status, "OPEN");

  const assigned = await transitionCase({ orgId, caseId: created._id, action: "assign", ownerEmail: STAFF_EMAIL, actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  assert.equal(assigned.case.status, "ASSIGNED");
  assert.equal(assigned.case.ownerEmail, STAFF_EMAIL);

  const started = await transitionCase({ orgId, caseId: created._id, action: "start", actorEmail: STAFF_EMAIL, membership: STAFF_MEMBERSHIP });
  assert.equal(started.case.status, "IN_PROGRESS");

  const submitted = await transitionCase({ orgId, caseId: created._id, action: "submitForReview", actorEmail: STAFF_EMAIL, membership: STAFF_MEMBERSHIP });
  assert.equal(submitted.case.status, "PENDING_REVIEW");

  const resolved = await transitionCase({ orgId, caseId: created._id, action: "resolve", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  assert.equal(resolved.case.status, "RESOLVED");
  assert.notEqual(resolved.case.resolvedAt, null);

  const closed = await transitionCase({ orgId, caseId: created._id, action: "close", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  assert.equal(closed.case.status, "CLOSED");
});

test("an illegal transition (skipping states) is rejected with 409, and the case's status is unchanged", async () => {
  const { case: created } = await createCase({ orgId, category: "regulatory", priority: "low", title: "Illegal Jump Test", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });

  const result = await transitionCase({ orgId, caseId: created._id, action: "resolve", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  assert.equal(result.error !== undefined, true, "cannot jump straight from OPEN to RESOLVED");
  assert.equal(result.status, 409);

  const stored = await collections.governmentCases.findOne({ _id: created._id });
  assert.equal(stored.status, "OPEN");
});

test("creating a case linked to a citizen record the caller isn't assigned to is denied", async () => {
  const { record } = await createCitizenRecord({ orgId, legalName: "Linked Citizen", dateOfBirth: "1995-06-06", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  const result = await createCase({ orgId, category: "citizen_services", priority: "medium", title: "Should be denied", citizenRecordId: record._id, actorEmail: STAFF_EMAIL, membership: STAFF_MEMBERSHIP });
  assert.equal(result.error !== undefined, true);
  assert.equal(result.status, 403);
});

test("a case linked to a citizen record the caller IS assigned to is visible in getCase(); one they aren't assigned to, in listCases(), is filtered out for staff", async () => {
  const { record: recordA } = await createCitizenRecord({ orgId, legalName: "Visible Citizen", dateOfBirth: "1993-02-02", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  const { record: recordB } = await createCitizenRecord({ orgId, legalName: "Hidden Citizen", dateOfBirth: "1994-04-04", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  await assignCitizenRecord({ orgId, recordId: recordA._id, memberEmail: STAFF_EMAIL, actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });

  const { case: caseA } = await createCase({ orgId, category: "citizen_services", priority: "low", title: "Case A", citizenRecordId: recordA._id, actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  const { case: caseB } = await createCase({ orgId, category: "citizen_services", priority: "low", title: "Case B", citizenRecordId: recordB._id, actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });

  const staffGetA = await getCase({ orgId, caseId: caseA._id, membership: STAFF_MEMBERSHIP });
  assert.equal(staffGetA.error, undefined, "staff assigned to the linked citizen record can view the case");

  const staffGetB = await getCase({ orgId, caseId: caseB._id, membership: STAFF_MEMBERSHIP });
  assert.equal(staffGetB.error !== undefined, true, "staff NOT assigned to the linked citizen record cannot view the case");

  const { cases: staffList } = await listCases(orgId, { membership: STAFF_MEMBERSHIP });
  const visibleIds = staffList.map((c) => c._id.toString());
  assert.ok(visibleIds.includes(caseA._id.toString()), "Case A must appear in the staff member's list");
  assert.ok(!visibleIds.includes(caseB._id.toString()), "Case B must NOT appear in the staff member's list");
});
