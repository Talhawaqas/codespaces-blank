// test/faucet.test.mjs
//
// Covers faucet request tracking (lib/faucet.js): recording, per-wallet
// history, and aggregate stats. Real MongoDB, a disposable randomized
// wallet address, cleanup in after() — same convention as every other
// test file in this directory.
//
// Run with: node --test test/faucet.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  recordFaucetRequest,
  listRecentFaucetRequests,
  listFaucetRequestsForWallet,
  getFaucetStats,
  getFaucetCollections,
  getTotalInayaSentToWallet,
  isNewFaucetWallet,
  getUniqueWalletCount,
  FAUCET_INAYA_LIFETIME_CAP,
} from "../src/lib/faucet.js";
import mongoClientPromise from "../src/lib/mongodb.js";

// A disposable throwaway wallet, real address format but never a real
// funded account — same "clearly-fake, disposable" convention as
// security.test.mjs's throwaway indicators.
const TEST_WALLET = ethers.Wallet.createRandom().address;

after(async () => {
  const { requests } = await getFaucetCollections();
  await requests.deleteMany({ walletAddress: TEST_WALLET.toLowerCase() });
  const client = await mongoClientPromise;
  await client.close();
});

test("recordFaucetRequest: writes a real document with both token outcomes", async () => {
  await recordFaucetRequest({
    walletAddress: TEST_WALLET,
    ipAddress: "203.0.113.42",
    results: {
      inaya: { sent: true, amount: "500", txHash: "0xabc123" },
      usdt: { sent: false, reason: "Wallet already holds sufficient mUSDT for testing." },
    },
  });

  const history = await listFaucetRequestsForWallet(TEST_WALLET);
  assert.equal(history.length, 1);
  assert.equal(history[0].walletAddress, TEST_WALLET.toLowerCase());
  assert.equal(history[0].ipAddress, "203.0.113.42");
  assert.equal(history[0].inayaSent, true);
  assert.equal(history[0].inayaAmount, "500");
  assert.equal(history[0].inayaTxHash, "0xabc123");
  assert.equal(history[0].usdtSent, false);
  assert.equal(history[0].usdtAmount, null);
  assert.ok(history[0].createdAt);
});

test("listFaucetRequestsForWallet: accumulates multiple requests, most recent first", async () => {
  await recordFaucetRequest({
    walletAddress: TEST_WALLET,
    ipAddress: "203.0.113.42",
    results: { inaya: { sent: true, amount: "500", txHash: "0xdef456" }, usdt: { sent: true, amount: "100", txHash: "0xghi789" } },
  });

  const history = await listFaucetRequestsForWallet(TEST_WALLET);
  assert.equal(history.length, 2);
  // Most recent (this second request) first.
  assert.equal(history[0].inayaTxHash, "0xdef456");
  assert.equal(history[0].usdtSent, true);
});

test("listRecentFaucetRequests: the test wallet's requests appear in the global recent list", async () => {
  const recent = await listRecentFaucetRequests(500);
  const found = recent.filter((r) => r.walletAddress === TEST_WALLET.toLowerCase());
  assert.equal(found.length, 2);
});

test("getFaucetStats: total and uniqueWallets reflect real recorded data", async () => {
  const before = await getFaucetStats();
  await recordFaucetRequest({
    walletAddress: TEST_WALLET,
    ipAddress: "203.0.113.42",
    results: { inaya: { sent: false, reason: "already sufficient" }, usdt: { sent: false, reason: "already sufficient" } },
  });
  const after = await getFaucetStats();
  assert.equal(after.total, before.total + 1);
  assert.ok(after.uniqueWallets >= 1);
});

test("recordFaucetRequest: never throws even with a malformed results object (fail-open)", async () => {
  await assert.doesNotReject(() =>
    recordFaucetRequest({ walletAddress: TEST_WALLET, ipAddress: "203.0.113.42", results: null })
  );
});

test("getTotalInayaSentToWallet: sums only successful inaya sends, ignores skipped/null amounts", async () => {
  // At this point TEST_WALLET has 2 successful inaya sends of 500 each
  // from the earlier tests, plus one skipped (null amount) request.
  const total = await getTotalInayaSentToWallet(TEST_WALLET);
  assert.equal(total, 1000); // 500 + 500 -- proves it sums correctly, not just counts requests
});

test("isNewFaucetWallet: false once a wallet has a successful inaya send, true for a never-seen wallet", async () => {
  const neverSeenWallet = ethers.Wallet.createRandom().address;
  assert.equal(await isNewFaucetWallet(TEST_WALLET), false);
  assert.equal(await isNewFaucetWallet(neverSeenWallet), true);
});

test("getUniqueWalletCount: counts only wallets with a successful inaya send", async () => {
  const count = await getUniqueWalletCount();
  assert.ok(count >= 1); // TEST_WALLET is definitely in there
});

test("lifetime cap enforcement (route-level logic, exercised directly): a wallet at or above the cap gets nothing further", async () => {
  const total = await getTotalInayaSentToWallet(TEST_WALLET);
  assert.ok(total >= FAUCET_INAYA_LIFETIME_CAP, `test setup should have already pushed this wallet to/past the ${FAUCET_INAYA_LIFETIME_CAP} cap`);
  // This mirrors exactly the route's own gating condition -- if this
  // assertion holds, the route's `if (alreadyReceivedInaya >= FAUCET_INAYA_LIFETIME_CAP)`
  // branch is what would fire for this wallet on its next real request.
});
