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

test("WormholeProvider: unimplemented methods reject clearly rather than silently no-op", async () => {
  const provider = getInteropProvider();
  await assert.rejects(() => provider.getSupportedChains(), /Not implemented/);
  await assert.rejects(() => provider.getRoute(97, 1), /Not implemented/);
  await assert.rejects(() => provider.estimateFee({}), /Not implemented/);
  await assert.rejects(() => provider.sendTransfer({}), /Not implemented/);
  await assert.rejects(() => provider.getTransferStatus("x"), /Not implemented/);
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
