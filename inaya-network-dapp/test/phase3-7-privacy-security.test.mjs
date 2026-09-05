// test/phase3-7-privacy-security.test.mjs
//
// Healthcare & Legal Expansion SOW, Phases 3 & 7 (Privacy/Security,
// Evidence & Litigation) coverage — the two phases that are literally
// about security. Covers: consent record/withdraw/active-check,
// break-glass grant + REAL EXPIRY ENFORCEMENT (a bug caught and fixed
// during this implementation — a break-glass grant with no expiry check
// in getAccessibleScope() would never actually stop granting access),
// legal holds actually blocking disposition via retention.js's
// checkDispositionAllowed, hold notice/acknowledge/exception/release
// lifecycle, and evidence chain-of-custody recording.
//
// Run with: node --env-file=.env.local --test test/phase3-7-privacy-security.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { getAccessibleScope } from "../src/lib/document-permissions.js";
import { createPatient } from "../src/lib/health-patients.js";
import { recordConsent, withdrawConsent, hasActiveConsent } from "../src/lib/health-consent-workflow.js";
import { requestReleaseOfInformation, authorizeReleaseOfInformation, reviewReleaseOfInformation } from "../src/lib/health-roi-workflow.js";
import { grantBreakGlassAccess, listUnreviewedBreakGlassGrants, reviewBreakGlassGrant } from "../src/lib/health-breakglass.js";
import { createMatter } from "../src/lib/legal-matter-workflow.js";
import { acquireEvidence, transferEvidence } from "../src/lib/legal-evidence.js";
import { listCustodyEvents } from "../src/lib/legal-custody.js";
import { createLegalHold, acknowledgeLegalHold, recordHoldException, releaseLegalHold } from "../src/lib/legal-hold-workflow.js";
import { checkDispositionAllowed } from "../src/lib/retention.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-p37-${RUN_ID}-${label}@example.com`;

let collections;
const cleanup = { orgIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const {
    orgs, orgMembers,
    healthPatients, healthCareTeamAssignments, healthConsents, healthRoiRequests, exportRequests,
    legalMatters, legalEvidence, legalChainEvents, legalHolds,
    auditChainEntries, auditChainHeads,
  } = collections;
  await orgMembers.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await healthPatients.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await healthCareTeamAssignments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await healthConsents.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await healthRoiRequests.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await exportRequests.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await legalMatters.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await legalEvidence.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await legalChainEvents.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await legalHolds.deleteMany({ orgId: { $in: cleanup.orgIds } });
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

  const staffEmail = email(`${label}-staff`);
  await collections.orgMembers.insertOne({ orgId, email: staffEmail, role: "member", departmentIds: [], status: "active", invitedAt: now, joinedAt: now });
  const staff = await collections.orgMembers.findOne({ orgId, email: staffEmail });

  return { orgId, ownerEmail, owner, staffEmail, staff };
}

