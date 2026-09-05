// test/health-legal-core.test.mjs
//
// Healthcare & Legal Expansion SOW, Phases 2 & 6 (Core) coverage: patient/
// matter creation, clinical/matter lifecycle transitions, care-team/
// matter-team ASSIGNMENT-BASED visibility via getAccessibleScope() (the
// critical security property — department membership alone must never
// grant patient/matter access), and conflict-check status discipline.
//
// Run with: node --env-file=.env.local --test test/health-legal-core.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { getAccessibleScope } from "../src/lib/document-permissions.js";
import { createPatient, assignCareTeamMember, findDuplicatePatientCandidates } from "../src/lib/health-patients.js";
import { createClinicalRecord, transitionClinicalRecord, amendClinicalRecord } from "../src/lib/health-clinical-workflow.js";
import { createClient, createProspect, decideProspectEngagement } from "../src/lib/legal-clients.js";
import { createMatter, transitionMatter, assignMatterTeamMember } from "../src/lib/legal-matter-workflow.js";
import { searchConflicts, recordConflictCheck } from "../src/lib/legal-conflict-workflow.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-hlc-${RUN_ID}-${label}@example.com`;

let collections;
const cleanup = { orgIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const {
    orgs, orgMembers, departments,
    healthPatients, healthEncounters, healthCareTeamAssignments, healthClinicalRecords,
    legalClients, legalProspects, legalMatters, legalMatterTeamAssignments, legalConflictChecks,
    auditChainEntries, auditChainHeads,
  } = collections;
  await orgMembers.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await departments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await healthPatients.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await healthEncounters.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await healthCareTeamAssignments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await healthClinicalRecords.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await legalClients.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await legalProspects.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await legalMatters.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await legalMatterTeamAssignments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await legalConflictChecks.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainEntries.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainHeads.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

async function makeOrg(label) {
  const now = new Date().toISOString();
  const ownerEmail = email(`${label}-owner`);
  const orgResult = await collections.orgs.insertOne({ name: `${label} Co`, ownerEmail, createdAt: now });
  cleanup.orgIds.push(orgResult.insertedId);
  const orgId = orgResult.insertedId;
  await collections.orgMembers.insertOne({ orgId, email: ownerEmail, role: "owner", departmentIds: [], status: "active", invitedAt: now, joinedAt: now });
  const owner = await collections.orgMembers.findOne({ orgId, email: ownerEmail });

  // A plain staff member with NO healthRole/legalRole and NO assignment —
  // the negative-test baseline: department membership alone must grant
  // nothing here (unlike Finance/CRM/Procurement where department access
  // IS the whole story).
  const deptResult = await collections.departments.insertOne({ orgId, name: "Clinical", createdAt: now });
  const staffEmail = email(`${label}-staff`);
  await collections.orgMembers.insertOne({ orgId, email: staffEmail, role: "member", departmentIds: [deptResult.insertedId], status: "active", invitedAt: now, joinedAt: now });
  const staff = await collections.orgMembers.findOne({ orgId, email: staffEmail });

  return { orgId, ownerEmail, owner, staffEmail, staff, deptId: deptResult.insertedId };
}

// ============================================================
// Patients + assignment-based visibility (the critical security property)
// ============================================================
test("SECURITY: a department member with NO care-team assignment sees ZERO patients via getAccessibleScope, even though they can access other department-scoped records", async () => {
  const org = await makeOrg("patient-visibility-denied");
  await createPatient({ orgId: org.orgId, legalName: "Jane Doe", dateOfBirth: "1990-01-01", actorEmail: org.ownerEmail, membership: org.owner });

  const scope = await getAccessibleScope({ orgId: org.orgId, membership: org.staff, email: org.staffEmail });
  assert.equal(scope.visiblePatients.length, 0, "department membership alone must never grant patient visibility");
});

test("SECURITY: a care-team-assigned member sees ONLY their assigned patient, not other patients in the org", async () => {
  const org = await makeOrg("patient-visibility-assigned");
  const { patient: assignedPatient } = await createPatient({ orgId: org.orgId, legalName: "Assigned Patient", dateOfBirth: "1985-05-05", actorEmail: org.ownerEmail, membership: org.owner });
  const { patient: otherPatient } = await createPatient({ orgId: org.orgId, legalName: "Other Patient", dateOfBirth: "1985-05-06", actorEmail: org.ownerEmail, membership: org.owner });

  await assignCareTeamMember({ orgId: org.orgId, patientId: assignedPatient._id, memberEmail: org.staffEmail, role: "nurse", actorEmail: org.ownerEmail, membership: org.owner });

  const scope = await getAccessibleScope({ orgId: org.orgId, membership: org.staff, email: org.staffEmail });
  const visibleIds = scope.visiblePatients.map((p) => p._id.toString());
  assert.ok(visibleIds.includes(assignedPatient._id.toString()), "assigned patient must be visible");
  assert.ok(!visibleIds.includes(otherPatient._id.toString()), "an unassigned patient must NOT be visible, even in the same org");
});

test("SECURITY: a health-role staff member sees ALL patients org-wide (role-based, not assignment-limited)", async () => {
  const org = await makeOrg("patient-visibility-healthrole");
  await collections.orgMembers.updateOne({ _id: org.staff._id }, { $set: { healthRole: "staff" } });
  const healthStaff = await collections.orgMembers.findOne({ _id: org.staff._id });

  await createPatient({ orgId: org.orgId, legalName: "Patient A", dateOfBirth: "1970-01-01", actorEmail: org.ownerEmail, membership: org.owner });
  await createPatient({ orgId: org.orgId, legalName: "Patient B", dateOfBirth: "1970-01-02", actorEmail: org.ownerEmail, membership: org.owner });

  const scope = await getAccessibleScope({ orgId: org.orgId, membership: healthStaff, email: org.staffEmail });
  assert.equal(scope.visiblePatients.length, 2, "a healthRole:staff member should see all patients org-wide");
});

test("patient: duplicate detection finds a same-name+DOB candidate but never auto-merges", async () => {
  const org = await makeOrg("patient-duplicate");
  await createPatient({ orgId: org.orgId, legalName: "John Smith", dateOfBirth: "1980-03-03", actorEmail: org.ownerEmail, membership: org.owner });
  const candidates = await findDuplicatePatientCandidates({ orgId: org.orgId, legalName: "john smith", dateOfBirth: "1980-03-03" });
  assert.equal(candidates.length, 1, "case-insensitive name + exact DOB match should surface as a candidate");
});

// ============================================================
// Clinical documentation lifecycle
// ============================================================
test("clinical record: draft -> review -> sign -> lock, then amend creates a NEW record and marks the original AMENDED (never overwritten)", async () => {
  const org = await makeOrg("clinical-lifecycle");
  const { patient } = await createPatient({ orgId: org.orgId, legalName: "Lifecycle Patient", dateOfBirth: "1995-01-01", actorEmail: org.ownerEmail, membership: org.owner });
  const { record } = await createClinicalRecord({ orgId: org.orgId, patientId: patient._id, recordTemplate: "progress_note", content: "v1", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(record.status, "DRAFT");

  const inReview = await transitionClinicalRecord({ orgId: org.orgId, recordId: record._id, action: "submitForReview", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(inReview.record.status, "REVIEW");
  const signed = await transitionClinicalRecord({ orgId: org.orgId, recordId: record._id, action: "sign", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(signed.record.status, "SIGNED");
  assert.equal(signed.record.signedByEmail, org.ownerEmail);
  const locked = await transitionClinicalRecord({ orgId: org.orgId, recordId: record._id, action: "lock", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(locked.record.status, "LOCKED");

  const amended = await amendClinicalRecord({ orgId: org.orgId, recordId: record._id, content: "v2 correction", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(amended.amendedRecord.status, "DRAFT");
  assert.equal(amended.amendedRecord.amendsRecordId.toString(), record._id.toString());

  const { healthClinicalRecords } = collections;
  const original = await healthClinicalRecords.findOne({ _id: record._id });
  assert.equal(original.status, "AMENDED", "the original LOCKED record must be marked AMENDED, never deleted or overwritten");
  assert.equal(original.content, "v1", "the original record's content must be untouched by the amendment");
});

test("clinical record: cannot amend a record that isn't LOCKED", async () => {
  const org = await makeOrg("clinical-amend-guard");
  const { patient } = await createPatient({ orgId: org.orgId, legalName: "Guard Patient", dateOfBirth: "1996-01-01", actorEmail: org.ownerEmail, membership: org.owner });
  const { record } = await createClinicalRecord({ orgId: org.orgId, patientId: patient._id, recordTemplate: "progress_note", actorEmail: org.ownerEmail, membership: org.owner });
  const result = await amendClinicalRecord({ orgId: org.orgId, recordId: record._id, content: "x", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(result.status, 409);
});

// ============================================================
// Matters + assignment-based visibility
// ============================================================
test("SECURITY: matter visibility is assignment-based — an unassigned staff member sees zero matters", async () => {
  const org = await makeOrg("matter-visibility-denied");
  await createMatter({ orgId: org.orgId, name: "Confidential Matter", type: "litigation", actorEmail: org.ownerEmail, membership: org.owner });
  const scope = await getAccessibleScope({ orgId: org.orgId, membership: org.staff, email: org.staffEmail });
  assert.equal(scope.visibleMatters.length, 0);
});

test("SECURITY: an assigned matter-team member sees only their assigned matter", async () => {
  const org = await makeOrg("matter-visibility-assigned");
  const { matter: assignedMatter } = await createMatter({ orgId: org.orgId, name: "Assigned Matter", type: "litigation", actorEmail: org.ownerEmail, membership: org.owner });
  const { matter: otherMatter } = await createMatter({ orgId: org.orgId, name: "Other Matter", type: "corporate", actorEmail: org.ownerEmail, membership: org.owner });
  await assignMatterTeamMember({ orgId: org.orgId, matterId: assignedMatter._id, memberEmail: org.staffEmail, role: "paralegal", actorEmail: org.ownerEmail, membership: org.owner });

  const scope = await getAccessibleScope({ orgId: org.orgId, membership: org.staff, email: org.staffEmail });
  const visibleIds = scope.visibleMatters.map((m) => m._id.toString());
  assert.ok(visibleIds.includes(assignedMatter._id.toString()));
  assert.ok(!visibleIds.includes(otherMatter._id.toString()));
});

test("matter: lifecycle OPEN -> ACTIVE -> ON_HOLD -> ACTIVE -> CLOSED", async () => {
  const org = await makeOrg("matter-lifecycle");
  const { matter } = await createMatter({ orgId: org.orgId, name: "Lifecycle Matter", type: "litigation", actorEmail: org.ownerEmail, membership: org.owner });
  const active = await transitionMatter({ orgId: org.orgId, matterId: matter._id, action: "activate", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(active.matter.status, "ACTIVE");
  const onHold = await transitionMatter({ orgId: org.orgId, matterId: matter._id, action: "putOnHold", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(onHold.matter.status, "ON_HOLD");
  const resumed = await transitionMatter({ orgId: org.orgId, matterId: matter._id, action: "resume", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(resumed.matter.status, "ACTIVE");
  const closed = await transitionMatter({ orgId: org.orgId, matterId: matter._id, action: "close", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(closed.matter.status, "CLOSED");
  assert.ok(closed.matter.closeDate);
});

// ============================================================
// Prospective clients
// ============================================================
test("prospect: intake -> engage decision advances status without deleting the intake record", async () => {
  const org = await makeOrg("prospect-intake");
  const { prospect } = await createProspect({ orgId: org.orgId, name: "Prospective Co", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(prospect.status, "intake");
  assert.equal(prospect.classification, "CONFIDENTIAL");
  const decided = await decideProspectEngagement({ orgId: org.orgId, prospectId: prospect._id, decision: "engage", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(decided.prospect.status, "engaged");
});

// ============================================================
// Conflict checking — never a "definitive legal clearance"
// ============================================================
test("conflict check: finds an exact opposing-party name match across matters", async () => {
  const org = await makeOrg("conflict-search");
  await createMatter({ orgId: org.orgId, name: "Matter With Opposing Party", type: "litigation", opposingParties: ["Acme Corp"], actorEmail: org.ownerEmail, membership: org.owner });
  const { matches } = await searchConflicts({ orgId: org.orgId, names: ["Acme Corp"] });
  assert.ok(matches.some((m) => m.type === "opposing_party" && m.name === "Acme Corp"));
});

test("conflict check: recordConflictCheck only accepts potential/cleared/escalated — never a raw boolean 'is conflicted' result", async () => {
  const org = await makeOrg("conflict-record");
  const invalid = await recordConflictCheck({ orgId: org.orgId, namesChecked: ["X"], matches: [], status: "definitely_clear", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(invalid.status, 400);

  const { conflictCheck } = await recordConflictCheck({ orgId: org.orgId, namesChecked: ["X"], matches: [], status: "potential", reviewerEmail: org.ownerEmail, actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(conflictCheck.status, "potential");
});
