// test/plan-changes.test.mjs -- one package per company, capped extra users (src/lib/orgPlans.js, src/lib/billingRequests.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PLANS, getOrgPlan, withExtraUsers, planChangeError } from "../src/lib/orgPlans.js";
import { pkAmountFor } from "../src/lib/billingRequests.js";

test("each package caps its extra users", () => {
  assert.equal(PLANS.starter.maxExtraUsers, 3);
  assert.equal(PLANS.professional.maxExtraUsers, 10);
  assert.equal(PLANS.business.maxExtraUsers, 15);
  assert.equal(PLANS.enterprise.maxExtraUsers, 20);
});

test("extra users raise the seat limit, never past the cap", () => {
  assert.equal(getOrgPlan({ plan: "starter" }).maxUsers, 2);
  assert.equal(getOrgPlan({ plan: "starter", extraUsers: 2 }).maxUsers, 4);
  assert.equal(getOrgPlan({ plan: "starter", extraUsers: 9 }).maxUsers, 5);
  assert.equal(getOrgPlan({ plan: "professional", extraUsers: 10 }).maxUsers, 15);
  assert.equal(getOrgPlan({ plan: "enterprise", extraUsers: 20 }).maxUsers, 45);
  assert.equal(withExtraUsers(PLANS.business, -4), PLANS.business);
  assert.equal(getOrgPlan({ plan: "business", extraUsers: 3 }).includedUsers, 10);
});

test("a paid-up company cannot buy its package again or move down", () => {
  const base = { currentPlanId: "professional", active: true };
  assert.match(planChangeError({ ...base, planId: "professional" }), /already has/);
  assert.match(planChangeError({ ...base, planId: "starter" }), /smaller package/);
  assert.equal(planChangeError({ ...base, planId: "business" }), null);
  assert.equal(planChangeError({ ...base, planId: "professional", extraUsers: 2 }), null);
  assert.match(planChangeError({ ...base, currentExtraUsers: 4, planId: "professional", extraUsers: 4 }), /already has/);
  assert.equal(planChangeError({ ...base, planId: "professional", renewalDue: true }), null);
});

test("extra users above the cap are refused; no active package means anything goes", () => {
  assert.match(planChangeError({ planId: "starter", extraUsers: 4 }), /up to 3 extra users/);
  assert.match(planChangeError({ planId: "starter", extraUsers: 1.5 }), /whole number/);
  assert.equal(planChangeError({ currentPlanId: "business", active: false, planId: "starter" }), null);
});

test("PKR amounts include extra users at PKR 2,500 (1,750 in the pilot)", () => {
  assert.equal(pkAmountFor("starter", "month", false, 3), 8000 + 7500);
  assert.equal(pkAmountFor("starter", "month", true, 3), 5600 + 5250);
  assert.equal(pkAmountFor("professional", "year", false, 2), 200000 + 50000);
  assert.equal(pkAmountFor("business", "month", true, 0), 21000);
});
