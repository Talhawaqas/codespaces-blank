// test/deal-pipeline.test.mjs
//
// Financial Services & Regulated Enterprise SOW, Phase 3 (§29-30) — load-
// bearing correctness properties: (1) a deal only reaches PORTFOLIO
// through convertToPortfolio(), which must create a REAL portfolio
// company, never just flip a status label; (2) a deal scorecard is
// versioned per evaluator, never overwritten.
//
// Run with: node --env-file=.env.local --test test/deal-pipeline.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { createFund } from "../src/lib/fund-registry.js";
import { createDeal, transitionDeal, convertToPortfolio, submitScorecard, listScorecards } from "../src/lib/deal-pipeline.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `deal-pipeline-${RUN_ID}@example.com`;
const MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
let collections;
let orgId;
let fundId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `Deal Pipeline Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "private_capital", createdAt: now });
  orgId = orgResult.insertedId;
  const { fund } = await createFund({ orgId, legalName: `PC Fund ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  fundId = fund._id;
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: orgId }),
    collections.financialFunds.deleteMany({ orgId }),
    collections.financialFundTeamAssignments.deleteMany({ orgId }),
    collections.privateCapitalDeals.deleteMany({ orgId }),
    collections.dealScorecards.deleteMany({ orgId }),
    collections.portfolioCompanies.deleteMany({ orgId }),
    collections.orgActivity.deleteMany({ orgId }),
    collections.auditChainEntries.deleteMany({ orgId }),
    collections.auditChainHeads.deleteMany({ orgId }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

async function closingDeal(company) {
  const { deal } = await createDeal({ orgId, fundId, company, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  let dealId = deal._id;
  for (let i = 0; i < 8; i++) {
    const result = await transitionDeal({ orgId, dealId, action: "advance", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
    dealId = result.deal._id;
  }
  return collections.privateCapitalDeals.findOne({ _id: dealId });
}

test("a deal advances one stage at a time through the full open pipeline to CLOSING", async () => {
  const { deal } = await createDeal({ orgId, fundId, company: `ACME Robotics ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(deal.stage, "SOURCED");

  const stages = ["SCREENED", "INITIAL_REVIEW", "PARTNER_REVIEW", "DILIGENCE", "IC", "TERM_SHEET", "NEGOTIATION", "CLOSING"];
  let current = deal;
  for (const expected of stages) {
    const result = await transitionDeal({ orgId, dealId: current._id, action: "advance", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
    assert.equal(result.deal.stage, expected);
    current = result.deal;
  }

  const noNext = await transitionDeal({ orgId, dealId: current._id, action: "advance", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(noNext.error !== undefined, true, "CLOSING has no next open-pipeline stage -- must use convertToPortfolio()");
  assert.equal(noNext.status, 409);
});

test("convertToPortfolio() only succeeds from CLOSING and creates a REAL portfolio company linked back to the deal", async () => {
  const closing = await closingDeal(`Vertex Biotech ${RUN_ID}`);
  assert.equal(closing.stage, "CLOSING");

  const { deal, portfolioCompany } = await convertToPortfolio({ orgId, dealId: closing._id, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(deal.stage, "PORTFOLIO");
  assert.equal(deal.portfolioCompanyId.toString(), portfolioCompany._id.toString());

  const storedCompany = await collections.portfolioCompanies.findOne({ _id: portfolioCompany._id });
  assert.equal(storedCompany.name, "Vertex Biotech " + RUN_ID);
  assert.equal(storedCompany.fundId.toString(), fundId.toString());
  assert.equal(storedCompany.dealId.toString(), closing._id.toString());
  assert.equal(storedCompany.status, "active");
});

test("convertToPortfolio() is rejected from any stage other than CLOSING", async () => {
  const { deal } = await createDeal({ orgId, fundId, company: `Too Early Co ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const result = await convertToPortfolio({ orgId, dealId: deal._id, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(result.error !== undefined, true);
  assert.equal(result.status, 409);
});

test("submitScorecard() versions per evaluator -- a second submission by the same evaluator creates v2, never overwrites v1", async () => {
  const { deal } = await createDeal({ orgId, fundId, company: `Scorecard Co ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { scorecard: v1 } = await submitScorecard({ orgId, dealId: deal._id, scores: { team: { score: 8, weight: 2 }, market: { score: 6, weight: 1 } }, rationale: "Strong team", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(v1.version, 1);
  assert.equal(v1.weightedScore, (8 * 2 + 6 * 1) / 3);

  const { scorecard: v2 } = await submitScorecard({ orgId, dealId: deal._id, scores: { team: { score: 9, weight: 2 } }, rationale: "Revised after diligence call", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(v2.version, 2);

  const v1Stored = await collections.dealScorecards.findOne({ _id: v1._id });
  assert.equal(v1Stored.rationale, "Strong team", "v1 must be completely untouched by the v2 submission");

  const history = await listScorecards(orgId, deal._id);
  assert.equal(history.length, 2);
});

test("submitScorecard() rejects an unknown criterion", async () => {
  const { deal } = await createDeal({ orgId, fundId, company: `Bad Criterion Co ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const result = await submitScorecard({ orgId, dealId: deal._id, scores: { not_a_real_criterion: { score: 5 } }, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(result.error !== undefined, true);
  assert.equal(result.status, 400);
});
