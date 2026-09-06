// test/term-sheet.test.mjs
//
// Financial Services & Regulated Enterprise SOW, Phase 3 (§33) — load-
// bearing correctness property: "track negotiation history" is enforced
// the same way investment-thesis.js enforces version history -- a non-
// DRAFT term sheet's content can only change via reviseTermSheet()
// creating a NEW version, never mutated in place.
//
// Run with: node --env-file=.env.local --test test/term-sheet.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { createFund } from "../src/lib/fund-registry.js";
import { createDeal } from "../src/lib/deal-pipeline.js";
import { createTermSheet, updateTermSheetDraft, transitionTermSheet, reviseTermSheet } from "../src/lib/term-sheet.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `term-sheet-${RUN_ID}@example.com`;
const MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
let collections;
let orgId;
let dealId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `Term Sheet Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "private_capital", createdAt: now });
  orgId = orgResult.insertedId;
  const { fund } = await createFund({ orgId, legalName: `TS Fund ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { deal } = await createDeal({ orgId, fundId: fund._id, company: `TS Target ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  dealId = deal._id;
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: orgId }),
    collections.financialFunds.deleteMany({ orgId }),
    collections.financialFundTeamAssignments.deleteMany({ orgId }),
    collections.privateCapitalDeals.deleteMany({ orgId }),
    collections.termSheets.deleteMany({ orgId }),
    collections.orgActivity.deleteMany({ orgId }),
    collections.auditChainEntries.deleteMany({ orgId }),
    collections.auditChainHeads.deleteMany({ orgId }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

async function sentTermSheet(valuation) {
  const { termSheet } = await createTermSheet({ orgId, dealId, valuation, ownership: 0.2, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { termSheet: sent } = await transitionTermSheet({ orgId, termSheetId: termSheet._id, action: "send", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  return sent;
}

test("SECURITY: a non-DRAFT term sheet cannot be edited via updateTermSheetDraft()", async () => {
  const sent = await sentTermSheet(10000000);
  const result = await updateTermSheetDraft({ orgId, termSheetId: sent._id, updates: { valuation: 99 }, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(result.error !== undefined, true);
  assert.equal(result.status, 409);

  const stored = await collections.termSheets.findOne({ _id: sent._id });
  assert.equal(stored.valuation, 10000000, "the stored valuation must be unchanged after the rejected edit");
});

test("reviseTermSheet() creates a NEW document at version+1 and leaves the prior round's content untouched", async () => {
  const v1 = await sentTermSheet(10000000);
  const { termSheet: countered } = await transitionTermSheet({ orgId, termSheetId: v1._id, action: "counter", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(countered.status, "COUNTERED");

  const { termSheet: v2 } = await reviseTermSheet({ orgId, termSheetId: v1._id, updates: { valuation: 12000000 }, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.notEqual(v2._id.toString(), v1._id.toString());
  assert.equal(v2.version, 2);
  assert.equal(v2.supersedes.toString(), v1._id.toString());
  assert.equal(v2.status, "DRAFT");
  assert.equal(v2.valuation, 12000000);
  assert.equal(v2.ownership, 0.2, "fields not passed to reviseTermSheet() carry forward unchanged");

  const v1Stored = await collections.termSheets.findOne({ _id: v1._id });
  assert.equal(v1Stored.valuation, 10000000, "the original term sheet's valuation must be untouched by the revision");
  assert.equal(v1Stored.supersededBy.toString(), v2._id.toString());
});

test("reviseTermSheet() is rejected for a DRAFT term sheet and for a finalized ACCEPTED/REJECTED one", async () => {
  const { termSheet: draft } = await createTermSheet({ orgId, dealId, valuation: 5000000, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const draftResult = await reviseTermSheet({ orgId, termSheetId: draft._id, updates: {}, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(draftResult.error !== undefined, true);
  assert.equal(draftResult.status, 409);

  const sent = await sentTermSheet(5000000);
  const { termSheet: accepted } = await transitionTermSheet({ orgId, termSheetId: sent._id, action: "accept", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(accepted.status, "ACCEPTED");
  const acceptedResult = await reviseTermSheet({ orgId, termSheetId: accepted._id, updates: {}, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(acceptedResult.error !== undefined, true, "an ACCEPTED term sheet is final and cannot be revised");
});

test("accept/reject are legal from either SENT or COUNTERED (array-form transition)", async () => {
  const sentA = await sentTermSheet(7000000);
  const acceptedFromSent = await transitionTermSheet({ orgId, termSheetId: sentA._id, action: "accept", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(acceptedFromSent.termSheet.status, "ACCEPTED");

  const sentB = await sentTermSheet(7500000);
  const { termSheet: counteredB } = await transitionTermSheet({ orgId, termSheetId: sentB._id, action: "counter", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const rejectedFromCountered = await transitionTermSheet({ orgId, termSheetId: counteredB._id, action: "reject", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(rejectedFromCountered.termSheet.status, "REJECTED");
});
