// test/resilience-status.test.mjs
//
// Autonomous Resilience Layer SOW, Phase 7 coverage: deriveState() is a
// pure function, tested directly with synthetic policy/testRun inputs --
// no Mongo, no real network calls needed to prove the SOW's own five
// states (VERIFIED/DEGRADED/FAILED/UNKNOWN/TEST_DUE) are computed
// correctly, matching this codebase's "don't present resilience that
// wasn't actually verified" discipline.
//
// Run with: node --test test/resilience-status.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { deriveState } from "../src/lib/resilience-status.js";
import mongoClientPromise from "../src/lib/mongodb.js";

// deriveState() itself is pure, but resilience-status.js transitively
// imports orgs.js -> mongodb.js, which opens a real connection at module
// load time -- close it so this otherwise-instant, DB-free test file
// doesn't hang waiting for an open handle (the same convention every
// Mongo-backed test file in this repo already follows in its after()).
after(async () => {
  const client = await mongoClientPromise;
  await client.close();
});

const dailyPolicy = {
  testFrequency: "daily",
  criticalAssetCategories: [{ label: "Finance", priority: "CRITICAL" }, { label: "Marketing", priority: "STANDARD" }],
};

function testRun({ ageHours = 1, overallResult = "PASS", rtoPass = true, rpoPass = true, assetResults = [] }) {
  return {
    completedAt: new Date(Date.now() - ageHours * 60 * 60 * 1000).toISOString(),
    overallResult, rtoPass, rpoPass, assetResults,
  };
}

test("UNKNOWN: no completed test run at all", () => {
  assert.equal(deriveState(dailyPolicy, null), "UNKNOWN");
});

test("TEST_DUE: the test window has elapsed, regardless of the old result", () => {
  const staleButPassing = testRun({ ageHours: 30, overallResult: "PASS" });
  assert.equal(deriveState(dailyPolicy, staleButPassing), "TEST_DUE", "a daily policy's test from 30 hours ago is overdue");
});

test("VERIFIED: a recent PASS within the test window", () => {
  assert.equal(deriveState(dailyPolicy, testRun({ ageHours: 2, overallResult: "PASS" })), "VERIFIED");
});

test("FAILED: an RTO breach fails the policy even if individual assets look fine", () => {
  const run = testRun({ ageHours: 2, overallResult: "FAIL", rtoPass: false, assetResults: [{ categoryLabel: "Finance", recovered: true, integrityPass: true, permissionPass: true, dependencyOk: true }] });
  assert.equal(deriveState(dailyPolicy, run), "FAILED");
});

test("FAILED: a CRITICAL-priority asset failing recovery is a hard FAILED, not merely DEGRADED", () => {
  const run = testRun({
    ageHours: 2, overallResult: "FAIL",
    assetResults: [{ categoryLabel: "Finance", recovered: false, integrityPass: false, permissionPass: true, dependencyOk: true }],
  });
  assert.equal(deriveState(dailyPolicy, run), "FAILED");
});

test("DEGRADED: only a STANDARD-priority asset failed, RTO/RPO both still pass -- a real distinction from FAILED", () => {
  const run = testRun({
    ageHours: 2, overallResult: "FAIL",
    assetResults: [
      { categoryLabel: "Finance", recovered: true, integrityPass: true, permissionPass: true, dependencyOk: true },
      { categoryLabel: "Marketing", recovered: false, integrityPass: false, permissionPass: true, dependencyOk: true },
    ],
  });
  assert.equal(deriveState(dailyPolicy, run), "DEGRADED");
});
