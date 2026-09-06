// test/cap-table.test.mjs
//
// Financial Services & Regulated Enterprise SOW, Phase 3 (§34) — load-
// bearing correctness property: "every cap-table change must be versioned
// and approved" -- approveCapTableSnapshot() requires a different person
// than whoever recorded it (same dual-control discipline as
// valuation-management.js's approveValuation()), and a snapshot is never
// mutated once recorded, only superseded by a new version.
//
// Run with: node --env-file=.env.local --test test/cap-table.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { createFund } from "../src/lib/fund-registry.js";
import { createPortfolioCompany } from "../src/lib/portfolio-company.js";
import { recordCapTableSnapshot, approveCapTableSnapshot, getLatestCapTableSnapshot } from "../src/lib/cap-table.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `cap-table-${RUN_ID}@example.com`;
const OTHER_EMAIL = `cap-table-reviewer-${RUN_ID}@example.com`;
const MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
let collections;
let orgId;
let companyId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `Cap Table Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "private_capital", createdAt: now });
  orgId = orgResult.insertedId;
  const { fund } = await createFund({ orgId, legalName: `CT Fund ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { portfolioCompany } = await createPortfolioCompany({ orgId, fundId: fund._id, name: `CT Company ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  companyId = portfolioCompany._id;
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: orgId }),
    collections.financialFunds.deleteMany({ orgId }),
    collections.financialFundTeamAssignments.deleteMany({ orgId }),
    collections.portfolioCompanies.deleteMany({ orgId }),
    collections.capTableSnapshots.deleteMany({ orgId }),
    collections.orgActivity.deleteMany({ orgId }),
    collections.auditChainEntries.deleteMany({ orgId }),
    collections.auditChainHeads.deleteMany({ orgId }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

const ROWS = [
  { holderName: "Founder", instrumentType: "common", fullyDilutedShares: 6000000 },
  { holderName: "Fund", instrumentType: "preferred", fullyDilutedShares: 3000000 },
  { holderName: "Option Pool", instrumentType: "option", fullyDilutedShares: 1000000 },
];

test("recordCapTableSnapshot() computes fullyDilutedPercent from the rows given, never fabricated", async () => {
  const { snapshot } = await recordCapTableSnapshot({ orgId, portfolioCompanyId: companyId, rows: ROWS, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.totalFullyDilutedShares, 10000000);
  assert.equal(snapshot.rows[0].fullyDilutedPercent, 0.6);
  assert.equal(snapshot.rows[1].fullyDilutedPercent, 0.3);
  assert.equal(snapshot.approvedAt, null);
});

test("SECURITY: approveCapTableSnapshot() rejects the same person who recorded it", async () => {
  const { snapshot } = await recordCapTableSnapshot({ orgId, portfolioCompanyId: companyId, rows: ROWS, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const result = await approveCapTableSnapshot({ orgId, snapshotId: snapshot._id, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(result.error !== undefined, true, "the recorder cannot approve their own snapshot");
  assert.equal(result.status, 403);

  const stored = await collections.capTableSnapshots.findOne({ _id: snapshot._id });
  assert.equal(stored.approvedAt, null, "a rejected approval attempt must not set approvedAt");
});

test("approveCapTableSnapshot() succeeds for a genuinely different reviewer, and cannot be approved twice", async () => {
  const { snapshot } = await recordCapTableSnapshot({ orgId, portfolioCompanyId: companyId, rows: ROWS, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { snapshot: approved } = await approveCapTableSnapshot({ orgId, snapshotId: snapshot._id, actorEmail: OTHER_EMAIL, membership: MEMBERSHIP });
  assert.equal(approved.approvedByEmail, OTHER_EMAIL);
  assert.notEqual(approved.approvedAt, null);

  const secondAttempt = await approveCapTableSnapshot({ orgId, snapshotId: snapshot._id, actorEmail: OTHER_EMAIL, membership: MEMBERSHIP });
  assert.equal(secondAttempt.error !== undefined, true, "an already-approved snapshot cannot be approved again");
  assert.equal(secondAttempt.status, 409);
});

test("a new snapshot version never mutates a prior version -- both remain queryable, getLatestCapTableSnapshot returns the newest", async () => {
  const { snapshot: v1 } = await recordCapTableSnapshot({ orgId, portfolioCompanyId: companyId, rows: ROWS, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { snapshot: v2 } = await recordCapTableSnapshot({ orgId, portfolioCompanyId: companyId, rows: [...ROWS, { holderName: "New Investor", instrumentType: "safe", fullyDilutedShares: 500000 }], actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(v2.version, v1.version + 1);

  const v1Stored = await collections.capTableSnapshots.findOne({ _id: v1._id });
  assert.equal(v1Stored.totalFullyDilutedShares, 10000000, "v1 must be untouched by recording v2");

  const latest = await getLatestCapTableSnapshot(orgId, companyId);
  assert.equal(latest._id.toString(), v2._id.toString());
});

test("recordCapTableSnapshot() rejects an unknown instrument type", async () => {
  const result = await recordCapTableSnapshot({ orgId, portfolioCompanyId: companyId, rows: [{ holderName: "Bad", instrumentType: "not_a_real_type", fullyDilutedShares: 1 }], actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(result.error !== undefined, true);
  assert.equal(result.status, 400);
});
