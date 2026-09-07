// test/data-quality.test.mjs
//
// Financial Services & Regulated Enterprise SOW, Phase 7 (§237-238) —
// the load-bearing property, verbatim from the SOW: "Unknown must remain
// unknown." A provider that has never synced gets null/"unknown" for
// every dimension, never a fabricated default score.
//
// Run with: node --env-file=.env.local --test test/data-quality.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { configureIntegration, recordSyncRun } from "../src/lib/integrations.js";
import { getDataQualityScore, computeOrgDataQualityScores, listDataQualityAlerts } from "../src/lib/data-quality.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `dq-${RUN_ID}@example.com`;
const MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
let collections;
let orgId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `DQ Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "general", createdAt: now });
  orgId = orgResult.insertedId;
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: orgId }),
    collections.integrationConnections.deleteMany({ orgId }),
    collections.integrationSyncRuns.deleteMany({ orgId }),
    collections.orgActivity.deleteMany({ orgId }),
    collections.auditChainEntries.deleteMany({ orgId }),
    collections.auditChainHeads.deleteMany({ orgId }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

test("SECURITY/HONESTY: an unconfigured provider's data quality score is entirely unknown (null), never a fabricated default", async () => {
  const score = await getDataQualityScore(orgId, "cap_table_system");
  assert.equal(score.completeness, null);
  assert.equal(score.freshness, null);
  assert.equal(score.consistency, null);
  assert.equal(score.validity, null);
  assert.equal(score.uniqueness, null);
  assert.equal(score.lineage, null);
  assert.ok(score.reason);
});

test("SECURITY/HONESTY: a configured-but-never-synced provider is ALSO entirely unknown, not defaulted to a passing score", async () => {
  await configureIntegration({ orgId, providerId: "accounting_system", ownerEmail: OWNER_EMAIL, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const score = await getDataQualityScore(orgId, "accounting_system");
  assert.equal(score.completeness, null);
  assert.equal(score.freshness, null);
});

test("a real successful sync produces real, computed scores -- never fabricated", async () => {
  await configureIntegration({ orgId, providerId: "custodian", ownerEmail: OWNER_EMAIL, syncFrequencyHours: 24, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await recordSyncRun({ orgId, providerId: "custodian", result: "success", sourceCount: 100, targetCount: 100, failedCount: 5, conflicts: 2, actorEmail: OWNER_EMAIL });

  const score = await getDataQualityScore(orgId, "custodian");
  assert.equal(score.completeness, 0.95);
  assert.equal(score.consistency, 0.98);
  assert.equal(score.freshness, "fresh");
  assert.equal(score.validity, "valid");
  assert.equal(score.uniqueness, null, "uniqueness has no real basis in this pass -- must stay unknown, not guessed");
  assert.equal(score.lineage, null, "lineage has no real basis in this pass -- must stay unknown, not guessed");
});

test("a failed sync produces validity:'invalid', not a silently passing score", async () => {
  await configureIntegration({ orgId, providerId: "sanctions_provider", ownerEmail: OWNER_EMAIL, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await recordSyncRun({ orgId, providerId: "sanctions_provider", result: "error", errorMessage: "auth failed", actorEmail: OWNER_EMAIL });
  // recordSyncRun's own connection.lastSyncAt is set even on error (a real
  // attempt happened) -- but listSyncRuns' latest run governs validity.
  const score = await getDataQualityScore(orgId, "sanctions_provider");
  assert.equal(score.validity, "invalid");
});

test("computeOrgDataQualityScores returns one entry per configured provider, and an explicit message when none are configured yet", async () => {
  const now = new Date().toISOString();
  const emptyOrgResult = await collections.orgs.insertOne({ name: `DQ Empty ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "general", createdAt: now });
  const emptyOrgId = emptyOrgResult.insertedId;
  try {
    const result = await computeOrgDataQualityScores(emptyOrgId);
    assert.equal(result.scores.length, 0);
    assert.ok(result.unscored);
  } finally {
    await collections.orgs.deleteMany({ _id: emptyOrgId });
  }

  const result = await computeOrgDataQualityScores(orgId);
  assert.ok(result.scores.length >= 3);
});

test("listDataQualityAlerts raises an alert only from a real ERROR connection, never invents one", async () => {
  const { alerts } = await listDataQualityAlerts(orgId);
  assert.ok(alerts.some((a) => a.providerId === "sanctions_provider" && a.type === "broken_vendor_integration"));
  assert.ok(!alerts.some((a) => a.providerId === "cap_table_system"), "an unconfigured provider must never generate an alert");
});
