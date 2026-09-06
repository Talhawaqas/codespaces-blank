// test/vendor-management.test.mjs
//
// Financial Services & Regulated Enterprise SOW, Phase 5 (§64-66) — load-
// bearing correctness properties: (1) the full onboarding state machine
// (§65) walks Request through Monitoring in order, with reject legal from
// any pre-approval state (array-form transition); (2) continuous
// monitoring (§66) surfaces expiring certificates/contracts honestly --
// never silently rolling past an expiry the org hasn't acted on.
//
// Run with: node --env-file=.env.local --test test/vendor-management.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { createVendor, transitionVendorOnboarding, recordVendorFinding, recordSubprocessorChange, updateVendorExpiryDates, listExpiringVendorItems } from "../src/lib/vendor-management.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `vendor-mgmt-${RUN_ID}@example.com`;
const MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
let collections;
let orgId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `Vendor Mgmt Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "general", createdAt: now });
  orgId = orgResult.insertedId;
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: orgId }),
    collections.vendorRecords.deleteMany({ orgId }),
    collections.orgActivity.deleteMany({ orgId }),
    collections.auditChainEntries.deleteMany({ orgId }),
    collections.auditChainHeads.deleteMany({ orgId }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

test("a vendor never starts out labeled compliant/reviewed -- securityReviewStatus defaults to not_reviewed", async () => {
  const { vendor } = await createVendor({ orgId, name: `Cloud Host Inc ${RUN_ID}`, service: "hosting", criticality: "high", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(vendor.securityReviewStatus, "not_reviewed");
  assert.equal(vendor.onboardingStatus, "REQUESTED");
});

test("the onboarding state machine walks REQUESTED through MONITORING in order", async () => {
  const { vendor } = await createVendor({ orgId, name: `Payments Processor ${RUN_ID}`, service: "payments", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const steps = [
    ["sendQuestionnaire", "SECURITY_QUESTIONNAIRE"],
    ["submitEvidence", "EVIDENCE"],
    ["submitForRiskAssessment", "RISK_ASSESSMENT"],
    ["submitForLegalReview", "LEGAL_REVIEW"],
    ["submitForProcurement", "PROCUREMENT"],
    ["approve", "APPROVED"],
    ["contract", "CONTRACTED"],
    ["beginMonitoring", "MONITORING"],
  ];
  let current = vendor;
  for (const [action, expected] of steps) {
    const result = await transitionVendorOnboarding({ orgId, vendorId: current._id, action, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
    assert.equal(result.vendor.onboardingStatus, expected, `after "${action}"`);
    current = result.vendor;
  }
});

test("reject is legal from any pre-approval state (array-form transition), but not from REQUESTED or an already-terminal state", async () => {
  const { vendor } = await createVendor({ orgId, name: `Risky Vendor ${RUN_ID}`, service: "analytics", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const cantRejectYet = await transitionVendorOnboarding({ orgId, vendorId: vendor._id, action: "reject", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(cantRejectYet.error !== undefined, true, "reject is not legal from REQUESTED -- REQUESTED isn't in reject's declared array");

  await transitionVendorOnboarding({ orgId, vendorId: vendor._id, action: "sendQuestionnaire", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { vendor: rejected } = await transitionVendorOnboarding({ orgId, vendorId: vendor._id, action: "reject", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(rejected.onboardingStatus, "REJECTED");

  const rejectAgain = await transitionVendorOnboarding({ orgId, vendorId: vendor._id, action: "reject", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(rejectAgain.error !== undefined, true, "REJECTED is a terminal state, not in reject's declared array");
});

test("findings and subprocessor changes are append-only logs", async () => {
  const { vendor } = await createVendor({ orgId, name: `Data Processor ${RUN_ID}`, service: "data_processing", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await recordVendorFinding({ orgId, vendorId: vendor._id, description: "TLS 1.0 still enabled", severity: "high", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { vendor: withTwoFindings } = await recordVendorFinding({ orgId, vendorId: vendor._id, description: "No MFA on admin console", severity: "critical", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(withTwoFindings.findings.length, 2);

  await recordSubprocessorChange({ orgId, vendorId: vendor._id, description: "Added AWS us-east-1 as a new subprocessor", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const stored = await collections.vendorRecords.findOne({ _id: vendor._id });
  assert.equal(stored.subprocessorChangeLog.length, 1);
});

test("SECURITY: listExpiringVendorItems() surfaces both certificates and contracts within the window, and flags already-expired ones", async () => {
  const { vendor } = await createVendor({ orgId, name: `Cert Vendor ${RUN_ID}`, service: "identity", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const now = Date.now();
  const in10Days = new Date(now + 10 * 24 * 60 * 60 * 1000).toISOString();
  const yesterday = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const in90Days = new Date(now + 90 * 24 * 60 * 60 * 1000).toISOString();

  await updateVendorExpiryDates({ orgId, vendorId: vendor._id, certificateExpiryDates: [in10Days, yesterday, in90Days], contractExpiryDate: in10Days, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  const expiring = await listExpiringVendorItems(orgId, { withinDays: 30 });
  const forThisVendor = expiring.filter((e) => e.vendorId.toString() === vendor._id.toString());
  // 2 certs within 30 days (in10Days, yesterday) + 1 contract within 30 days = 3; the 90-day cert must NOT appear.
  assert.equal(forThisVendor.length, 3);
  assert.ok(forThisVendor.some((e) => e.itemType === "contract"));
  assert.ok(forThisVendor.some((e) => e.alreadyExpired === true), "an already-expired certificate must be flagged, not silently included as merely 'upcoming'");
  assert.ok(!forThisVendor.some((e) => e.expiresAt === in90Days), "a certificate 90 days out must not appear in a 30-day window");
});
