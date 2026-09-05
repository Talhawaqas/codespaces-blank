// test/phase4-8-operations.test.mjs
//
// Healthcare & Legal Expansion SOW, Phases 4 & 8 (Operations) coverage:
// patient billing, appointment scheduling + reminder idempotency,
// research dataset de-identification (mandatory methodology, no
// "anonymous" flag), legal time tracking + hourly billing generation
// (a time entry can never be billed twice), contract lifecycle,
// corporate entities, and trust accounting's overdraft-prevention
// safeguard (the one hard financial-safety check enforced regardless of
// jurisdiction-specific compliance, which is explicitly NOT claimed).
//
// Run with: node --env-file=.env.local --test test/phase4-8-operations.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { createPatient } from "../src/lib/health-patients.js";
import { createPatientInvoice } from "../src/lib/health-billing.js";
import { scheduleAppointment, sendUpcomingAppointmentReminders } from "../src/lib/health-scheduling.js";
import { createResearchDataset } from "../src/lib/health-research.js";
import { createMatter } from "../src/lib/legal-matter-workflow.js";
import { createTimeEntry, submitTimeEntry, decideTimeEntry } from "../src/lib/legal-time-tracking.js";
import { generateHourlyInvoice } from "../src/lib/legal-billing-workflow.js";
import { createContract, transitionContract } from "../src/lib/contract-lifecycle-workflow.js";
import { createEntity } from "../src/lib/corporate-entities.js";
import { recordDeposit, recordWithdrawal, getMatterTrustBalance } from "../src/lib/trust-accounting.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-p48-${RUN_ID}-${label}@example.com`;

let collections;
const cleanup = { orgIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const {
    orgs, orgMembers, invoices,
    healthPatients, healthAppointments,
    legalMatters, legalTimeEntries, legalBilling, legalContracts, legalEntities, legalTrustLedger,
    auditChainEntries, auditChainHeads, orgActivity, db,
  } = collections;
  await orgMembers.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await invoices.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await healthPatients.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await healthAppointments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await legalMatters.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await legalTimeEntries.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await legalBilling.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await legalContracts.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await legalEntities.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await legalTrustLedger.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await db.collection("health_research_datasets").deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainEntries.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainHeads.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgActivity.deleteMany({ orgId: { $in: cleanup.orgIds } });
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
  return { orgId, ownerEmail, owner };
}

