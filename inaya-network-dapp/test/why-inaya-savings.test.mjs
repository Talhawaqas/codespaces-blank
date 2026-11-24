// Why Inaya explainer arithmetic (SOW 6 + 11.5): deterministic, independently checked, never invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeResult, recommendConfig, normaliseAnswers, pickScenarios, formatMoney } from "../src/lib/whyInaya/savings.js";
import { pricingFacts } from "../src/lib/whyInaya/pricing.server.js";

const P = pricingFacts();

test("prices come from the canonical pricing code", () => {
  assert.equal(P.usd.professional, 39); assert.equal(P.usd.commerceStarter, 49); assert.equal(P.usd.bundle, 169); assert.equal(P.usd.enterprise, 799);
  assert.equal(P.pkr.professional, 20000); assert.equal(P.pkr.commerceStarter, 8000); assert.equal(P.pkr.bundle, 40000); assert.equal(P.usd.orderBlock, 15); assert.equal(P.pkr.orderBlock, 2500);
});

test("no costs entered: no consolidation figure is invented", () => {
  const r = computeResult({ region: "INTL", sellsInPerson: true }, P);
  assert.equal(r.consolidation, null); assert.equal(r.time, null);
  assert.deepEqual(r.config.lines.map((l) => l.amount), [39, 49]); assert.equal(r.config.monthlyTotal, 88);
});

test("one and several subscriptions: difference = entered spend - Inaya total", () => {
  const one = computeResult({ region: "INTL", sellsInPerson: true, tools: [{ category: "pos", monthlyCost: 89 }] }, P);
  assert.deepEqual(one.consolidation, { currentMonthly: 89, inayaMonthly: 88, difference: 1, categories: ["pos"] });
  const many = computeResult({ region: "INTL", sellsInPerson: true, tools: [{ category: "pos", monthlyCost: 89 }, { category: "accounting", monthlyCost: 30 }, { category: "ecommerce", monthlyCost: 39.5 }] }, P);
  assert.equal(many.consolidation.currentMonthly, 158.5); assert.equal(many.consolidation.difference, 70.5);
  const less = computeResult({ region: "INTL", sellsInPerson: true, tools: [{ category: "pos", monthlyCost: 20 }] }, P);
  assert.equal(less.consolidation.difference, -68, "a negative difference is shown honestly, not hidden");
});

test("PKR region uses PKR prices; the visitor's entered costs are in the same chosen currency", () => {
  const r = computeResult({ region: "PK", sellsInPerson: true, tools: [{ category: "pos", monthlyCost: 15000 }] }, P);
  assert.equal(r.currency, "PKR"); assert.equal(r.config.monthlyTotal, 28000); assert.equal(r.consolidation.difference, -13000);
});

test("branches, tills, connected stores and order blocks pick the cheapest covering configuration", () => {
  // two connected platforms need the Business add-on (1 Shopify + 1 WooCommerce)
  assert.equal(recommendConfig(normaliseAnswers({ region: "INTL", channels: ["shopify", "woocommerce"] }), P).monthlyTotal, 169);
  // 3-5 branches: bundle + 3 extra branches (5 - 2) = 169 + 57 = 226, cheaper than Enterprise 799
  const b = recommendConfig(normaliseAnswers({ region: "INTL", sellsInPerson: true, branches: "3-5" }), P);
  assert.equal(b.monthlyTotal, 226); assert.match(b.lines[1].label, /3 extra branches/);
  // 1,001-2,000 synced orders on Starter: 300 + 2 blocks = 2,300 -> 39 + 49 + 30 = 118
  const o = recommendConfig(normaliseAnswers({ region: "INTL", channels: ["shopify"], orders: "1001-2000" }), P);
  assert.equal(o.monthlyTotal, 118); assert.equal(o.plan, "professional");
  // 4,000+ orders: Starter would need 4 blocks (> 3), Business 4 blocks (> 3) -> Enterprise
  assert.equal(recommendConfig(normaliseAnswers({ region: "INTL", channels: ["shopify"], orders: "4000+" }), P).plan, "enterprise");
  // no selling at all: package by staff count, no Commerce
  assert.equal(recommendConfig(normaliseAnswers({ region: "INTL", staff: "1-2" }), P).monthlyTotal, 7.99);
  assert.equal(recommendConfig(normaliseAnswers({ region: "INTL", staff: "6-10" }), P).monthlyTotal, 99);
});

test("time cost: only from the visitor's numbers; the reduction is the visitor's own hypothetical", () => {
  const r = computeResult({ region: "INTL", time: { hoursPerWeek: 5, people: 2, hourlyCost: 10 } }, P);
  assert.equal(r.time.currentMonthlyCost, 433.33); assert.equal(r.time.hypotheticalMonthlyValue, null);
  const h = computeResult({ region: "INTL", time: { hoursPerWeek: 5, people: 2, hourlyCost: 10, reductionPct: 25 } }, P);
  assert.equal(h.time.hypotheticalMonthlyValue, 108.33);
});

test("zero, negative, extreme and invalid input", () => {
  const n = normaliseAnswers({ tools: [{ category: "pos", monthlyCost: -5 }, { category: "pos", monthlyCost: "abc" }, { category: "pos", monthlyCost: 5e9 }, { category: "rockets", monthlyCost: 10 }, { category: "crm", monthlyCost: 0 }], staff: "999", region: "MARS", time: { hoursPerWeek: 500 } });
  assert.deepEqual(n.tools, [{ category: "crm", monthlyCost: 0 }]); assert.equal(n.staff, null); assert.equal(n.region, null); assert.equal(n.time.hoursPerWeek, null);
  const r = computeResult({ tools: Array.from({ length: 50 }, () => ({ category: "other", monthlyCost: 1 })) }, P);
  assert.equal(r.consolidation.currentMonthly, 12, "at most 12 tools are counted");
  assert.equal(r.currency, "USD", "no region chosen: USD, never inferred from location");
});

test("rounding and formatting", () => {
  assert.equal(formatMoney(7.99, "USD"), "$7.99"); assert.equal(formatMoney(88, "USD"), "$88"); assert.equal(formatMoney(-68, "USD"), "-$68");
  assert.equal(formatMoney(28000, "PKR"), "PKR 28,000"); assert.equal(formatMoney(0.1 + 0.2, "USD"), "$0.30");
});

test("scenarios follow the answers, at most two", () => {
  assert.deepEqual(pickScenarios(normaliseAnswers({ sellsInPerson: true, channels: ["shopify"] })), ["retail", "omnichannel"]);
  assert.deepEqual(pickScenarios(normaliseAnswers({})), ["service", "resilience"]);
  assert.deepEqual(pickScenarios(normaliseAnswers({ sellsInPerson: true, challenge: "data_protection" })), ["retail", "resilience"]);
});

test("blank answers are 'not given', never zero (no time figure appears when none was entered)", () => {
  const r = computeResult({ region: "INTL", time: { hoursPerWeek: null, people: null, hourlyCost: null, reductionPct: null }, tools: [{ category: "pos", monthlyCost: null }, { category: "pos", monthlyCost: "" }] }, P);
  assert.equal(r.time, null); assert.equal(r.consolidation, null);
  assert.equal(computeResult({ time: { hoursPerWeek: 0, people: 2, hourlyCost: 10 } }, P).time.currentMonthlyCost, 0, "an explicit 0 is still a valid answer");
});
