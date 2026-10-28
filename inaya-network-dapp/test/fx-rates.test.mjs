// test/fx-rates.test.mjs
//
// Business Workspace gap closure, Batch 3 — daily live exchange rates
// (src/lib/fx-rates.js) with a fake rate source. Snapshots use dates in
// 1999 so they never collide with real daily rows, and are removed after.
//
// Run with: node --env-file=.env.local --test test/fx-rates.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { refreshFxRates, convertAt, getRatesOn, setFxFetcher } from "../src/lib/fx-rates.js";
import { RATES_AS_OF } from "../src/lib/currency.js";
import mongoClientPromise from "../src/lib/mongodb.js";

let c;
const TEST_DATES = { $gte: "1999-01-01", $lte: "1999-12-31" };
const reply = (body, ok = true, status = 200) => async () => ({ ok, status, json: async () => body });
const GOOD = { result: "success", base_code: "USD", time_last_update_utc: "Mon, 04 Jan 1999 00:00:01 +0000", rates: { USD: 1, EUR: 0.85, GBP: 0.6, AED: 3.6725, PKR: 50, INR: 45, BDT: 60, JPY: 113 } };

before(async () => { await ensureOrgIndexes(); c = await getOrgCollections(); await c.fxRates.deleteMany({ date: TEST_DATES }); });
after(async () => { await c.fxRates.deleteMany({ date: TEST_DATES }); await (await mongoClientPromise).close(); });

test("refresh stores one dated snapshot of the supported currencies; re-running the same day updates it", async () => {
  setFxFetcher(reply(GOOD));
  assert.deepEqual(await refreshFxRates({ date: "1999-01-04" }), { stored: true, date: "1999-01-04" });
  setFxFetcher(reply({ ...GOOD, rates: { ...GOOD.rates, EUR: 0.86 } }));
  await refreshFxRates({ date: "1999-01-04" });
  const rows = await c.fxRates.find({ date: "1999-01-04" }).toArray();
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0].rates).sort(), ["AED", "BDT", "EUR", "GBP", "INR", "PKR", "USD"], "only supported currencies are kept");
  assert.equal(rows[0].rates.EUR, 0.86);
});

test("bad, partial or unreachable sources store nothing and never invent a rate", async () => {
  setFxFetcher(reply({}, false, 503));
  assert.equal((await refreshFxRates({ date: "1999-02-01" })).stored, false);
  setFxFetcher(reply({ ...GOOD, rates: { USD: 1, EUR: 0.9 } }));
  assert.match((await refreshFxRates({ date: "1999-02-01" })).error, /missing GBP/);
  setFxFetcher(reply({ ...GOOD, base_code: "EUR" }));
  assert.equal((await refreshFxRates({ date: "1999-02-01" })).stored, false);
  setFxFetcher(async () => { throw new Error("ENOTFOUND"); });
  assert.match((await refreshFxRates({ date: "1999-02-01" })).error, /unreachable/);
  assert.equal(await c.fxRates.countDocuments({ date: "1999-02-01" }), 0);
});

test("convertAt uses the snapshot on or before the date, labels it, and falls back to the static table", async () => {
  setFxFetcher(reply({ ...GOOD, rates: { ...GOOD.rates, EUR: 0.8 } }));
  await refreshFxRates({ date: "1999-03-01" });
  const live = await convertAt(80, "EUR", "USD", "1999-03-15");
  assert.deepEqual({ amount: live.convertedAmount, source: live.source, asOf: live.ratesAsOf }, { amount: 100, source: "live:1999-03-01", asOf: "1999-03-01" });
  assert.equal((await getRatesOn("1999-03-15")).date, "1999-03-01");
  const before1999 = await convertAt(92, "EUR", "USD", "1998-06-01");
  assert.deepEqual({ amount: before1999.convertedAmount, source: before1999.source }, { amount: 100, source: `static:${RATES_AS_OF}` });
  assert.match((await convertAt(1, "EUR", "XYZ", "1999-03-15")).error, /unavailable/);
});
