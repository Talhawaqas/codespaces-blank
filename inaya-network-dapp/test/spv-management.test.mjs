// test/spv-management.test.mjs
//
// Financial Services & Regulated Enterprise SOW, Phase 3 (§42) — load-
// bearing correctness property: createSpv() must create a REAL
// financialFunds document (structureType:"spv"), and everything else --
// investors, ownership, capital activity -- must be genuinely usable
// through Phase 1's existing financial-investors.js machinery unmodified.
// This proves spv-management.js didn't fork a parallel investor concept.
//
// Run with: node --env-file=.env.local --test test/spv-management.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { createSpv, recordExpense, linkLegalDocument, getSpv } from "../src/lib/spv-management.js";
import { createInvestor, recordCapitalEvent, getCapitalAccountSummary } from "../src/lib/financial-investors.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `spv-mgmt-${RUN_ID}@example.com`;
const MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
let collections;
let orgId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `SPV Mgmt Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "private_capital", createdAt: now });
  orgId = orgResult.insertedId;
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: orgId }),
    collections.financialFunds.deleteMany({ orgId }),
    collections.financialFundTeamAssignments.deleteMany({ orgId }),
    collections.financialInvestors.deleteMany({ orgId }),
    collections.financialInvestorCommitments.deleteMany({ orgId }),
    collections.spvs.deleteMany({ orgId }),
    collections.orgActivity.deleteMany({ orgId }),
    collections.auditChainEntries.deleteMany({ orgId }),
    collections.auditChainHeads.deleteMany({ orgId }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

test("createSpv() creates a REAL financialFunds document with structureType 'spv', not a parallel entity", async () => {
  const { spv, fund } = await createSpv({ orgId, name: `Project Falcon SPV ${RUN_ID}`, underlyingAsset: "Series C shares of Falcon Robotics", managementFeeBps: 200, carryBps: 2000, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(spv.fundId.toString(), fund._id.toString());

  const storedFund = await collections.financialFunds.findOne({ _id: fund._id });
  assert.equal(storedFund.structureType, "spv");
  assert.equal(storedFund.legalName, `Project Falcon SPV ${RUN_ID}`);

  // Fund-team auto-assignment (Phase 1's createFund() precedent) must
  // apply to an SPV exactly like any other fund -- the creator can see it.
  const assignment = await collections.financialFundTeamAssignments.findOne({ orgId, fundId: fund._id, email: OWNER_EMAIL });
  assert.notEqual(assignment, null);
});

test("an SPV's investors and capital activity are genuinely usable through financial-investors.js unmodified", async () => {
  const { spv, fund } = await createSpv({ orgId, name: `Project Osprey SPV ${RUN_ID}`, underlyingAsset: "Secondary stake in Osprey Inc", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  const { investor } = await createInvestor({ orgId, fundId: fund._id, legalName: `SPV Investor ${RUN_ID}`, entityType: "family_office", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await recordCapitalEvent({ orgId, investorId: investor._id, fundId: fund._id, type: "commitment", amount: 2000000, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await recordCapitalEvent({ orgId, investorId: investor._id, fundId: fund._id, type: "contribution", amount: 2000000, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  const summary = await getCapitalAccountSummary(orgId, investor._id, fund._id);
  assert.equal(summary.totals.commitment, 2000000);
  assert.equal(summary.totals.contribution, 2000000);
  assert.equal(summary.netAssetContributed, 2000000);
});

test("recordExpense() is append-only", async () => {
  const { spv } = await createSpv({ orgId, name: `Project Heron SPV ${RUN_ID}`, underlyingAsset: "Convertible note in Heron Labs", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await recordExpense({ orgId, spvId: spv._id, description: "Legal formation fees", amount: 15000, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { spv: withTwo } = await recordExpense({ orgId, spvId: spv._id, description: "Fund administration", amount: 5000, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(withTwo.expenses.length, 2);
});

test("linkLegalDocument() adds a document ID exactly once even if linked twice (addToSet, not push)", async () => {
  const { spv } = await createSpv({ orgId, name: `Project Kestrel SPV ${RUN_ID}`, underlyingAsset: "Direct equity in Kestrel Corp", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const fakeDocId = spv._id; // any valid ObjectId works for this structural test
  await linkLegalDocument({ orgId, spvId: spv._id, documentId: fakeDocId, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await linkLegalDocument({ orgId, spvId: spv._id, documentId: fakeDocId, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const stored = await getSpv(orgId, spv._id);
  assert.equal(stored.legalDocumentIds.length, 1, "linking the same document twice must not create a duplicate entry");
});

test("createSpv() rejects a missing underlyingAsset", async () => {
  const result = await createSpv({ orgId, name: `No Asset SPV ${RUN_ID}`, underlyingAsset: "", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(result.error !== undefined, true);
  assert.equal(result.status, 400);
});
