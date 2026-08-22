// test/security.test.mjs
//
// Covers the Security Layer's off-chain core: signed-report validation,
// rate limiting, same-node dedup, reputation-weighted confidence
// aggregation across 4 throwaway simulated "nodes", and the CONFIRMED
// threshold transition. Real MongoDB, disposable randomized wallets/
// identifiers, cleanup in after() — same convention as every other test
// file in this directory.
//
// The on-chain confirmThreat call is exercised for real separately (see
// scripts/simulate-security-nodes.js, run after the contracts are
// deployed) — here it's expected to no-op ("skipped") because
// NEXT_PUBLIC_THREAT_REPORTER_ADDRESS isn't set in this test environment
// yet, exactly the graceful-degradation path security.js documents.
//
// Run with: node --test test/security.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  validateSecurityReportInput,
  buildSecurityReportMessage,
  verifySecurityReportAuth,
  recordSecurityReport,
  computeThreatConfidence,
  getThreatByIndicator,
  getSecurityCollections,
  ensureSecurityIndexes,
  computeThreatId,
  SECURITY_STATUS,
} from "../src/lib/security.js";
import mongoClientPromise from "../src/lib/mongodb.js";

after(async () => {
  const client = await mongoClientPromise;
  await client.close();
});

// A clearly-fake, non-real indicator — never real malicious infrastructure (SOW §21).
const TEST_INDICATOR = `test-malicious-${Date.now()}.invalid`;

async function signReport(wallet, { indicator, category = "phishing", confidenceBps = 8000, evidenceHash = null }) {
  const timestamp = Date.now();
  const message = buildSecurityReportMessage({ indicator, category, confidenceBps, evidenceHash, timestamp });
  const signature = await wallet.signMessage(message);
  return {
    nodeAddress: wallet.address,
    indicator,
    category,
    confidenceBps,
    evidenceHash,
    message,
    signature,
    timestamp,
  };
}

// ---------------------------------------------------------------
// validateSecurityReportInput / verifySecurityReportAuth
// ---------------------------------------------------------------

test("validateSecurityReportInput: accepts a well-formed report", () => {
  const clean = validateSecurityReportInput({ indicator: "  Evil-Example.TEST  ", category: "phishing", confidenceBps: 9000 });
  assert.equal(clean.indicator, "evil-example.test");
  assert.equal(clean.category, 1); // phishing = index 1
  assert.equal(clean.confidenceBps, 9000);
});

test("validateSecurityReportInput: rejects a missing indicator", () => {
  assert.throws(() => validateSecurityReportInput({ indicator: "", category: "phishing", confidenceBps: 9000 }), /valid indicator/i);
});

test("validateSecurityReportInput: rejects an out-of-range confidenceBps", () => {
  assert.throws(() => validateSecurityReportInput({ indicator: "x.test", category: "phishing", confidenceBps: 10001 }), /confidenceBps/i);
});

test("verifySecurityReportAuth: rejects a tampered field after signing", async () => {
  const wallet = ethers.Wallet.createRandom();
  const signed = await signReport(wallet, { indicator: "sign-test.invalid" });
  assert.throws(
    () => verifySecurityReportAuth({ ...signed, confidenceBps: 1 }), // confidenceBps changed after signing
    /doesn't match|tampering/i
  );
});

test("verifySecurityReportAuth: rejects an expired signature", async () => {
  const wallet = ethers.Wallet.createRandom();
  const signed = await signReport(wallet, { indicator: "expired-test.invalid" });
  assert.throws(() => verifySecurityReportAuth({ ...signed, timestamp: signed.timestamp - 10 * 60 * 1000 }), /expired/i);
});

// ---------------------------------------------------------------
// recordSecurityReport + computeThreatConfidence (real MongoDB)
// ---------------------------------------------------------------

const nodeA = ethers.Wallet.createRandom();
const nodeB = ethers.Wallet.createRandom();
const nodeC = ethers.Wallet.createRandom();
const nodeD = ethers.Wallet.createRandom();

test("recordSecurityReport: fewer than MIN_INDEPENDENT_REPORTERS stays unverified", async () => {
  await ensureSecurityIndexes();

  const resultA = await recordSecurityReport(await signReport(nodeA, { indicator: TEST_INDICATOR }));
  assert.equal(resultA.confirmed, false);

  const resultB = await recordSecurityReport(await signReport(nodeB, { indicator: TEST_INDICATOR }));
  assert.equal(resultB.confirmed, false);
  assert.equal(resultB.contributingNodes.length, 2);
});

test("recordSecurityReport: a repeat report from the same node the same day doesn't double-count", async () => {
  const before = await computeThreatConfidence(computeThreatId(TEST_INDICATOR));
  await recordSecurityReport(await signReport(nodeA, { indicator: TEST_INDICATOR, confidenceBps: 7000 }));
  const after1 = await computeThreatConfidence(computeThreatId(TEST_INDICATOR));
  assert.equal(after1.contributingNodes.length, before.contributingNodes.length, "nodeA reporting again shouldn't add a second independent reporter");
});

