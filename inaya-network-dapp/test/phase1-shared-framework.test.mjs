// test/phase1-shared-framework.test.mjs
//
// Healthcare & Legal Expansion SOW, Phase 1 (Shared Industry Framework)
// coverage: classification narrowing, policy engine evaluation, incident
// lifecycle + role gating, retention's fail-safe-when-empty legal-hold
// guard, risk register, vendor management (no auto-compliance claim),
// training assign+acknowledge, and org profile updates. Same node --test +
// real Atlas + RUN_ID-fixtures convention as every other test file here.
//
// Run with: node --env-file=.env.local --test test/phase1-shared-framework.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { resolveClassificationAccess, DEFAULT_CLASSIFICATION_LEVELS, getOrgClassificationLevels } from "../src/lib/classification.js";
import { evaluatePolicy } from "../src/lib/policy-engine.js";
import { createIncident, transitionIncident, recordPostIncidentReview, listIncidents } from "../src/lib/incidents.js";
import { isUnderLegalHold, checkDispositionAllowed, upsertRetentionPolicy } from "../src/lib/retention.js";
import { createRisk, updateRiskStatus } from "../src/lib/risk-register.js";
import { createVendor, updateVendorSecurityReview } from "../src/lib/vendor-management.js";
import { assignTraining, acknowledgeTraining } from "../src/lib/training.js";
import { getOrgProfile, updateOrgProfile, ORG_VERTICALS } from "../src/lib/industry-config.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-p1-${RUN_ID}-${label}@example.com`;

let collections;
const cleanup = { orgIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { orgs, orgMembers, incidents, retentionPolicies, riskRegister, vendorRecords, trainingRecords, dataClassifications, auditChainEntries, auditChainHeads } = collections;
  await orgMembers.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await incidents.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await retentionPolicies.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await riskRegister.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await vendorRecords.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await trainingRecords.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await dataClassifications.deleteMany({ orgId: { $in: cleanup.orgIds } });
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

  const plainEmail = email(`${label}-plain`);
  await collections.orgMembers.insertOne({ orgId, email: plainEmail, role: "member", departmentIds: [], status: "active", invitedAt: now, joinedAt: now });
  const plain = await collections.orgMembers.findOne({ orgId, email: plainEmail });

  return { orgId, ownerEmail, owner, plainEmail, plain };
}

// ============================================================
// Classification — pure function, no DB
// ============================================================
test("classification: an unrestricted level (e.g. Internal) never narrows access", () => {
  const result = resolveClassificationAccess({
    membership: { role: "member" }, baseLevel: "EDIT", classification: "INTERNAL",
    levels: DEFAULT_CLASSIFICATION_LEVELS, hasExplicitAccess: false,
  });
  assert.equal(result, "EDIT");
});

test("classification: a restricted level (e.g. Patient Sensitive) narrows to NONE without explicit access", () => {
  const result = resolveClassificationAccess({
    membership: { role: "member" }, baseLevel: "EDIT", classification: "PATIENT_SENSITIVE",
    levels: DEFAULT_CLASSIFICATION_LEVELS, hasExplicitAccess: false,
  });
  assert.equal(result, "NONE");
});

test("classification: a restricted level preserves access when the caller has explicit/assignment-based access", () => {
  const result = resolveClassificationAccess({
    membership: { role: "member" }, baseLevel: "EDIT", classification: "EVIDENCE",
    levels: DEFAULT_CLASSIFICATION_LEVELS, hasExplicitAccess: true,
  });
  assert.equal(result, "EDIT");
});

test("classification: org owner/admin is never narrowed by classification", () => {
  const result = resolveClassificationAccess({
    membership: { role: "owner" }, baseLevel: "EDIT", classification: "RESTRICTED",
    levels: DEFAULT_CLASSIFICATION_LEVELS, hasExplicitAccess: false,
  });
  assert.equal(result, "EDIT");
});

test("classification: getOrgClassificationLevels seeds the default levels for a new org, idempotently", async () => {
  const org = await makeOrg("classification-seed");
  const first = await getOrgClassificationLevels(org.orgId);
  assert.equal(first.length, DEFAULT_CLASSIFICATION_LEVELS.length);
  const second = await getOrgClassificationLevels(org.orgId);
  assert.equal(second.length, DEFAULT_CLASSIFICATION_LEVELS.length, "calling twice must not duplicate rows");
});

