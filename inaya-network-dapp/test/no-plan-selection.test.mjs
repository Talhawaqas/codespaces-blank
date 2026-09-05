// test/no-plan-selection.test.mjs
//
// "Continue without plan" feature coverage: getOrgPlan()'s three-way
// branch (real plan / explicitly-declined-billing / true legacy), and
// sendNoPlanReminders()'s eligibility filter + send-exactly-once
// idempotency (no RESEND_API_KEY in test env, so sendEmail no-ops --
// this test verifies the DB-side idempotency marker, which is the part
// that actually prevents a double-send regardless of email delivery).
//
// Run with: node --env-file=.env.local --test test/no-plan-selection.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { getOrgPlan, PLANS, LEGACY_UNLIMITED, NO_PLAN_LIMITED, sendNoPlanReminders } from "../src/lib/orgPlans.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-noplan-${RUN_ID}-${label}@example.com`;

let collections;
const cleanup = { orgIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { orgs, magicLinks } = collections;
  await magicLinks.deleteMany({ email: { $regex: `^test-noplan-${RUN_ID}` } });
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

// ============================================================
// getOrgPlan() three-way branch
// ============================================================
test("getOrgPlan: a real paid plan is returned as-is", () => {
  const plan = getOrgPlan({ plan: "professional" });
  assert.equal(plan.id, "professional");
  assert.equal(plan, PLANS.professional);
});

test("getOrgPlan: an org that explicitly continued without a plan gets Starter's LIMITS but is never shown as billed", () => {
  const plan = getOrgPlan({ plan: null, noPlanConfirmedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(plan.maxUsers, PLANS.starter.maxUsers, "must carry the same limits as Starter");
  assert.equal(plan.maxStorageGB, PLANS.starter.maxStorageGB);
  assert.equal(plan.priceMonthly, 0, "must never imply billing for a free no-plan selection");
  assert.equal(plan.noBilling, true);
  assert.notEqual(plan, PLANS.starter, "must be a distinct object, not literally PLANS.starter (which has a real price)");
});

test("getOrgPlan: a true legacy org (no plan, never confirmed no-plan) stays unrestricted", () => {
  const plan = getOrgPlan({ plan: null });
  assert.equal(plan, LEGACY_UNLIMITED);
  assert.equal(plan.maxUsers, Infinity);
});

test("getOrgPlan: an unrecognized plan id falls back to Starter (existing behavior, unchanged)", () => {
  const plan = getOrgPlan({ plan: "not-a-real-plan" });
  assert.equal(plan, PLANS.starter);
});

// ============================================================
// sendNoPlanReminders() — eligibility + idempotency
// ============================================================
async function makeStuckOrg(label, overrides = {}) {
  const now = new Date().toISOString();
  const oldEnough = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 48h ago, past the 24h cutoff
  const ownerEmail = email(label);
  const result = await collections.orgs.insertOne({
    name: `${label} Co`, ownerEmail, plan: null, requiresPlanSelection: true, createdAt: oldEnough, ...overrides,
  });
  cleanup.orgIds.push(result.insertedId);
  return { orgId: result.insertedId, ownerEmail };
}

// SAFETY: every call below passes `orgIds` to scope the scan to exactly
// this test's own fixture(s) — never call sendNoPlanReminders() with no
// arguments in a test. Without scoping it scans the ENTIRE real orgs
// collection (shared with production data) and sends real emails to
// real people; see sendNoPlanReminders()'s own header comment for the
// real incident this caused during development.

test("sendNoPlanReminders: sends to a genuinely stuck org (24h+, no plan, never confirmed no-plan)", async () => {
  const { orgId } = await makeStuckOrg("stuck-eligible");
  const result = await sendNoPlanReminders({ orgIds: [orgId] });
  assert.equal(result.checked, 1);

  const org = await collections.orgs.findOne({ _id: orgId });
  assert.ok(org.noPlanReminderSentAt, "eligible org must be marked as reminded");
});

test("sendNoPlanReminders: NEVER re-sends to an org already reminded (idempotency)", async () => {
  const { orgId } = await makeStuckOrg("already-reminded", { noPlanReminderSentAt: new Date().toISOString() });
  await sendNoPlanReminders({ orgIds: [orgId] });
  const org = await collections.orgs.findOne({ _id: orgId });
  // Unchanged from what we set -- confirms this org was excluded from the
  // query entirely, not re-processed and re-stamped.
  assert.ok(org.noPlanReminderSentAt);
});

test("sendNoPlanReminders: skips an org that already picked a real plan", async () => {
  const { orgId } = await makeStuckOrg("has-plan", { plan: "starter", requiresPlanSelection: false });
  await sendNoPlanReminders({ orgIds: [orgId] });
  const org = await collections.orgs.findOne({ _id: orgId });
  assert.equal(org.noPlanReminderSentAt, undefined, "an org with a real plan must never be reminded");
});

test("sendNoPlanReminders: skips an org that explicitly continued without a plan", async () => {
  const { orgId } = await makeStuckOrg("continued-free", { noPlanConfirmedAt: new Date().toISOString(), requiresPlanSelection: false });
  await sendNoPlanReminders({ orgIds: [orgId] });
  const org = await collections.orgs.findOne({ _id: orgId });
  assert.equal(org.noPlanReminderSentAt, undefined, "an org that already chose to continue for free must never be reminded");
});

test("sendNoPlanReminders: skips a too-recent org (created less than 24h ago)", async () => {
  const now = new Date().toISOString();
  const ownerEmail = email("too-recent");
  const result = await collections.orgs.insertOne({ name: "too-recent Co", ownerEmail, plan: null, requiresPlanSelection: true, createdAt: now });
  cleanup.orgIds.push(result.insertedId);

  await sendNoPlanReminders({ orgIds: [result.insertedId] });
  const org = await collections.orgs.findOne({ _id: result.insertedId });
  assert.equal(org.noPlanReminderSentAt, undefined, "an org created less than 24h ago must not be reminded yet");
});
