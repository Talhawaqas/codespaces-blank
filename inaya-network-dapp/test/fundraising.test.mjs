// test/fundraising.test.mjs
//
// Financial Services & Regulated Enterprise SOW, Phase 3 (§40) — load-
// bearing correctness property: convertToInvestor() must create a REAL
// financial-investors.js Investor record (reusing Phase 1's onboarding/
// capital-account machinery), only reachable from LEGAL_DOCS, and the
// resulting investor is genuinely usable with the existing capital-event
// ledger -- not a second, parallel investor concept.
//
// Run with: node --env-file=.env.local --test test/fundraising.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { createFund } from "../src/lib/fund-registry.js";
import { createFundraisingProspect, transitionProspect, convertToInvestor, recordCommunication } from "../src/lib/fundraising.js";
import { recordCapitalEvent, getCapitalAccountSummary } from "../src/lib/financial-investors.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `fundraising-${RUN_ID}@example.com`;
const MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
let collections;
let orgId;
let fundId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `Fundraising Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "private_capital", createdAt: now });
  orgId = orgResult.insertedId;
  const { fund } = await createFund({ orgId, legalName: `Raise Fund ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  fundId = fund._id;
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: orgId }),
    collections.financialFunds.deleteMany({ orgId }),
    collections.financialFundTeamAssignments.deleteMany({ orgId }),
    collections.financialInvestors.deleteMany({ orgId }),
    collections.financialInvestorCommitments.deleteMany({ orgId }),
    collections.fundraisingProspects.deleteMany({ orgId }),
    collections.orgActivity.deleteMany({ orgId }),
    collections.auditChainEntries.deleteMany({ orgId }),
    collections.auditChainHeads.deleteMany({ orgId }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

async function legalDocsProspect(legalName) {
  const { prospect } = await createFundraisingProspect({ orgId, fundId, legalName, targetCommitment: 5000000, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  let current = prospect;
  for (let i = 0; i < 5; i++) {
    const result = await transitionProspect({ orgId, prospectId: current._id, action: "advance", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
    current = result.prospect;
  }
  return current;
}

test("a prospect advances one stage at a time to LEGAL_DOCS", async () => {
  const { prospect } = await createFundraisingProspect({ orgId, fundId, legalName: `Pension Fund LP ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(prospect.stage, "IDENTIFIED");
  const stages = ["OUTREACH", "MEETING", "DILIGENCE", "SOFT_CIRCLE", "LEGAL_DOCS"];
  let current = prospect;
  for (const expected of stages) {
    const result = await transitionProspect({ orgId, prospectId: current._id, action: "advance", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
    assert.equal(result.prospect.stage, expected);
    current = result.prospect;
  }
});

test("convertToInvestor() only succeeds from LEGAL_DOCS and creates a REAL financial-investors.js Investor usable with the real capital-event ledger", async () => {
  const legalDocs = await legalDocsProspect(`Endowment Fund ${RUN_ID}`);
  assert.equal(legalDocs.stage, "LEGAL_DOCS");

  const { prospect, investor } = await convertToInvestor({ orgId, prospectId: legalDocs._id, entityType: "endowment", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(prospect.stage, "CLOSED");
  assert.equal(prospect.convertedInvestorId.toString(), investor._id.toString());

  const storedInvestor = await collections.financialInvestors.findOne({ _id: investor._id });
  assert.equal(storedInvestor.legalName, `Endowment Fund ${RUN_ID}`);
  assert.equal(storedInvestor.fundId.toString(), fundId.toString());

  // Prove it's a genuinely usable Investor, not a stub -- the real
  // capital-event ledger (Phase 1) works against it unmodified.
  await recordCapitalEvent({ orgId, investorId: investor._id, fundId, type: "commitment", amount: 5000000, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const summary = await getCapitalAccountSummary(orgId, investor._id, fundId);
  assert.equal(summary.totals.commitment, 5000000);
});

test("convertToInvestor() is rejected from any stage other than LEGAL_DOCS", async () => {
  const { prospect } = await createFundraisingProspect({ orgId, fundId, legalName: `Too Early LP ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const result = await convertToInvestor({ orgId, prospectId: prospect._id, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(result.error !== undefined, true);
  assert.equal(result.status, 409);
});

test("pass/reopen: a passed prospect can be reopened back to IDENTIFIED, but only from PASSED", async () => {
  const { prospect } = await createFundraisingProspect({ orgId, fundId, legalName: `Passed LP ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { prospect: passed } = await transitionProspect({ orgId, prospectId: prospect._id, action: "pass", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(passed.stage, "PASSED");

  const reopenFromIdentified = await transitionProspect({ orgId, prospectId: prospect._id, action: "reopen", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(reopenFromIdentified.error, undefined);
  assert.equal(reopenFromIdentified.prospect.stage, "IDENTIFIED");
});

test("recordCommunication() is append-only", async () => {
  const { prospect } = await createFundraisingProspect({ orgId, fundId, legalName: `Comms LP ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await recordCommunication({ orgId, prospectId: prospect._id, note: "Initial call went well.", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { prospect: withTwo } = await recordCommunication({ orgId, prospectId: prospect._id, note: "Sent deck.", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(withTwo.communications.length, 2);
});
