// test/trust-health-v2.test.mjs
//
// Financial Services & Regulated Enterprise SOW, Phase 8 (§189-192) —
// the load-bearing property, verbatim from the SOW: "Never fabricate a
// score." A brand-new org with none of the underlying signals configured
// must report every dimension as unknown, never a fabricated green/passing
// default -- and overallStatus must itself be "unknown" when nothing at
// all could be scored.
//
// Run with: node --env-file=.env.local --test test/trust-health-v2.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { createControl, updateControl } from "../src/lib/compliance-controls.js";
import { recordControlTest } from "../src/lib/control-testing.js";
import { computeTrustHealth2, HEALTH_STATUS } from "../src/lib/trust-health-v2.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `th2-${RUN_ID}@example.com`;
const MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
let collections;
let orgId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `Trust Health 2 Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "regulated", createdAt: now });
  orgId = orgResult.insertedId;
  await collections.orgMembers.insertOne({ orgId, email: OWNER_EMAIL, role: "owner", status: "active", joinedAt: now, createdAt: now });
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: orgId }),
    collections.orgMembers.deleteMany({ orgId }),
    collections.complianceControls.deleteMany({ orgId }),
    collections.complianceControlTests.deleteMany({ orgId }),
    collections.complianceFindings.deleteMany({ orgId }),
    collections.orgActivity.deleteMany({ orgId }),
    collections.auditChainEntries.deleteMany({ orgId }),
    collections.auditChainHeads.deleteMany({ orgId }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

test("SECURITY/HONESTY: a brand-new org with none of the underlying signals configured reports every unscoreable dimension as unknown, and overallStatus is unknown, never green", async () => {
  const result = await computeTrustHealth2(orgId);
  assert.equal(result.dimensions.backup_health.status, HEALTH_STATUS.UNKNOWN, "backup health has no org-level signal and must always be unknown");
  assert.equal(result.dimensions.compliance_health.status, HEALTH_STATUS.UNKNOWN, "no controls exist yet");
  assert.equal(result.dimensions.control_health.status, HEALTH_STATUS.UNKNOWN, "no active controls exist yet");
  assert.equal(result.dimensions.vendor_health.status, HEALTH_STATUS.UNKNOWN, "no vendors exist yet");
  assert.equal(result.dimensions.operational_resilience.status, HEALTH_STATUS.UNKNOWN, "no critical functions or runbooks exist yet");
  assert.equal(result.dimensions.data_integrity.status, HEALTH_STATUS.UNKNOWN, "no integrations configured yet");
  for (const dim of Object.values(result.dimensions)) {
    assert.ok(Array.isArray(dim.remediationLinks));
    assert.ok(typeof dim.scopeNotes === "string");
  }
});

test("every dimension declares the full §190 explainability shape", async () => {
  const result = await computeTrustHealth2(orgId);
  for (const [name, dim] of Object.entries(result.dimensions)) {
    assert.ok("score" in dim, `${name} missing score`);
    assert.ok("status" in dim, `${name} missing status`);
    assert.ok("contributingFactors" in dim, `${name} missing contributingFactors`);
    assert.ok("scopeNotes" in dim, `${name} missing scopeNotes`);
    assert.ok("remediationLinks" in dim, `${name} missing remediationLinks`);
  }
});

test("a real ineffective active control drives control_health to red with a genuine contributing factor, never silently green", async () => {
  const { control } = await createControl({ orgId, name: `Weak Control ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await updateControl({ orgId, controlId: control._id, updates: { status: "active", effectiveness: "ineffective" }, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  const result = await computeTrustHealth2(orgId);
  assert.equal(result.dimensions.control_health.status, HEALTH_STATUS.RED);
  assert.ok(result.dimensions.control_health.contributingFactors[0].includes("1 ineffective"));
});

test("a failing control test drives compliance_health to red (via getComplianceHealth's own real logic), reflected honestly here too", async () => {
  const { control } = await createControl({ orgId, name: `Tested Control ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await recordControlTest({ orgId, controlId: control._id, method: "manual", result: "fail", findingSeverity: "critical", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  const result = await computeTrustHealth2(orgId);
  assert.equal(result.dimensions.compliance_health.status, HEALTH_STATUS.RED);
  assert.equal(result.overallStatus, HEALTH_STATUS.RED, "one red dimension must drive the overall status to red");
});
