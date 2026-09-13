// test/node-chain-reads.test.mjs
//
// Node Operator Dashboard SOW — nodeChainReads.js's read-only on-chain
// wrapper. Two things matter most: the 60s cache actually prevents a
// second RPC round trip (SOW §20's caching requirement), and an
// unregistered wallet gets the honest "not available" shape rather than a
// thrown error or a fabricated tier.
//
// The 60s cache is verified by mocking ethers.JsonRpcProvider.prototype.call
// (the low-level path every Contract view-function read goes through in
// ethers v6) rather than hitting the real testnet RPC — deterministic and
// fast, and proves the caching logic itself rather than network timing.
//
// Run with: node --test test/node-chain-reads.test.mjs

import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { getOnChainNodeInfo, getSettlementsForOperator } from "../src/lib/nodeChainReads.js";

// ABI-encodes a `nodes(address)` return tuple exactly the way the real
// contract would, so ethers' own decoder (not a stub) exercises the real
// path inside getOnChainNodeInfo().
const NODES_RETURN_TYPES = ["address", "uint256", "uint256", "uint8", "bool", "uint256"];

function encodeNodesResult({ wallet, capacityGB = 0, uptimeScore = 0, tier = 0, isRegistered = true, totalEarnedUsdt = 0n }) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return coder.encode(NODES_RETURN_TYPES, [wallet, capacityGB, uptimeScore, tier, isRegistered, totalEarnedUsdt]);
}

afterEach(() => {
  mock.restoreAll();
});

test("getOnChainNodeInfo: an unregistered wallet returns an honest not-available shape, never a fabricated tier", async () => {
  const wallet = ethers.Wallet.createRandom().address;
  mock.method(ethers.JsonRpcProvider.prototype, "call", async () => encodeNodesResult({ wallet, isRegistered: false }));

  const result = await getOnChainNodeInfo(wallet);
  assert.equal(result.isRegistered, false);
  assert.equal(result.tier, undefined, "must not invent a tier for an unregistered wallet");
});

test("getOnChainNodeInfo: a registered wallet's tier/earnings are decoded from the real chain response", async () => {
  const wallet = ethers.Wallet.createRandom().address;
  mock.method(ethers.JsonRpcProvider.prototype, "call", async () =>
    encodeNodesResult({ wallet, capacityGB: 5000, uptimeScore: 9800, tier: 2, isRegistered: true, totalEarnedUsdt: ethers.parseUnits("42.5", 18) })
  );

  const result = await getOnChainNodeInfo(wallet);
  assert.equal(result.isRegistered, true);
  assert.equal(result.tier, "Enterprise");
  assert.equal(result.commissionPct, 50, "Enterprise tier must map to the documented 50% commission");
  assert.equal(result.totalEarnedUsdt, "42.5");
});

test("getOnChainNodeInfo: a second call for the same wallet within the cache TTL does not hit the provider again", async () => {
  const wallet = ethers.Wallet.createRandom().address;
  const callMock = mock.method(ethers.JsonRpcProvider.prototype, "call", async () => encodeNodesResult({ wallet, isRegistered: true, tier: 0 }));

  await getOnChainNodeInfo(wallet);
  const callsAfterFirst = callMock.mock.callCount();
  await getOnChainNodeInfo(wallet);
  const callsAfterSecond = callMock.mock.callCount();

  assert.equal(callsAfterSecond, callsAfterFirst, "a cached read must not trigger another provider call");
});

test("getOnChainNodeInfo: an RPC failure returns a safe not-available shape instead of throwing", async () => {
  const wallet = ethers.Wallet.createRandom().address;
  mock.method(ethers.JsonRpcProvider.prototype, "call", async () => {
    throw new Error("network unreachable");
  });

  const result = await getOnChainNodeInfo(wallet);
  assert.equal(result.isRegistered, false);
  assert.ok(result.error);
});

test("getSettlementsForOperator: an RPC failure returns an empty list instead of throwing", async () => {
  const wallet = ethers.Wallet.createRandom().address;
  mock.method(ethers.JsonRpcProvider.prototype, "call", async () => {
    throw new Error("network unreachable");
  });

  const result = await getSettlementsForOperator(wallet);
  assert.deepEqual(result, []);
});
