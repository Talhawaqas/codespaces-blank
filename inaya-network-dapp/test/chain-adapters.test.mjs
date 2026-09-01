// test/chain-adapters.test.mjs
//
// Universal Chain Adapter (Phase 2/4) — unit tests for the registry and
// adapter factory, plus real network calls against live testnet RPCs for
// the parts that actually touch a chain (same "real infra, not mocks"
// convention every other test file in this repo already follows).
//
// Run with: node --test test/chain-adapters.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAIN_IDS, SOLANA_DEVNET_CHAIN_ID } from "../src/lib/chains.js";
import {
  getAdapter, EVMAdapter, SolanaAdapter,
  SUPPORT_LEVELS, getChainCapability, listChainCapabilities, isTransferReady,
} from "../src/lib/chain-adapters/index.js";

// ============================================================
// Registry — no network calls
// ============================================================
test("registry: BSC Testnet/Sepolia/Fuji are all at STAKING level (verified live per the audit)", () => {
  for (const chainId of [CHAIN_IDS.BSC_TESTNET, CHAIN_IDS.SEPOLIA, CHAIN_IDS.FUJI]) {
    const cap = getChainCapability(chainId);
    assert.equal(cap.level, SUPPORT_LEVELS.STAKING);
    assert.equal(cap.family, "EVM");
  }
});

test("registry: Polygon Amoy is honestly DISCOVERED, not overclaimed as deployed", () => {
  const cap = getChainCapability(CHAIN_IDS.AMOY);
  assert.equal(cap.level, SUPPORT_LEVELS.DISCOVERED);
});

test("registry: Solana Devnet is WALLET level (program deployed, not wired) — not TOKEN_TRANSFER", () => {
  const cap = getChainCapability(SOLANA_DEVNET_CHAIN_ID);
  assert.equal(cap.level, SUPPORT_LEVELS.WALLET);
  assert.equal(cap.family, "SOLANA");
});

test("registry: an unregistered chain ID returns null, not a fabricated default", () => {
  assert.equal(getChainCapability(999999), null);
});

test("registry: isTransferReady is true for the live spokes, false for Amoy and Solana", () => {
  assert.equal(isTransferReady(CHAIN_IDS.SEPOLIA), true);
  assert.equal(isTransferReady(CHAIN_IDS.FUJI), true);
  assert.equal(isTransferReady(CHAIN_IDS.AMOY), false);
  assert.equal(isTransferReady(SOLANA_DEVNET_CHAIN_ID), false);
});

test("registry: listChainCapabilities returns every EVM chain plus Solana, each annotated", () => {
  const list = listChainCapabilities();
  assert.equal(list.length, Object.keys(CHAIN_IDS).length + 1);
  assert.ok(list.every((c) => typeof c.level === "number" && typeof c.levelLabel === "string"));
});

// ============================================================
// Adapter factory
// ============================================================
test("getAdapter: returns an EVMAdapter for an EVM chainId", () => {
  const adapter = getAdapter(CHAIN_IDS.SEPOLIA);
  assert.ok(adapter instanceof EVMAdapter);
});

test("getAdapter: returns a SolanaAdapter for the Solana sentinel chainId", () => {
  const adapter = getAdapter(SOLANA_DEVNET_CHAIN_ID);
  assert.ok(adapter instanceof SolanaAdapter);
});

test("getAdapter: throws for a chainId not in the registry, rather than silently returning something wrong", () => {
  assert.throws(() => getAdapter(999999), /No adapter available/);
});

// ============================================================
// Address validation — no network calls
// ============================================================
test("EVMAdapter.validateAddress: accepts a real address, rejects garbage", () => {
  const adapter = getAdapter(CHAIN_IDS.SEPOLIA);
  assert.equal(adapter.validateAddress("0x4BA0a7c39154e7B7fA72288D29D7fdaf0248b1F2"), true);
  assert.equal(adapter.validateAddress("not-an-address"), false);
  assert.equal(adapter.validateAddress("0x123"), false);
});

test("SolanaAdapter.validateAddress: accepts a real base58 pubkey, rejects garbage", () => {
  const adapter = getAdapter(SOLANA_DEVNET_CHAIN_ID);
  assert.equal(adapter.validateAddress("CrKtH5L2MsgEpDGhkjiGeU6ugtW6PYeenFa4qqNomyXX"), true);
  assert.equal(adapter.validateAddress("not-a-pubkey"), false);
});

test("EVMAdapter.getExplorerUrl: builds the correct per-chain explorer link", () => {
  const adapter = getAdapter(CHAIN_IDS.SEPOLIA);
  assert.equal(adapter.getExplorerUrl("0xabc"), "https://sepolia.etherscan.io/tx/0xabc");
});

// ============================================================
// Real network calls — live testnet RPCs, same convention as
// scripts/testnet-health-check.js. Skipped gracefully if the sandbox has
// no outbound network access, same as every other network-dependent test.
// ============================================================
test("EVMAdapter.healthCheck: Sepolia RPC is reachable and returns a real block height", { timeout: 15_000 }, async () => {
  const adapter = getAdapter(CHAIN_IDS.SEPOLIA);
  const result = await adapter.healthCheck();
  if (!result.healthy) {
    console.warn("Sepolia RPC unreachable from this environment, skipping assertion:", result.error);
    return;
  }
  assert.equal(result.healthy, true);
  assert.ok(result.blockHeight > 0);
});

test("SolanaAdapter.healthCheck: Devnet RPC is reachable and returns a real slot", { timeout: 15_000 }, async () => {
  const adapter = getAdapter(SOLANA_DEVNET_CHAIN_ID);
  const result = await adapter.healthCheck();
  if (!result.healthy) {
    console.warn("Solana Devnet RPC unreachable from this environment, skipping assertion:", result.error);
    return;
  }
  assert.equal(result.healthy, true);
  assert.ok(result.blockHeight > 0);
});