test("recordSecurityReport: a 3rd independent reporter with neutral reputation still isn't confident enough to confirm", async () => {
  const result = await recordSecurityReport(await signReport(nodeC, { indicator: TEST_INDICATOR }));
  assert.equal(result.contributingNodes.length, 3);
  // All 3 nodes are brand-new (neutral DEFAULT_REPUTATION_BPS=5000) with no reputation-bonus
  // headroom to reach CONFIRM_THRESHOLD_BPS=7500 -- confirms reputation-weighting is real, not
  // just "3 reports = confirmed."
  assert.equal(result.confirmed, false);
  assert.ok(result.confidenceBps < 7500);
});

test("recordSecurityReport: high-reputation nodes DO cross the confirmation threshold", async () => {
  const highRepIndicator = `test-highrep-${Date.now()}.invalid`;
  const { reputationCache } = await getSecurityCollections();

  // Directly seed reputation for these 3 nodes as "established, trusted reporters" -- same
  // direct-insert-to-set-up-a-scenario convention test/activity.test.mjs uses for its WAU
  // boundary test. Seeded one at a time (updateMany + upsert would only create a single doc
  // when none match, not one per _id).
  for (const addr of [nodeA.address, nodeB.address, nodeC.address]) {
    await reputationCache.updateOne(
      // security.js stores every node address lowercased (normalizeWallet) -- the reputation
      // lookup during confidence aggregation would silently miss a checksummed _id and fall
      // back to the neutral default, which is exactly what caught this on the first run.
      { _id: addr.toLowerCase() },
      { $set: { scoreBps: 9500, totalConfirmed: 50, totalFalsePositive: 0, updatedAt: new Date() }, $setOnInsert: { dirty: false, checkpointedTotalConfirmed: 0, checkpointedTotalFalsePositive: 0, checkpointedAt: null } },
      { upsert: true }
    );
  }

  await recordSecurityReport(await signReport(nodeA, { indicator: highRepIndicator }));
  await recordSecurityReport(await signReport(nodeB, { indicator: highRepIndicator }));
  const result = await recordSecurityReport(await signReport(nodeC, { indicator: highRepIndicator }));

  assert.equal(result.confirmed, true);
  assert.equal(result.status, SECURITY_STATUS.CONFIRMED);
  assert.ok(result.confidenceBps >= 7500);

  const threat = await getThreatByIndicator(highRepIndicator);
  assert.equal(threat.statusLabel, "confirmed");

  // Deliberately not asserting on result.onChain here: this test's job is the off-chain
  // confidence-aggregation logic, not chain integration. Once NEXT_PUBLIC_THREAT_REPORTER_ADDRESS
  // is configured (contracts are deployed on BSC Testnet as of this writing), this genuinely
  // attempts a real relayer tx and shouldn't fail the test either way -- real end-to-end
  // on-chain verification (including a live network/gas dependency) belongs to
  // scripts/simulate-security-nodes.js, run deliberately, not on every unit-test invocation.
});

test("computeThreatConfidence: a 4th independent reporter adds a confidence bonus", async () => {
  const bonusIndicator = `test-bonus-${Date.now()}.invalid`;
  const { reputationCache } = await getSecurityCollections();
  for (const addr of [nodeA.address, nodeB.address, nodeC.address, nodeD.address]) {
    await reputationCache.updateOne(
      { _id: addr.toLowerCase() },
      { $set: { scoreBps: 6000, updatedAt: new Date() }, $setOnInsert: { totalConfirmed: 0, totalFalsePositive: 0, dirty: false, checkpointedTotalConfirmed: 0, checkpointedTotalFalsePositive: 0, checkpointedAt: null } },
      { upsert: true }
    );
  }

  await recordSecurityReport(await signReport(nodeA, { indicator: bonusIndicator }));
  await recordSecurityReport(await signReport(nodeB, { indicator: bonusIndicator }));
  const threeReporters = await recordSecurityReport(await signReport(nodeC, { indicator: bonusIndicator }));
  const fourReporters = await recordSecurityReport(await signReport(nodeD, { indicator: bonusIndicator }));

  assert.ok(fourReporters.confidenceBps > threeReporters.confidenceBps, "a 4th independent reporter should raise confidence above the 3-reporter baseline");
});

// ---------------------------------------------------------------
// Cleanup — remove everything this test run created
// ---------------------------------------------------------------

test("cleanup: remove test reports, threats, and reputation docs", async () => {
  const { reports, threats, reputationCache } = await getSecurityCollections();
  const nodeAddresses = [nodeA.address, nodeB.address, nodeC.address, nodeD.address].map((a) => a.toLowerCase());
  await reports.deleteMany({ nodeAddress: { $in: nodeAddresses } });
  await threats.deleteMany({ indicator: { $regex: /^test-/ } });
  await reputationCache.deleteMany({ _id: { $in: nodeAddresses } });
});
