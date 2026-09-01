// test/interop.test.mjs
//
// Interop SOW, Phase 11 (unit-test slice for Phase 2's abstraction layer --
// provider adapter shape, capability registry). Route discovery, transfer
// construction, and status tracking are still unimplemented stubs (Phase 3
// hasn't deployed anything yet), so those are tested as "reject clearly,"
// same pattern as test/chain-adapters.test.mjs's ChainAdapter boundary
// tests. Real integration tests against a deployed NTT route land once
// Phase 3 ships real contracts.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InteropProvider,
  WormholeProvider,
  LayerZeroProvider,
  getInteropProvider,
  TIERS,
  INTEROP_SUPPORT_LEVELS,
  INTEROP_CHAINS,
  getInteropCapability,
  listInteropCapabilities,
  isInteropTransferProven,
  WALLET_FAMILIES,
  getWalletFamilyForChain,
  isWalletReady,
} from "../src/lib/chain-adapters/interop/index.js";

test("InteropProvider: cannot be instantiated directly (abstract base)", () => {
  assert.throws(() => new InteropProvider("x"), /abstract/);
});

test("getInteropProvider: returns a real WormholeProvider, cached across calls", () => {
  const a = getInteropProvider();
  const b = getInteropProvider();
  assert.ok(a instanceof WormholeProvider);
  assert.strictEqual(a, b, "should be cached, not a new instance each call");
});

test("WormholeProvider: getRoute/estimateFee/sendTransfer/getTransferStatus reject clearly -- no Inaya-side deployment exists yet to back them", async () => {
  const provider = getInteropProvider();
  await assert.rejects(() => provider.getRoute(97, 1), /Not implemented/);
  await assert.rejects(() => provider.estimateFee({}), /Not implemented/);
  await assert.rejects(() => provider.sendTransfer({}), /Not implemented/);
  await assert.rejects(() => provider.getTransferStatus("x"), /Not implemented/);
});

test("WormholeProvider.getSupportedChains: REAL query against @wormhole-foundation/sdk-base -- every priority chain has confirmed live testnet Core+Token Bridge contracts", async () => {
  const provider = getInteropProvider();
  const chains = await provider.getSupportedChains();
  const priorityChains = ["ETHEREUM", "BSC", "ARBITRUM", "AVALANCHE", "POLYGON", "BASE", "OPTIMISM", "SOLANA", "SUI", "APTOS", "NEAR", "INJECTIVE", "SEI"];
  const foundKeys = chains.map((c) => c.inayaKey);
  for (const key of priorityChains) {
    assert.ok(foundKeys.includes(key), `${key} should have confirmed live Wormhole testnet infrastructure`);
  }
  for (const entry of chains) {
    assert.ok(entry.coreBridge, `${entry.inayaKey} should have a real core bridge address`);
    assert.ok(entry.tokenBridge, `${entry.inayaKey} should have a real token bridge address`);
    assert.ok(entry.family, `${entry.inayaKey} should have a resolved platform (Evm/Solana/Sui/...)`);
  }
});

test("LayerZeroProvider: declared, extends the same interface, still fully unimplemented (deferred per the evaluation)", async () => {
  const provider = new LayerZeroProvider();
  assert.ok(provider instanceof InteropProvider);
  await assert.rejects(() => provider.getSupportedChains(), /Not implemented/);
});

test("capabilityRegistry: every SOW-priority chain is present and honestly Tier C / ROUTE_AVAILABLE (nothing Inaya-side deployed yet)", () => {
  const priorityChains = ["ETHEREUM", "BSC", "ARBITRUM", "AVALANCHE", "POLYGON", "BASE", "OPTIMISM", "SOLANA", "SUI", "APTOS", "NEAR", "INJECTIVE", "SEI"];
  for (const key of priorityChains) {
    assert.ok(INTEROP_CHAINS[key], `${key} should be a declared interop chain`);
    const cap = getInteropCapability(key);
    assert.ok(cap, `${key} should have a capability entry`);
    assert.equal(cap.tier, TIERS.C_DESTINATION_DEPLOY, `${key} should honestly be Tier C until real deployment exists`);
    assert.equal(cap.level, INTEROP_SUPPORT_LEVELS.ROUTE_AVAILABLE, `${key} shouldn't claim more than ROUTE_AVAILABLE yet`);
    assert.equal(isInteropTransferProven(key), false, `${key} shouldn't claim a proven transfer -- none has been sent`);
  }
});

test("capabilityRegistry: an unknown chain key returns null, not a fabricated default", () => {
  assert.equal(getInteropCapability("MOONBEAM_TESTNET_NOT_A_REAL_KEY"), null);
});

test("listInteropCapabilities: returns exactly the declared chain set, each annotated", () => {
  const list = listInteropCapabilities();
  assert.equal(list.length, Object.keys(INTEROP_CHAINS).length);
  assert.ok(list.every((c) => typeof c.level === "number" && typeof c.levelLabel === "string" && typeof c.tier === "string"));
});

// ============================================================
// Phase 7 -- wallet family routing
// ============================================================
test("walletFamilies: EVM chains and Solana are wallet-ready today (existing, installed adapters)", () => {
  for (const key of ["ETHEREUM", "BSC", "ARBITRUM", "AVALANCHE", "POLYGON", "BASE", "OPTIMISM"]) {
    const wf = getWalletFamilyForChain(key);
    assert.equal(wf.family, WALLET_FAMILIES.EVM, `${key} should route to the EVM wallet family`);
    assert.equal(isWalletReady(key), true, `${key} should be wallet-ready -- MetaMask/WalletConnect already work`);
  }
  assert.equal(getWalletFamilyForChain("SOLANA").family, WALLET_FAMILIES.SOLANA);
  assert.equal(isWalletReady("SOLANA"), true);
});

test("walletFamilies: never forces MetaMask/EVM onto a non-EVM chain, and is honest that those aren't wallet-ready yet", () => {
  const nonEvmExpectations = { SUI: WALLET_FAMILIES.SUI, APTOS: WALLET_FAMILIES.APTOS, NEAR: WALLET_FAMILIES.NEAR, INJECTIVE: WALLET_FAMILIES.COSMOS, SEI: WALLET_FAMILIES.COSMOS };
  for (const [key, expectedFamily] of Object.entries(nonEvmExpectations)) {
    const wf = getWalletFamilyForChain(key);
    assert.equal(wf.family, expectedFamily, `${key} should NOT route to the EVM family`);
    assert.notEqual(wf.family, WALLET_FAMILIES.EVM, `${key} should never be forced onto MetaMask`);
    assert.equal(isWalletReady(key), false, `${key}'s wallet adapter isn't installed/wired yet -- shouldn't claim ready`);
  }
});

test("walletFamilies: Injective and Sei share the same Cosmos wallet family (one adapter, not two)", () => {
  assert.equal(getWalletFamilyForChain("INJECTIVE").package, getWalletFamilyForChain("SEI").package);
});

test("walletFamilies: an unknown chain key returns null, not a fabricated default", () => {
  assert.equal(getWalletFamilyForChain("NOT_A_REAL_CHAIN"), null);
});
