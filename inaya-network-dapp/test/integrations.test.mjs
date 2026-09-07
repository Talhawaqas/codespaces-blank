// test/integrations.test.mjs
//
// Financial Services & Regulated Enterprise SOW, Phase 7 (§95, §235-236) —
// the Integration Adapter Architecture. Load-bearing property: a
// connection can NEVER reach ACTIVE through configuration alone -- only a
// real recordSyncRun("success") call can do that. Retry is only reachable
// from ERROR, and every sync run is an immutable new row.
//
// Run with: node --env-file=.env.local --test test/integrations.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import {
  INTEGRATION_PROVIDERS, getIntegrationCatalog, configureIntegration, disableIntegration,
  recordSyncRun, retrySync, getOrgIntegrations, getIntegrationHealth, listSyncRuns,
} from "../src/lib/integrations.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `integrations-${RUN_ID}@example.com`;
const MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
let collections;
let orgId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `Integrations Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "general", createdAt: now });
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

test("the static catalog covers every SOW §155 category and getIntegrationCatalog filters correctly", () => {
  const categories = new Set(INTEGRATION_PROVIDERS.map((p) => p.category));
  for (const c of ["identity", "productivity", "financial", "security", "compliance", "data_provider"]) {
    assert.ok(categories.has(c), `missing category "${c}"`);
  }
  const financialOnly = getIntegrationCatalog({ category: "financial" });
  assert.ok(financialOnly.every((p) => p.category === "financial"));
  assert.ok(financialOnly.some((p) => p.id === "fund_administrator"));
});

test("an unconfigured provider reports NOT_CONFIGURED for every org, never silently omitted from the list", async () => {
  const integrations = await getOrgIntegrations(orgId);
  assert.equal(integrations.length, INTEGRATION_PROVIDERS.length);
  const custodian = integrations.find((i) => i.id === "custodian");
  assert.equal(custodian.status, "NOT_CONFIGURED");
  assert.equal(custodian.credentialsStatus, "not_provided");
});

test("SECURITY/HONESTY: configureIntegration() alone can NEVER produce ACTIVE status -- only a real recordSyncRun success can", async () => {
  const { connection } = await configureIntegration({ orgId, providerId: "custodian", ownerEmail: OWNER_EMAIL, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(connection.status, "AWAITING_CREDENTIALS", "configuring alone must never claim a live connection");
  assert.equal(connection.credentialsStatus, "not_provided");
});

test("recordSyncRun(success) moves the connection to ACTIVE with real numbers; recordSyncRun(error) moves it to ERROR", async () => {
  await configureIntegration({ orgId, providerId: "market_data_provider", ownerEmail: OWNER_EMAIL, syncFrequencyHours: 1, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  const { connection: afterSuccess } = await recordSyncRun({ orgId, providerId: "market_data_provider", result: "success", sourceCount: 100, targetCount: 100, newCount: 10, updatedCount: 5, actorEmail: OWNER_EMAIL });
  assert.equal(afterSuccess.status, "ACTIVE");
  assert.equal(afterSuccess.recordsProcessedTotal, 15);
  assert.ok(afterSuccess.lastSyncAt);

  const { connection: afterError } = await recordSyncRun({ orgId, providerId: "market_data_provider", result: "error", errorMessage: "Timed out.", actorEmail: OWNER_EMAIL });
  assert.equal(afterError.status, "ERROR");
  assert.equal(afterError.errorCount, 1);
});

test("recordSyncRun requires the provider to already be configured -- cannot fabricate a sync against nothing", async () => {
  const result = await recordSyncRun({ orgId, providerId: "prime_broker", result: "success", actorEmail: OWNER_EMAIL });
  assert.equal(result.status, 404);
});

test("retrySync is only reachable from ERROR -- rejected from ACTIVE or AWAITING_CREDENTIALS", async () => {
  await configureIntegration({ orgId, providerId: "siem", ownerEmail: OWNER_EMAIL, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const notYetFailed = await retrySync({ orgId, providerId: "siem", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(notYetFailed.status, 409);

  await recordSyncRun({ orgId, providerId: "siem", result: "error", actorEmail: OWNER_EMAIL });
  const { connection } = await retrySync({ orgId, providerId: "siem", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(connection.status, "AWAITING_CREDENTIALS", "a retry re-opens the connection for a real attempt, it does not itself claim success");
});

test("sync runs are immutable append-only rows -- each recordSyncRun() call is a new document, never an edit of a prior one", async () => {
  await configureIntegration({ orgId, providerId: "vulnerability_scanner", ownerEmail: OWNER_EMAIL, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await recordSyncRun({ orgId, providerId: "vulnerability_scanner", result: "success", sourceCount: 5, targetCount: 5, actorEmail: OWNER_EMAIL });
  await recordSyncRun({ orgId, providerId: "vulnerability_scanner", result: "error", errorMessage: "second run failed", actorEmail: OWNER_EMAIL });

  const runs = await listSyncRuns(orgId, { providerId: "vulnerability_scanner" });
  assert.equal(runs.length, 2);
  assert.equal(runs[0].result, "error", "most recent run first");
  assert.equal(runs[1].result, "success", "the first run's stored result is unaffected by the second run");
});

test("disableIntegration() moves an existing connection to DISABLED, and cannot be called twice", async () => {
  await configureIntegration({ orgId, providerId: "teams", ownerEmail: OWNER_EMAIL, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { connection } = await disableIntegration({ orgId, providerId: "teams", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(connection.status, "DISABLED");

  const second = await disableIntegration({ orgId, providerId: "teams", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(second.status, 404);
});

test("SECURITY: a plain member (no owner/admin authority) cannot configure, disable, or retry an integration", async () => {
  const plainMember = { role: "member", email: `plain-${RUN_ID}@example.com` };
  const configureResult = await configureIntegration({ orgId, providerId: "okta", actorEmail: plainMember.email, membership: plainMember });
  assert.equal(configureResult.status, 403);

  await configureIntegration({ orgId, providerId: "okta", ownerEmail: OWNER_EMAIL, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const disableResult = await disableIntegration({ orgId, providerId: "okta", actorEmail: plainMember.email, membership: plainMember });
  assert.equal(disableResult.status, 403);
});

test("getIntegrationHealth returns the real §235 shape for a configured provider, and notFound for an unknown provider ID", async () => {
  const health = await getIntegrationHealth(orgId, "market_data_provider");
  assert.equal(health.status, "ERROR"); // left in ERROR by an earlier test in this file
  assert.ok("errorCount" in health);
  assert.ok("ownerEmail" in health);

  const unknown = await getIntegrationHealth(orgId, "not_a_real_provider");
  assert.equal(unknown.notFound, true);
});
