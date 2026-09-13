// test/financial-attestation.test.mjs
//
// Four High-Impact Business Workspace Extensions SOW — Feature 4:
// Cryptographic Financial Attestation (explicitly NOT zero-knowledge — see
// financial-attestation.js's header comment). Covers the SOW §35 security
// list: cross-org generation, changed-dataset invalidation, incorrect
// statements failing, unsupported statement types failing, and the
// verifier never leaking underlying records.
//
// Run with: node --env-file=.env.local --test test/financial-attestation.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { generateAttestation, verifyAttestation, UNSUPPORTED_STATEMENT_TYPES } from "../src/lib/financial-attestation.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-attest-${RUN_ID}-${label}@example.com`;
const cleanup = { orgIds: [] };
let collections;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { orgs, orgMembers, departments, invoices, expenses, financialAttestations, orgActivity, auditChainEntries, auditChainHeads } = collections;
  await orgMembers.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await departments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await invoices.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await expenses.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await financialAttestations.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgActivity.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainEntries.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainHeads.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

async function makeOrgWithRevenue(label, paidAmounts) {
  const now = new Date().toISOString();
  const ownerEmail = email(`${label}-owner`);
  const orgResult = await collections.orgs.insertOne({ name: `${label} Co`, ownerEmail, createdAt: now });
  cleanup.orgIds.push(orgResult.insertedId);
  const orgId = orgResult.insertedId;
  const deptResult = await collections.departments.insertOne({ orgId, name: "Ops", createdAt: now });
  await collections.orgMembers.insertOne({ orgId, email: ownerEmail, role: "owner", departmentIds: [], status: "active", invitedAt: now, joinedAt: now });
  const owner = await collections.orgMembers.findOne({ orgId, email: ownerEmail });

  const invoiceIds = [];
  for (const amount of paidAmounts) {
    const base = {
      orgId, departmentId: deptResult.insertedId, contactId: orgId, invoiceNumber: `INV-${randomUUID().slice(0, 6)}`,
      issueDate: daysAgo(5), dueDate: daysAgo(5), lineItems: [], subtotal: amount, total: amount, currency: "USD",
      status: "PAID", createdByEmail: ownerEmail, createdAt: daysAgo(5), updatedAt: daysAgo(5), deletedAt: null,
    };
    const r = await collections.invoices.insertOne(base);
    invoiceIds.push(r.insertedId);
  }

  return { orgId, owner, ownerEmail, deptId: deptResult.insertedId, invoiceIds };
}

const PERIOD = { startDate: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), endDate: new Date().toISOString() };

test("end-to-end: a real revenue-threshold attestation is generated and independently verifies VALID", async () => {
  const fx = await makeOrgWithRevenue("e2e", [500, 300]);
  const gen = await generateAttestation({ orgId: fx.orgId, statementType: "revenue_threshold", startDate: PERIOD.startDate, endDate: PERIOD.endDate, threshold: 700, membership: fx.owner, actorEmail: fx.ownerEmail });
  assert.equal(gen.result, "SATISFIED", "800 total >= 700 threshold");
  assert.ok(gen.datasetCommitment.startsWith("0x"));

  const verification = await verifyAttestation({ orgId: fx.orgId, attestationId: gen.attestationId, membership: fx.owner, actorEmail: fx.ownerEmail });
  assert.equal(verification.verificationResult, "VALID");
});

test("VALIDATION: an incorrect statement (threshold not met) reports NOT_SATISFIED, never falsely SATISFIED", async () => {
  const fx = await makeOrgWithRevenue("not-satisfied", [100]);
  const gen = await generateAttestation({ orgId: fx.orgId, statementType: "revenue_threshold", startDate: PERIOD.startDate, endDate: PERIOD.endDate, threshold: 10000, membership: fx.owner, actorEmail: fx.ownerEmail });
  assert.equal(gen.result, "NOT_SATISFIED");
});