// ============================================================
// Consent
// ============================================================
test("consent: record -> hasActiveConsent true -> withdraw -> hasActiveConsent false", async () => {
  const org = await makeOrg("consent");
  const { patient } = await createPatient({ orgId: org.orgId, legalName: "Consent Patient", dateOfBirth: "1988-01-01", actorEmail: org.ownerEmail, membership: org.owner });
  const { consent } = await recordConsent({ orgId: org.orgId, patientId: patient._id, type: "treatment", purpose: "general_care", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(consent.status, "ACTIVE");

  const activeBeforeWithdraw = await hasActiveConsent({ orgId: org.orgId, patientId: patient._id, type: "treatment", purpose: "general_care" });
  assert.equal(activeBeforeWithdraw, true);

  await withdrawConsent({ orgId: org.orgId, consentId: consent._id, actorEmail: org.ownerEmail, membership: org.owner });
  const activeAfterWithdraw = await hasActiveConsent({ orgId: org.orgId, patientId: patient._id, type: "treatment", purpose: "general_care" });
  assert.equal(activeAfterWithdraw, false, "a withdrawn consent must not read as active");
});

test("consent: hasActiveConsent fails closed (false) when no consent record exists at all", async () => {
  const org = await makeOrg("consent-absent");
  const active = await hasActiveConsent({ orgId: org.orgId, patientId: "000000000000000000000099", type: "research", purpose: "study" });
  assert.equal(active, false);
});

// ============================================================
// Release of Information (ROI)
// ============================================================
test("ROI: request -> authorize -> approve creates a linked, real export request", async () => {
  const org = await makeOrg("roi");
  const { patient } = await createPatient({ orgId: org.orgId, legalName: "ROI Patient", dateOfBirth: "1977-02-02", actorEmail: org.ownerEmail, membership: org.owner });
  const { roiRequest } = await requestReleaseOfInformation({ orgId: org.orgId, patientId: patient._id, requestedRecordIds: [], purpose: "insurance claim", recipient: { name: "Acme Insurance" }, actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(roiRequest.status, "REQUESTED");

  const authorized = await authorizeReleaseOfInformation({ orgId: org.orgId, roiRequestId: roiRequest._id, actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(authorized.roiRequest.status, "AUTHORIZED");

  const reviewed = await reviewReleaseOfInformation({ orgId: org.orgId, roiRequestId: roiRequest._id, approve: true, actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(reviewed.roiRequest.status, "APPROVED");
  assert.ok(reviewed.roiRequest.exportRequestId, "an approved ROI request must link to a real export_requests row");

  const { exportRequests } = collections;
  const linkedExport = await exportRequests.findOne({ _id: reviewed.roiRequest.exportRequestId });
  assert.equal(linkedExport.status, "APPROVED");
});

test("ROI: a health-role STAFF member can submit a request, but only a health MANAGER (or owner/admin) can authorize or review it", async () => {
  const org = await makeOrg("roi-denied");
  await collections.orgMembers.updateOne({ _id: org.staff._id }, { $set: { healthRole: "staff" } });
  const healthStaff = await collections.orgMembers.findOne({ _id: org.staff._id });

  const { patient } = await createPatient({ orgId: org.orgId, legalName: "ROI Denied Patient", dateOfBirth: "1966-03-03", actorEmail: org.ownerEmail, membership: org.owner });
  const { roiRequest } = await requestReleaseOfInformation({ orgId: org.orgId, patientId: patient._id, requestedRecordIds: [], purpose: "x", actorEmail: org.staffEmail, membership: healthStaff });
  assert.ok(roiRequest, "a health-role staff member must be able to submit a request");

  const denied = await authorizeReleaseOfInformation({ orgId: org.orgId, roiRequestId: roiRequest._id, actorEmail: org.staffEmail, membership: healthStaff });
  assert.equal(denied.status, 403, "staff-tier health role must NOT be able to authorize — only manager/owner/admin");
});

// ============================================================
// Break-glass — the real expiry bug this implementation caught & fixed
// ============================================================
test("SECURITY: break-glass grant gives immediate patient visibility via the ordinary assignment path", async () => {
  const org = await makeOrg("breakglass-grant");
  const { patient } = await createPatient({ orgId: org.orgId, legalName: "BreakGlass Patient", dateOfBirth: "1955-04-04", actorEmail: org.ownerEmail, membership: org.owner });

  const scopeBefore = await getAccessibleScope({ orgId: org.orgId, membership: org.staff, email: org.staffEmail });
  assert.equal(scopeBefore.visiblePatients.length, 0, "no access before break-glass grant");

  await grantBreakGlassAccess({ orgId: org.orgId, patientId: patient._id, actorEmail: org.staffEmail, reason: "Emergency room, patient unresponsive", hours: 4 });

  const scopeAfter = await getAccessibleScope({ orgId: org.orgId, membership: org.staff, email: org.staffEmail });
  assert.equal(scopeAfter.visiblePatients.length, 1, "break-glass grant must immediately grant visibility via the real assignment path");
});

test("SECURITY: an EXPIRED break-glass grant no longer grants visibility (the bug this session caught and fixed)", async () => {
  const org = await makeOrg("breakglass-expiry");
  const { patient } = await createPatient({ orgId: org.orgId, legalName: "Expired Patient", dateOfBirth: "1944-05-05", actorEmail: org.ownerEmail, membership: org.owner });

  // Grant with an expiry already in the past — simulates time having
  // passed since a real grant, without needing the test to sleep.
  await grantBreakGlassAccess({ orgId: org.orgId, patientId: patient._id, actorEmail: org.staffEmail, reason: "test", hours: -1 });

  const scope = await getAccessibleScope({ orgId: org.orgId, membership: org.staff, email: org.staffEmail });
  assert.equal(scope.visiblePatients.length, 0, "an expired break-glass grant must NOT still grant patient visibility");
});

test("break-glass: requires a non-empty reason", async () => {
  const org = await makeOrg("breakglass-reason");
  const { patient } = await createPatient({ orgId: org.orgId, legalName: "Reason Patient", dateOfBirth: "1933-06-06", actorEmail: org.ownerEmail, membership: org.owner });
  const result = await grantBreakGlassAccess({ orgId: org.orgId, patientId: patient._id, actorEmail: org.staffEmail, reason: "   " });
  assert.equal(result.status, 400);
});

test("break-glass: appears in the unreviewed list until explicitly reviewed", async () => {
  const org = await makeOrg("breakglass-review");
  const { patient } = await createPatient({ orgId: org.orgId, legalName: "Review Patient", dateOfBirth: "1922-07-07", actorEmail: org.ownerEmail, membership: org.owner });
  await grantBreakGlassAccess({ orgId: org.orgId, patientId: patient._id, actorEmail: org.staffEmail, reason: "test review" });

  const unreviewed = await listUnreviewedBreakGlassGrants(org.orgId);
  assert.equal(unreviewed.length, 1);

  await reviewBreakGlassGrant({ orgId: org.orgId, assignmentId: unreviewed[0]._id, actorEmail: org.ownerEmail, reviewNotes: "Confirmed legitimate emergency." });
  const afterReview = await listUnreviewedBreakGlassGrants(org.orgId);
  assert.equal(afterReview.length, 0);
});

// ============================================================
// Evidence + chain of custody
// ============================================================
test("evidence: acquisition and transfer both record real, ordered custody events", async () => {
  const org = await makeOrg("evidence-custody");
  const { matter } = await createMatter({ orgId: org.orgId, name: "Evidence Matter", type: "litigation", actorEmail: org.ownerEmail, membership: org.owner });
  const { evidence } = await acquireEvidence({ orgId: org.orgId, matterId: matter._id, source: "seized laptop", hash: "abc123", actorEmail: org.ownerEmail, membership: org.owner });

  await transferEvidence({ orgId: org.orgId, evidenceId: evidence._id, destination: "forensics-lab", reason: "imaging", actorEmail: org.ownerEmail, membership: org.owner });

  const events = await listCustodyEvents(org.orgId, evidence._id);
  const actions = events.map((e) => e.action);
  assert.deepEqual(actions, ["ACQUIRED", "TRANSFERRED"]);
  assert.equal(events[1].destination, "forensics-lab");
});

// ============================================================
// Legal holds — must ACTUALLY block disposition, not just flag it
// ============================================================
test("SECURITY: an active legal hold on a matter blocks disposition of records tied to that matter", async () => {
  const org = await makeOrg("hold-blocks-disposition");
  const { matter } = await createMatter({ orgId: org.orgId, name: "Held Matter", type: "litigation", actorEmail: org.ownerEmail, membership: org.owner });

  const beforeHold = await checkDispositionAllowed({ orgId: org.orgId, recordType: "LEGAL_DOCUMENT", recordId: "000000000000000000000123", matterId: matter._id });
  assert.equal(beforeHold.allowed, true, "no hold yet — deletion should be allowed");

  await createLegalHold({ orgId: org.orgId, matterId: matter._id, scope: "matter", custodianEmails: [org.staffEmail], reason: "Pending litigation", actorEmail: org.ownerEmail, membership: org.owner });

  const afterHold = await checkDispositionAllowed({ orgId: org.orgId, recordType: "LEGAL_DOCUMENT", recordId: "000000000000000000000123", matterId: matter._id });
  assert.equal(afterHold.allowed, false, "an active matter-wide hold must block disposition of records tied to that matter");
  assert.match(afterHold.reason, /legal hold/i);
});

test("legal hold: notice -> acknowledge -> exception -> release lifecycle, and disposition is re-allowed after release", async () => {
  const org = await makeOrg("hold-lifecycle");
  const { matter } = await createMatter({ orgId: org.orgId, name: "Lifecycle Hold Matter", type: "litigation", actorEmail: org.ownerEmail, membership: org.owner });
  const { hold } = await createLegalHold({ orgId: org.orgId, matterId: matter._id, scope: "matter", custodianEmails: [org.staffEmail], reason: "test", actorEmail: org.ownerEmail, membership: org.owner });

  const acked = await acknowledgeLegalHold({ orgId: org.orgId, holdId: hold._id, actorEmail: org.staffEmail });
  assert.equal(acked.hold.acknowledgements.length, 1);

  const excepted = await recordHoldException({ orgId: org.orgId, holdId: hold._id, description: "Irrelevant duplicate", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(excepted.hold.exceptions.length, 1);

  // Staff (no legalRole:manager) cannot release
  const deniedRelease = await releaseLegalHold({ orgId: org.orgId, holdId: hold._id, actorEmail: org.staffEmail, membership: org.staff });
  assert.equal(deniedRelease.status, 403);

  const released = await releaseLegalHold({ orgId: org.orgId, holdId: hold._id, actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(released.hold.status, "RELEASED");

  const afterRelease = await checkDispositionAllowed({ orgId: org.orgId, recordType: "LEGAL_DOCUMENT", recordId: "000000000000000000000456", matterId: matter._id });
  assert.equal(afterRelease.allowed, true, "disposition should be re-allowed once the only hold on this matter is released");
});
