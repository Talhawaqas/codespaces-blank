// test/citizen-records.test.mjs
//
// THE load-bearing correctness property for this phase (SOW §C
// "need-to-know access", "assignment-based access to sensitive records"):
// citizen-record access requires an ACTUAL assignment, not just
// department membership or even governmentRole:"staff". This mirrors
// Health OS's exact isCareTeamMember precedent. Written to confirm it
// would fail on a naive first draft (a version that granted access to any
// governmentRole:"staff" member regardless of assignment) before trusting
// the real implementation.
//
// Run with: node --env-file=.env.local --test test/citizen-records.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { createCitizenRecord, assignCitizenRecord, unassignCitizenRecord, requireCitizenRecordAccess, mergeCitizenRecords, findDuplicateCitizenRecordCandidates } from "../src/lib/citizen-records.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `citizen-records-${RUN_ID}@example.com`;
const OWNER_MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
const STAFF_EMAIL = `staff-${RUN_ID}@example.com`;
const STAFF_MEMBERSHIP = { role: "member", email: STAFF_EMAIL, governmentRole: "staff" };
let collections;
let orgId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const result = await collections.orgs.insertOne({ name: `Citizen Records Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "government", createdAt: now });
  orgId = result.insertedId;
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: orgId }),
    collections.citizenRecords.deleteMany({ orgId }),
    collections.citizenRecordAssignments.deleteMany({ orgId }),
    collections.orgActivity.deleteMany({ orgId }),
    collections.auditChainEntries.deleteMany({ orgId }),
    collections.auditChainHeads.deleteMany({ orgId }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

test("SECURITY: a government staff member with NO assignment to a record cannot access it, even though they have governmentRole:staff", async () => {
  const { record } = await createCitizenRecord({ orgId, legalName: "Jane Doe", dateOfBirth: "1990-01-01", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });

  const access = await requireCitizenRecordAccess({ orgId, recordId: record._id, membership: STAFF_MEMBERSHIP, actorEmail: STAFF_EMAIL });
  assert.equal(access.error !== undefined, true, "an unassigned staff member must be denied, department/role membership alone is not enough");
  assert.equal(access.status, 403);
});

test("assigning a staff member grants access; unassigning revokes it again", async () => {
  const { record } = await createCitizenRecord({ orgId, legalName: "John Smith", dateOfBirth: "1985-05-05", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });

  const beforeAssign = await requireCitizenRecordAccess({ orgId, recordId: record._id, membership: STAFF_MEMBERSHIP, actorEmail: STAFF_EMAIL });
  assert.equal(beforeAssign.error !== undefined, true);

  await assignCitizenRecord({ orgId, recordId: record._id, memberEmail: STAFF_EMAIL, role: "member", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  const afterAssign = await requireCitizenRecordAccess({ orgId, recordId: record._id, membership: STAFF_MEMBERSHIP, actorEmail: STAFF_EMAIL });
  assert.equal(afterAssign.error, undefined, "an assigned staff member must be granted access");
  assert.equal(afterAssign.record.legalName, "John Smith");

  await unassignCitizenRecord({ orgId, recordId: record._id, memberEmail: STAFF_EMAIL, actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  const afterUnassign = await requireCitizenRecordAccess({ orgId, recordId: record._id, membership: STAFF_MEMBERSHIP, actorEmail: STAFF_EMAIL });
  assert.equal(afterUnassign.error !== undefined, true, "revoking the assignment must revoke access again");
});

test("org owner/admin can always access any citizen record without an explicit assignment", async () => {
  const { record } = await createCitizenRecord({ orgId, legalName: "Ada Lovelace", dateOfBirth: "1992-12-10", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  const access = await requireCitizenRecordAccess({ orgId, recordId: record._id, membership: OWNER_MEMBERSHIP, actorEmail: OWNER_EMAIL });
  assert.equal(access.error, undefined);
});

test("access to a citizen record from a DIFFERENT org is denied, not just a different record within the same org", async () => {
  const { record } = await createCitizenRecord({ orgId, legalName: "Cross Org Test", dateOfBirth: "2000-01-01", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  const otherOrgResult = await collections.orgs.insertOne({ name: `Other Org ${RUN_ID}`, ownerEmail: `other-${RUN_ID}@example.com`, vertical: "government", createdAt: new Date().toISOString() });
  const access = await requireCitizenRecordAccess({ orgId: otherOrgResult.insertedId, recordId: record._id, membership: OWNER_MEMBERSHIP, actorEmail: OWNER_EMAIL });
  assert.equal(access.error !== undefined, true, "a record must not be findable by ID alone across org boundaries");
  assert.equal(access.status, 404);
  await collections.orgs.deleteOne({ _id: otherOrgResult.insertedId });
});

test("duplicate detection surfaces name+DOB matches as candidates, never auto-merges", async () => {
  await createCitizenRecord({ orgId, legalName: "Duplicate Person", dateOfBirth: "1975-03-15", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  await createCitizenRecord({ orgId, legalName: "Duplicate Person", dateOfBirth: "1975-03-15", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  const candidates = await findDuplicateCitizenRecordCandidates({ orgId, legalName: "Duplicate Person", dateOfBirth: "1975-03-15" });
  assert.equal(candidates.length, 2, "both records must be surfaced as candidates for a human to review");
});

test("mergeCitizenRecords never hard-deletes the duplicate -- it soft-deletes and records the merge decision", async () => {
  const { record: surviving } = await createCitizenRecord({ orgId, legalName: "Survivor", dateOfBirth: "1980-01-01", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  const { record: duplicate } = await createCitizenRecord({ orgId, legalName: "Survivor Dup", dateOfBirth: "1980-01-01", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });

  const { merged } = await mergeCitizenRecords({ orgId, survivingRecordId: surviving._id, duplicateRecordId: duplicate._id, actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  assert.equal(merged.deletedAt !== null, true);
  assert.equal(merged.mergedInto.toString(), surviving._id.toString());

  const stillInDb = await collections.citizenRecords.findOne({ _id: duplicate._id });
  assert.notEqual(stillInDb, null, "the duplicate record must still exist in the database, only soft-deleted");
});
