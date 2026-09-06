// test/portfolio-management.test.mjs
//
// Financial Services & Regulated Enterprise SOW, Phase 2 (§10.1) — load-
// bearing correctness property: a threshold breach must create a REAL
// risk-register entry (reusing risk-register.js's createRisk(), per the
// plan's explicit reuse decision), not just a silent UI flag. This is
// also the regression test for the createRisk() permission fix this phase
// required: createRisk() originally only allowed canManageOrg, which would
// have silently swallowed every breach triggered by a financialRole
// "manager" who is not an org owner/admin.
//
// Run with: node --env-file=.env.local --test test/portfolio-management.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { createPortfolio, ingestPosition, setThreshold, evaluateThresholds, getExposureDashboard } from "../src/lib/portfolio-management.js";
import mongoClientPromise, { connectToDatabase } from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `portfolio-mgmt-${RUN_ID}@example.com`;
const MANAGER_EMAIL = `financial-manager-${RUN_ID}@example.com`;
const OWNER_MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
// Not an org owner/admin -- only a financialRole:"manager". This is the
// exact membership shape that would have been silently rejected by
// createRisk()'s original canManageOrg-only gate.
const MANAGER_MEMBERSHIP = { role: "member", email: MANAGER_EMAIL, financialRole: "manager" };
let collections;
let orgId;
let fundId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const result = await collections.orgs.insertOne({ name: `Portfolio Mgmt Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "financial", createdAt: now });
  orgId = result.insertedId;
  fundId = new ObjectId();
});

after(async () => {
  const { db } = await connectToDatabase();
  await Promise.all([
    collections.orgs.deleteMany({ _id: orgId }),
    collections.portfolios.deleteMany({ orgId }),
    collections.positions.deleteMany({ orgId }),
    collections.exposureThresholds.deleteMany({ orgId }),
    collections.riskRegister.deleteMany({ orgId }),
    collections.orgActivity.deleteMany({ orgId }),
    collections.auditChainEntries.deleteMany({ orgId }),
    collections.auditChainHeads.deleteMany({ orgId }),
    db.collection("notifications").deleteMany({ orgId }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

test("evaluateThresholds() creates a real risk-register entry on breach, triggered by a financialRole:manager (not just an org owner/admin)", async () => {
  const { portfolio } = await createPortfolio({ orgId, fundId, name: `Concentration Test Portfolio ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  await ingestPosition({ orgId, portfolioId: portfolio._id, security: "ACME 5Y Bond", issuer: "ACME Corp", sector: "Industrials", marketValue: 150, actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });

  await setThreshold({ orgId, fundId, metric: "issuer_concentration", limitValue: 100, actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });

  const riskCountBefore = await collections.riskRegister.countDocuments({ orgId });
  const { breaches } = await evaluateThresholds({ orgId, fundId, portfolioId: portfolio._id, actorEmail: MANAGER_EMAIL, membership: MANAGER_MEMBERSHIP });

  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].metric, "issuer_concentration");
  assert.equal(breaches[0].currentValue, 150);

  const riskCountAfter = await collections.riskRegister.countDocuments({ orgId });
  assert.equal(riskCountAfter, riskCountBefore + 1, "a breach must create exactly one new risk-register entry, triggered by the financialRole:manager actor");

  const risk = await collections.riskRegister.findOne({ orgId }, { sort: { createdAt: -1 } });
  assert.equal(risk.category, "concentration");
  assert.equal(risk.severity, "high");
  assert.equal(risk.status, "open");
  assert.match(risk.impact, /issuer_concentration threshold breached/);
});

test("evaluateThresholds() reports no breach and creates no risk entry when exposure is within every configured limit", async () => {
  const { portfolio } = await createPortfolio({ orgId, fundId: new ObjectId(), name: `Within Limits Portfolio ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  const withinFundId = portfolio.fundId;
  await ingestPosition({ orgId, portfolioId: portfolio._id, security: "Safe Corp Bond", issuer: "Safe Corp", marketValue: 10, actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  await setThreshold({ orgId, fundId: withinFundId, metric: "issuer_concentration", limitValue: 100, actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });

  const riskCountBefore = await collections.riskRegister.countDocuments({ orgId });
  const { breaches } = await evaluateThresholds({ orgId, fundId: withinFundId, portfolioId: portfolio._id, actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  assert.equal(breaches.length, 0);

  const riskCountAfter = await collections.riskRegister.countDocuments({ orgId });
  assert.equal(riskCountAfter, riskCountBefore, "no breach must mean no new risk-register entry");
});

test("getExposureDashboard() excludes an unpriced position from every sum rather than fabricating a value for it", async () => {
  const { portfolio } = await createPortfolio({ orgId, fundId: new ObjectId(), name: `Unpriced Position Portfolio ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  await ingestPosition({ orgId, portfolioId: portfolio._id, security: "Priced Position", issuer: "Priced Co", marketValue: 50, actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  await ingestPosition({ orgId, portfolioId: portfolio._id, security: "Unpriced Position", issuer: "Unpriced Co", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });

  const dashboard = await getExposureDashboard(orgId, portfolio._id);
  assert.equal(dashboard.positionCount, 2);
  assert.equal(dashboard.pricedPositionCount, 1);
  assert.equal(dashboard.unpricedPositionCount, 1);
  assert.equal(dashboard.grossExposure, 50, "the unpriced position must not contribute a fabricated 0 or any other value to the sum");
});