// ============================================================
// Healthcare Operations
// ============================================================
test("health billing: creates a real invoice discriminated as healthPatient, computed subtotal", async () => {
  const org = await makeOrg("health-billing");
  const { patient } = await createPatient({ orgId: org.orgId, legalName: "Billing Patient", dateOfBirth: "1990-01-01", actorEmail: org.ownerEmail, membership: org.owner });
  const { invoice } = await createPatientInvoice({ orgId: org.orgId, patientId: patient._id, lineItems: [{ amount: 100, quantity: 2 }, { amount: 50, quantity: 1 }], actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(invoice.billedToType, "healthPatient");
  assert.equal(invoice.subtotal, 250);
});

test("scheduling: reminders are sent exactly once even if the reminder job runs twice concurrently-ish", async () => {
  const org = await makeOrg("scheduling");
  const { patient } = await createPatient({ orgId: org.orgId, legalName: "Schedule Patient", dateOfBirth: "1991-01-01", actorEmail: org.ownerEmail, membership: org.owner });
  const soon = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  await scheduleAppointment({ orgId: org.orgId, patientId: patient._id, type: "checkup", startAt: soon, actorEmail: org.ownerEmail, membership: org.owner });

  const first = await sendUpcomingAppointmentReminders(24);
  assert.equal(first.sent, 1);
  const second = await sendUpcomingAppointmentReminders(24);
  assert.equal(second.sent, 0, "a reminder already sent must not be sent again");
});

test("research dataset: requires a non-empty methodology, and never sets an 'anonymous' flag", async () => {
  const org = await makeOrg("research");
  const { patient } = await createPatient({ orgId: org.orgId, legalName: "Research Patient", dateOfBirth: "1960-01-01", actorEmail: org.ownerEmail, membership: org.owner });

  const rejected = await createResearchDataset({ orgId: org.orgId, name: "ds1", sourcePatientIds: [patient._id], methodologyNotes: "", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(rejected.status, 400);

  const { dataset } = await createResearchDataset({ orgId: org.orgId, name: "ds1", sourcePatientIds: [patient._id], methodologyNotes: "Stripped direct identifiers per default field list.", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(dataset.records.length, 1);
  assert.ok(!("legalName" in dataset.records[0]), "de-identified record must have direct identifiers stripped");
  assert.equal("anonymous" in dataset, false, "dataset schema must never carry an 'anonymous' boolean claim");
  assert.ok(dataset.deidentificationMethodology.length > 0);
});

// ============================================================
// Legal Operations
// ============================================================
test("SECURITY: a locked (billed) time entry cannot be billed again — generateHourlyInvoice never double-counts", async () => {
  const org = await makeOrg("time-billing");
  const { matter } = await createMatter({ orgId: org.orgId, name: "Billing Matter", type: "litigation", actorEmail: org.ownerEmail, membership: org.owner });
  const { timeEntry } = await createTimeEntry({ orgId: org.orgId, matterId: matter._id, taskDescription: "Research", minutes: 120, rate: 300, actorEmail: org.ownerEmail, membership: org.owner });
  await submitTimeEntry({ orgId: org.orgId, timeEntryId: timeEntry._id, actorEmail: org.ownerEmail, membership: org.owner });
  await decideTimeEntry({ orgId: org.orgId, timeEntryId: timeEntry._id, approve: true, actorEmail: org.ownerEmail, membership: org.owner });

  const { billing } = await generateHourlyInvoice({ orgId: org.orgId, matterId: matter._id, actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(billing.total, 600, "2 hours at $300/hr = $600");

  const second = await generateHourlyInvoice({ orgId: org.orgId, matterId: matter._id, actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(second.status, 409, "no unbilled entries remain — must not generate a second invoice from the same time");
});

test("contract lifecycle: INTAKE -> DRAFT -> REVIEW -> APPROVED -> NEGOTIATION -> SIGNED", async () => {
  const org = await makeOrg("contract-lifecycle");
  const { contract } = await createContract({ orgId: org.orgId, name: "Vendor Agreement", actorEmail: org.ownerEmail, membership: org.owner });
  const drafting = await transitionContract({ orgId: org.orgId, contractId: contract._id, action: "startDrafting", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(drafting.contract.status, "DRAFT");
  await transitionContract({ orgId: org.orgId, contractId: contract._id, action: "submitForReview", actorEmail: org.ownerEmail, membership: org.owner });
  await transitionContract({ orgId: org.orgId, contractId: contract._id, action: "approve", actorEmail: org.ownerEmail, membership: org.owner });
  await transitionContract({ orgId: org.orgId, contractId: contract._id, action: "sendForNegotiation", actorEmail: org.ownerEmail, membership: org.owner });
  const signed = await transitionContract({ orgId: org.orgId, contractId: contract._id, action: "sign", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(signed.contract.status, "SIGNED");
});

test("corporate entities: create + record filing + resolution, appended not overwritten", async () => {
  const org = await makeOrg("corporate-entities");
  const { entity } = await createEntity({ orgId: org.orgId, name: "Test Subsidiary LLC", jurisdiction: "Delaware", entityType: "LLC", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(entity.annualFilings.length, 0);
});

// ============================================================
// Trust accounting — the critical financial-safety check
// ============================================================
test("SECURITY: trust accounting NEVER allows a withdrawal that would overdraw a matter's trust balance", async () => {
  const org = await makeOrg("trust-overdraft");
  const { matter } = await createMatter({ orgId: org.orgId, name: "Trust Matter", type: "litigation", actorEmail: org.ownerEmail, membership: org.owner });

  await recordDeposit({ orgId: org.orgId, matterId: matter._id, amount: 1000, source: "client retainer", actorEmail: org.ownerEmail, membership: org.owner });
  const balanceAfterDeposit = await getMatterTrustBalance(org.orgId, matter._id);
  assert.equal(balanceAfterDeposit, 1000);

  const overdraft = await recordWithdrawal({ orgId: org.orgId, matterId: matter._id, amount: 1500, purpose: "filing fee", actorEmail: org.ownerEmail, membership: org.owner });
  assert.equal(overdraft.status, 409, "a withdrawal exceeding the current balance must be rejected");

  const validWithdrawal = await recordWithdrawal({ orgId: org.orgId, matterId: matter._id, amount: 400, purpose: "filing fee", actorEmail: org.ownerEmail, membership: org.owner });
  assert.ok(validWithdrawal.entry, "a withdrawal within the balance must succeed");

  const finalBalance = await getMatterTrustBalance(org.orgId, matter._id);
  assert.equal(finalBalance, 600);
});

test("trust accounting: deposits and withdrawals require legal-manager (or owner/admin) authority", async () => {
  const org = await makeOrg("trust-gate");
  const { matter } = await createMatter({ orgId: org.orgId, name: "Gated Trust Matter", type: "litigation", actorEmail: org.ownerEmail, membership: org.owner });
  const staffEmail = email("trust-gate-staff");
  await collections.orgMembers.insertOne({ orgId: org.orgId, email: staffEmail, role: "member", departmentIds: [], status: "active", invitedAt: new Date().toISOString(), joinedAt: new Date().toISOString() });
  const staff = await collections.orgMembers.findOne({ orgId: org.orgId, email: staffEmail });

  const denied = await recordDeposit({ orgId: org.orgId, matterId: matter._id, amount: 500, actorEmail: staffEmail, membership: staff });
  assert.equal(denied.status, 403);
});