test("SECURITY: a changed dataset after generation invalidates the commitment on re-verification", async () => {
  const fx = await makeOrgWithRevenue("tamper", [400]);
  const gen = await generateAttestation({ orgId: fx.orgId, statementType: "revenue_threshold", startDate: PERIOD.startDate, endDate: PERIOD.endDate, threshold: 100, membership: fx.owner, actorEmail: fx.ownerEmail });
  assert.equal(gen.result, "SATISFIED");

  // The underlying invoice is edited AFTER the attestation was generated.
  await collections.invoices.updateOne({ _id: fx.invoiceIds[0] }, { $set: { total: 999999 } });

  const verification = await verifyAttestation({ orgId: fx.orgId, attestationId: gen.attestationId, membership: fx.owner, actorEmail: fx.ownerEmail });
  assert.equal(verification.verificationResult, "INVALID", "a changed underlying record must invalidate the commitment");
});

test("SECURITY: a new qualifying invoice added inside the committed period invalidates the commitment", async () => {
  const fx = await makeOrgWithRevenue("new-record", [200]);
  const gen = await generateAttestation({ orgId: fx.orgId, statementType: "revenue_threshold", startDate: PERIOD.startDate, endDate: PERIOD.endDate, threshold: 100, membership: fx.owner, actorEmail: fx.ownerEmail });

  await collections.invoices.insertOne({
    orgId: fx.orgId, departmentId: fx.deptId, contactId: fx.orgId, invoiceNumber: `INV-${randomUUID().slice(0, 6)}`,
    issueDate: daysAgo(3), dueDate: daysAgo(3), lineItems: [], subtotal: 50, total: 50, currency: "USD",
    status: "PAID", createdByEmail: fx.ownerEmail, createdAt: daysAgo(3), updatedAt: daysAgo(3), deletedAt: null,
  });

  const verification = await verifyAttestation({ orgId: fx.orgId, attestationId: gen.attestationId, membership: fx.owner, actorEmail: fx.ownerEmail });
  assert.equal(verification.verificationResult, "INVALID");
});

test("HONESTY: an unsupported statement type (solvency_threshold) is explicitly rejected, never fabricated", async () => {
  const fx = await makeOrgWithRevenue("unsupported", [100]);
  assert.ok(UNSUPPORTED_STATEMENT_TYPES.includes("solvency_threshold"));
  const gen = await generateAttestation({ orgId: fx.orgId, statementType: "solvency_threshold", startDate: PERIOD.startDate, endDate: PERIOD.endDate, threshold: 100, membership: fx.owner, actorEmail: fx.ownerEmail });
  assert.equal(gen.status, 400);
});

test("SECURITY: cross-org isolation -- an attestation cannot be verified under the wrong org", async () => {
  const fxA = await makeOrgWithRevenue("cross-a", [500]);
  const fxB = await makeOrgWithRevenue("cross-b", [10]);
  const gen = await generateAttestation({ orgId: fxA.orgId, statementType: "revenue_threshold", startDate: PERIOD.startDate, endDate: PERIOD.endDate, threshold: 100, membership: fxA.owner, actorEmail: fxA.ownerEmail });

  const result = await verifyAttestation({ orgId: fxB.orgId, attestationId: gen.attestationId, membership: fxB.owner, actorEmail: fxB.ownerEmail });
  assert.equal(result.status, 404, "the attestation doesn't exist under org B's scope");
});

test("PRIVACY: the verifier response never includes underlying invoice records or amounts", async () => {
  const fx = await makeOrgWithRevenue("privacy", [500]);
  const gen = await generateAttestation({ orgId: fx.orgId, statementType: "revenue_threshold", startDate: PERIOD.startDate, endDate: PERIOD.endDate, threshold: 100, membership: fx.owner, actorEmail: fx.ownerEmail });
  const verification = await verifyAttestation({ orgId: fx.orgId, attestationId: gen.attestationId, membership: fx.owner, actorEmail: fx.ownerEmail });

  const serialized = JSON.stringify(verification);
  assert.ok(!serialized.includes(fx.invoiceIds[0].toString()), "must never leak an underlying invoice's own record id");
  assert.equal(verification.computedTotal, undefined, "the raw total must never be exposed by the verifier");
});
