// test/pk-pricing.test.mjs -- Pakistan pricing: region choice and PKR packages (src/lib/pkPricing.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { pricingRegion, toPkPlan, pkPilotPrice, formatPkr, PK_PACKAGES } from "../src/lib/pkPricing.js";
import { PLANS, PLAN_ORDER } from "../src/lib/orgPlans.js";

test("visitors from Pakistan get PKR, everyone else USD", () => {
  assert.equal(pricingRegion({ country: "PK" }), "PK");
  assert.equal(pricingRegion({ country: "pk" }), "PK");
  assert.equal(pricingRegion({ country: "US" }), "INTL");
  assert.equal(pricingRegion({ country: "AE" }), "INTL");
  assert.equal(pricingRegion({}), "INTL");
});

test("a company's saved region wins over where its owner is today", () => {
  assert.equal(pricingRegion({ country: "AE", orgRegion: "PK" }), "PK");
  assert.equal(pricingRegion({ country: "PK", orgRegion: "INTL" }), "INTL");
  assert.equal(pricingRegion({ country: "PK", orgRegion: "junk" }), "PK");
});

test("every plan tier has a PKR package with the same limits and no USD figures", () => {
  for (const id of PLAN_ORDER) {
    const pk = toPkPlan(PLANS[id]);
    assert.ok(pk, id);
    assert.equal(pk.currency, "PKR");
    assert.equal(pk.paymentMethod, "bank_transfer");
    assert.equal(pk.contactSalesOnly, false);
    assert.equal(pk.maxUsers, PLANS[id].maxUsers);
    assert.equal(pk.maxStorageGB, PLANS[id].maxStorageGB);
    assert.equal(pk.priceMonthly, PK_PACKAGES[id].monthly);
    assert.notEqual(pk.priceMonthly, PLANS[id].priceMonthly);
  }
});

test("pilot price is 30% off, rounded to 100 rupees", () => {
  assert.equal(pkPilotPrice(8000), 5600);
  assert.equal(pkPilotPrice(20000), 14000);
  assert.equal(pkPilotPrice(30000), 21000);
  assert.equal(pkPilotPrice(60000), 42000);
  assert.equal(formatPkr(20000), "PKR 20,000");
});

test("pilot setup: free for the first 5 pilot companies, then the reduced pilot fee; standard fee outside the pilot", async () => {
  const { pkSetupFee, PK_PILOT } = await import("../src/lib/pkPricing.js");
  assert.equal(PK_PILOT.maxCompanies, 10);
  assert.equal(pkSetupFee("professional", { pilot: true, pilotsJoined: 0 }), 0);
  assert.equal(pkSetupFee("starter", { pilot: true, pilotsJoined: 4 }), 0);
  assert.equal(pkSetupFee("starter", { pilot: true, pilotsJoined: 5 }), 7500);
  assert.equal(pkSetupFee("business", { pilot: true, pilotsJoined: 9 }), 12500);
  assert.equal(pkSetupFee("business", { pilot: false }), 25000);
  assert.equal(pkSetupFee("starter", { pilot: false }), 10000);
});