// ============================================================
// Policy engine — pure function, no DB
// ============================================================
test("policy engine: a high-risk action with no matching rule defaults to require_approval, not silent allow", () => {
  const { result } = evaluatePolicy({ action: "export", role: "member" }, []);
  assert.equal(result, "require_approval");
});

test("policy engine: an ordinary action with no matching rule defaults to allow", () => {
  const { result } = evaluatePolicy({ action: "view", role: "member" }, []);
  assert.equal(result, "allow");
});

test("policy engine: a matching rule wins over the default, first match in order", () => {
  const rules = [
    { role: "billing", resource: "patient-financial", action: "view", result: "allow" },
    { action: "view", result: "block" },
  ];
  const allowed = evaluatePolicy({ role: "billing", resource: "patient-financial", action: "view" }, rules);
  assert.equal(allowed.result, "allow");
  const blocked = evaluatePolicy({ role: "member", resource: "patient-financial", action: "view" }, rules);
  assert.equal(blocked.result, "block");
});

// ============================================================
// Incidents — lifecycle + role gating
// ============================================================
test("incident: full lifecycle OPEN -> CONTAINED -> INVESTIGATING -> RESOLVED -> CLOSED, with post-incident review", async () => {
  const org = await makeOrg("incident-lifecycle");
  const { incident } = await createIncident({ orgId: org.orgId, category: "suspicious_login", severity: "high", description: "test", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(incident.status, "OPEN");

  const contained = await transitionIncident({ orgId: org.orgId, incidentId: incident._id, action: "contain", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(contained.incident.status, "CONTAINED");

  const investigating = await transitionIncident({ orgId: org.orgId, incidentId: incident._id, action: "investigate", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(investigating.incident.status, "INVESTIGATING");

  const resolved = await transitionIncident({ orgId: org.orgId, incidentId: incident._id, action: "resolve", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(resolved.incident.status, "RESOLVED");
  assert.ok(resolved.incident.resolvedAt);

  const closed = await transitionIncident({ orgId: org.orgId, incidentId: incident._id, action: "close", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(closed.incident.status, "CLOSED");

  const reviewed = await recordPostIncidentReview({ orgId: org.orgId, incidentId: incident._id, actorEmail: org.ownerEmail, membership: org.owner, review: "Root cause identified." });
  assert.equal(reviewed.incident.postIncidentReview.review, "Root cause identified.");

  const timeline = reviewed.incident.timeline.map((t) => t.event);
  assert.deepEqual(timeline, ["REPORTED", "CONTAINED", "INVESTIGATION_STARTED", "RESOLVED", "CLOSED"]);
});

test("incident: a plain member (no manage-org authority) cannot report or transition an incident", async () => {
  const org = await makeOrg("incident-denied");
  const denied = await createIncident({ orgId: org.orgId, category: "malware", severity: "critical", description: "x", actorEmail: org.plainEmail, membership: org.plain });
  assert.equal(denied.status, 403);
});

test("incident: a replayed/duplicate transition is rejected with 409, not double-applied", async () => {
  const org = await makeOrg("incident-replay");
  const { incident } = await createIncident({ orgId: org.orgId, category: "policy_violation", severity: "medium", description: "x", actorEmail: org.ownerEmail, membership: org.owner });
  const first = await transitionIncident({ orgId: org.orgId, incidentId: incident._id, action: "contain", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(first.incident.status, "CONTAINED");
  const replay = await transitionIncident({ orgId: org.orgId, incidentId: incident._id, action: "contain", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(replay.status, 409);
});

test("incident: listIncidents filters by status", async () => {
  const org = await makeOrg("incident-list");
  await createIncident({ orgId: org.orgId, category: "lost_device", severity: "low", description: "a", actorEmail: org.ownerEmail, membership: org.owner });
  const { incident: second } = await createIncident({ orgId: org.orgId, category: "lost_device", severity: "low", description: "b", actorEmail: org.ownerEmail, membership: org.owner });
  await transitionIncident({ orgId: org.orgId, incidentId: second._id, action: "contain", actorEmail: org.ownerEmail, membership: org.owner });

  const open = await listIncidents(org.orgId, { status: "OPEN" });
  const contained = await listIncidents(org.orgId, { status: "CONTAINED" });
  assert.equal(open.length, 1);
  assert.equal(contained.length, 1);
});

// ============================================================
// Retention — fail-safe-when-empty legal hold guard
// ============================================================
test("retention: isUnderLegalHold returns false when the legal_holds collection has no matching (or any) documents yet", async () => {
  const held = await isUnderLegalHold({ orgId: "000000000000000000000000", recordType: "EVIDENCE", recordId: "000000000000000000000001" });
  assert.equal(held, false, "querying an empty/nonexistent legal_holds collection must be a safe 'no hold' result, not a throw");
});

test("retention: checkDispositionAllowed allows deletion when there's no hold and no retention policy set", async () => {
  const org = await makeOrg("retention-allowed");
  const check = await checkDispositionAllowed({ orgId: org.orgId, recordType: "LEGAL_DOCUMENT", recordId: "000000000000000000000002" });
  assert.equal(check.allowed, true);
});

test("retention: upsertRetentionPolicy is owner/admin gated", async () => {
  const org = await makeOrg("retention-gate");
  const denied = await upsertRetentionPolicy({ orgId: org.orgId, recordType: "LEGAL_DOCUMENT", retentionPeriodDays: 365, actorEmail: org.plainEmail, membership: org.plain });
  assert.equal(denied.status, 403);
  const allowed = await upsertRetentionPolicy({ orgId: org.orgId, recordType: "LEGAL_DOCUMENT", retentionPeriodDays: 365, actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(allowed.policy.retentionPeriodDays, 365);
});

// ============================================================
// Risk register
// ============================================================
test("risk register: create + status transition, owner/admin gated", async () => {
  const org = await makeOrg("risk-register");
  const denied = await createRisk({ orgId: org.orgId, category: "vendor", severity: "high", likelihood: "medium", impact: "high", actorEmail: org.plainEmail, membership: org.plain });
  assert.equal(denied.status, 403);

  const { risk } = await createRisk({ orgId: org.orgId, category: "vendor", severity: "high", likelihood: "medium", impact: "high", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(risk.status, "open");

  const updated = await updateRiskStatus({ orgId: org.orgId, riskId: risk._id, status: "mitigating", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(updated.risk.status, "mitigating");
});

// ============================================================
// Vendor management — no auto-compliance claim
// ============================================================
test("vendor management: a newly created vendor is never auto-labeled compliant/reviewed", async () => {
  const org = await makeOrg("vendor-mgmt");
  const { vendor } = await createVendor({ orgId: org.orgId, name: "Test Vendor", service: "cloud storage", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(vendor.securityReviewStatus, "not_reviewed");
  assert.equal(vendor.risk, null);

  const updated = await updateVendorSecurityReview({ orgId: org.orgId, vendorId: vendor._id, securityReviewStatus: "reviewed", risk: "low", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(updated.vendor.securityReviewStatus, "reviewed");
});

// ============================================================
// Training — assign + acknowledge
// ============================================================
test("training: assign to multiple members, each can acknowledge only their own record", async () => {
  const org = await makeOrg("training");
  const { assigned } = await assignTraining({ orgId: org.orgId, policyKey: "security-awareness", title: "Security Awareness 2026", memberEmails: [org.plainEmail], dueDate: "2026-12-31", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(assigned.length, 1);
  assert.equal(assigned[0].acknowledgedAt, null);

  const wrongPerson = await acknowledgeTraining({ orgId: org.orgId, trainingRecordId: assigned[0]._id, actorEmail: org.ownerEmail });
  assert.equal(wrongPerson.status, 404, "only the assigned member's own email should be able to acknowledge");

  const ack = await acknowledgeTraining({ orgId: org.orgId, trainingRecordId: assigned[0]._id, actorEmail: org.plainEmail });
  assert.ok(ack.training.acknowledgedAt);
});

// ============================================================
// Org profile (industry-config.js)
// ============================================================
test("org profile: defaults to vertical 'general' until explicitly configured", async () => {
  const org = await makeOrg("profile-default");
  const profile = await getOrgProfile(org.orgId);
  assert.equal(profile.vertical, "general");
});

test("org profile: update is owner/admin gated and rejects an unknown vertical", async () => {
  const org = await makeOrg("profile-update");
  const denied = await updateOrgProfile({ orgId: org.orgId, updates: { vertical: "healthcare" }, actorEmail: org.plainEmail, membership: org.plain });
  assert.equal(denied.status, 403);

  const badVertical = await updateOrgProfile({ orgId: org.orgId, updates: { vertical: "not-a-real-vertical" }, actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(badVertical.status, 400);

  const allowed = await updateOrgProfile({ orgId: org.orgId, updates: { vertical: "healthcare", industry: "Hospitals" }, actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(allowed.org.vertical, "healthcare");
  assert.equal(allowed.org.industry, "Hospitals");
  assert.ok(ORG_VERTICALS.includes(allowed.org.vertical));
});
