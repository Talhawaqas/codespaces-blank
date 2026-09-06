// test/exit-management.test.mjs
//
// Financial Services & Regulated Enterprise SOW, Phase 3 (§41) — load-
// bearing correctness property: approveExit() must verify the linked IC
// decision is a REAL approval outcome (reusing investment-committee.js's
// existing decision records, not a second approval concept) -- a
// REJECTED or DEFERRED decision can never approve an exit, and only a
// decision that actually exists can be linked at all.
//
// Run with: node --env-file=.env.local --test test/exit-management.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { createFund } from "../src/lib/fund-registry.js";
import { createPortfolioCompany } from "../src/lib/portfolio-company.js";
import { createCase, transitionCase, recordDecision } from "../src/lib/investment-committee.js";
import { createExit, transitionExit, recordBid, approveExit, beginClosing, recordDistribution } from "../src/lib/exit-management.js";
import mongoClientPromise, { connectToDatabase } from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `exit-mgmt-${RUN_ID}@example.com`;
const MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
let collections;
let orgId;
let companyId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `Exit Mgmt Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "private_capital", createdAt: now });
  orgId = orgResult.insertedId;
  const { fund } = await createFund({ orgId, legalName: `Exit Fund ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { portfolioCompany } = await createPortfolioCompany({ orgId, fundId: fund._id, name: `Exit Company ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  companyId = portfolioCompany._id;
});

after(async () => {
  const { db } = await connectToDatabase();
  await Promise.all([
    collections.orgs.deleteMany({ _id: orgId }),
    collections.financialFunds.deleteMany({ orgId }),
    collections.financialFundTeamAssignments.deleteMany({ orgId }),
    collections.portfolioCompanies.deleteMany({ orgId }),
    collections.exits.deleteMany({ orgId }),
    collections.investmentCommitteeCases.deleteMany({ orgId }),
    collections.icDecisions.deleteMany({ orgId }),
    collections.orgActivity.deleteMany({ orgId }),
    collections.auditChainEntries.deleteMany({ orgId }),
    collections.auditChainHeads.deleteMany({ orgId }),
    db.collection("notifications").deleteMany({ orgId }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

async function icScheduledCase(opportunity) {
  const { case: created } = await createCase({ orgId, opportunity, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await transitionCase({ orgId, caseId: created._id, action: "submit", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await transitionCase({ orgId, caseId: created._id, action: "startResearch", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await transitionCase({ orgId, caseId: created._id, action: "submitForComplianceReview", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await transitionCase({ orgId, caseId: created._id, action: "submitForRiskReview", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { case: scheduled } = await transitionCase({ orgId, caseId: created._id, action: "scheduleIC", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  return scheduled;
}

async function exitAtNegotiation() {
  const { exit } = await createExit({ orgId, portfolioCompanyId: companyId, exitType: "acquisition", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await transitionExit({ orgId, exitId: exit._id, action: "beginOutreach", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await transitionExit({ orgId, exitId: exit._id, action: "beginDiligence", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await transitionExit({ orgId, exitId: exit._id, action: "receiveBids", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { exit: negotiating } = await transitionExit({ orgId, exitId: exit._id, action: "negotiate", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  return negotiating;
}

test("an exit advances through its lifecycle and accepts bids along the way", async () => {
  const { exit } = await createExit({ orgId, portfolioCompanyId: companyId, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(exit.status, "READINESS");
  const { exit: outreach } = await transitionExit({ orgId, exitId: exit._id, action: "beginOutreach", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(outreach.status, "BUYER_OUTREACH");
  const { exit: withBid } = await recordBid({ orgId, exitId: exit._id, buyerName: "BigCo Inc", buyerType: "strategic", amount: 50000000, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(withBid.bids.length, 1);
});

test("SECURITY: approveExit() rejects a REJECTED IC decision -- an exit is never approved by a non-approval outcome", async () => {
  const scheduled = await icScheduledCase(`Exit of Portfolio Company ${RUN_ID} (reject case)`);
  const { decision } = await recordDecision({ orgId, caseId: scheduled._id, outcome: "reject", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  const negotiating = await exitAtNegotiation();
  const result = await approveExit({ orgId, exitId: negotiating._id, icDecisionId: decision._id, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(result.error !== undefined, true, "a REJECTED IC decision must never approve an exit");
  assert.equal(result.status, 409);

  const stored = await collections.exits.findOne({ _id: negotiating._id });
  assert.equal(stored.status, "NEGOTIATION", "a rejected approval attempt must not advance the exit's status");
});

test("SECURITY: approveExit() rejects a nonexistent IC decision ID rather than trusting a client-supplied claim", async () => {
  const negotiating = await exitAtNegotiation();
  const fakeDecisionId = new ObjectId();
  const result = await approveExit({ orgId, exitId: negotiating._id, icDecisionId: fakeDecisionId, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(result.error !== undefined, true);
  assert.equal(result.status, 404);
});

test("approveExit() succeeds with a genuine APPROVED IC decision, and the full closing lifecycle completes", async () => {
  const scheduled = await icScheduledCase(`Exit of Portfolio Company ${RUN_ID} (approve case)`);
  const { decision } = await recordDecision({ orgId, caseId: scheduled._id, outcome: "approve", finalResolution: "Exit approved at $50M.", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  const negotiating = await exitAtNegotiation();
  const { exit: approved } = await approveExit({ orgId, exitId: negotiating._id, icDecisionId: decision._id, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(approved.status, "IC_APPROVED");
  assert.equal(approved.icDecisionId.toString(), decision._id.toString());

  const { exit: closing } = await beginClosing({ orgId, exitId: approved._id, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(closing.status, "CLOSING");

  const { exit: closed } = await transitionExit({ orgId, exitId: closing._id, action: "close", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(closed.status, "CLOSED");

  const { exit: withDistribution } = await recordDistribution({ orgId, exitId: closed._id, distributionAmount: 45000000, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(withDistribution.distributionAmount, 45000000);
});

test("beginClosing() is only reachable from IC_APPROVED", async () => {
  const negotiating = await exitAtNegotiation();
  const result = await beginClosing({ orgId, exitId: negotiating._id, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(result.error !== undefined, true);
  assert.equal(result.status, 409);
});
