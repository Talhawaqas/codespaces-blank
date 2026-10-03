// test/proof-spotcheck.test.mjs -- the proof-of-storage audit's comparison logic, with injected chain/provider
// dependencies (no network). Run: node --env-file=.env.local --test --test-force-exit test/proof-spotcheck.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spotCheckFile, runProofSpotChecks, STATUS } from "../src/lib/proofOfStorage/spotcheck.js";
import { buildProofOfStoragePayload } from "../src/lib/merkle.js";
import { connectToDatabase } from "../src/lib/mongodb.js";

// A realistic ciphertext: several 256 KB chunks so tampering mid-file is exercised.
const ALPHA = "A".repeat(300_000) + "alpha-tail";
const BETA = "B".repeat(300_000) + "beta-tail";
const { root: ROOT, chunkCount: CHUNKS } = buildProofOfStoragePayload(ALPHA + BETA);

function deps(over = {}) {
  return {
    getOnChainRoot: async () => ({ root: ROOT.toLowerCase(), chunkCount: CHUNKS }),
    getReplicaRefs: async () => ({ alpha: [{ provider: "p1", providerRef: "a1" }], beta: [{ provider: "p1", providerRef: "b1" }] }),
    fetchShard: async ({ providerRef }) => (providerRef.startsWith("a") ? ALPHA : BETA),
    ...over,
  };
}

test("PASSED when the stored shards hash to the registered root", async () => {
  const r = await spotCheckFile("0xfile", { deps: deps() });
  assert.equal(r.status, STATUS.PASSED);
  assert.equal(r.computedRoot, r.registeredRoot);
  assert.equal(r.computedChunkCount, CHUNKS);
});

test("ROOT_MISMATCH when a single byte in the middle of a shard changed", async () => {
  const tampered = ALPHA.slice(0, 150_000) + "X" + ALPHA.slice(150_001);
  const r = await spotCheckFile("0xfile", { deps: deps({ fetchShard: async ({ providerRef }) => (providerRef.startsWith("a") ? tampered : BETA) }) });
  assert.equal(r.status, STATUS.ROOT_MISMATCH);
  assert.notEqual(r.computedRoot, r.registeredRoot);
  assert.match(r.detail, /no longer hash/);
});

test("ROOT_MISMATCH reports a truncated shard as a chunk-count difference", async () => {
  const r = await spotCheckFile("0xfile", { deps: deps({ fetchShard: async ({ providerRef }) => (providerRef.startsWith("a") ? ALPHA.slice(0, 100_000) : BETA) }) });
  assert.equal(r.status, STATUS.ROOT_MISMATCH);
  assert.match(r.detail, /chunk count differs/);
});

test("swapped shard order is detected (alpha and beta are not interchangeable)", async () => {
  const r = await spotCheckFile("0xfile", { deps: deps({ fetchShard: async ({ providerRef }) => (providerRef.startsWith("a") ? BETA : ALPHA) }) });
  assert.equal(r.status, STATUS.ROOT_MISMATCH);
});

test("falls back to another replica when the first provider fails, and still passes", async () => {
  const calls = [];
  const r = await spotCheckFile("0xfile", {
    deps: deps({
      getReplicaRefs: async () => ({ alpha: [{ provider: "down", providerRef: "a-bad" }, { provider: "up", providerRef: "a-good" }], beta: [{ provider: "up", providerRef: "b-good" }] }),
      fetchShard: async ({ provider, providerRef }) => { calls.push(provider); if (provider === "down") throw new Error("503"); return providerRef.startsWith("a") ? ALPHA : BETA; },
    }),
  });
  assert.equal(r.status, STATUS.PASSED);
  assert.ok(calls.includes("down") && calls.includes("up"));
  assert.equal(r.alphaProvider, "up");
});

test("FETCH_FAILED when every replica of a shard is unreachable (not a mismatch)", async () => {
  const r = await spotCheckFile("0xfile", { deps: deps({ fetchShard: async ({ providerRef }) => { if (providerRef.startsWith("b")) throw new Error("gateway timeout"); return ALPHA; } }) });
  assert.equal(r.status, STATUS.FETCH_FAILED);
  assert.match(r.detail, /beta/);
});

test("FETCH_FAILED when the registry read fails, NO_ROOT when nothing is registered, NO_REPLICAS when none are retrievable", async () => {
  assert.equal((await spotCheckFile("0xf", { deps: deps({ getOnChainRoot: async () => { throw new Error("rpc down"); } }) })).status, STATUS.FETCH_FAILED);
  assert.equal((await spotCheckFile("0xf", { deps: deps({ getOnChainRoot: async () => null }) })).status, STATUS.NO_ROOT);
  assert.equal((await spotCheckFile("0xf", { deps: deps({ getReplicaRefs: async () => ({ alpha: [], beta: [{ provider: "p", providerRef: "b" }] }) }) })).status, STATUS.NO_REPLICAS);
});

test("TOO_LARGE files are skipped, not hashed", async () => {
  const r = await spotCheckFile("0xf", { deps: deps(), maxBytes: 1000 });
  assert.equal(r.status, STATUS.TOO_LARGE);
});

test("runProofSpotChecks audits least-recently-checked files first, records outcomes, and rotates", async () => {
  const { db } = await connectToDatabase();
  const tag = `psc${Date.now()}`;
  const hashes = [`0x${tag}a`, `0x${tag}b`, `0x${tag}c`];
  await db.collection("metadata_files").insertMany(hashes.map((fileHash) => ({ fileHash, filename: "t", owner: "0xtest", deletedAt: null })));
  // c was audited an hour ago; a and b never.
  await db.collection("proof_spotchecks").insertOne({ fileHash: hashes[2], status: STATUS.PASSED, checkedAt: new Date(Date.now() - 3_600_000).toISOString(), checkCount: 1 });
  const seen = [];
  const d = deps({ getOnChainRoot: async (h) => { seen.push(h); return h.endsWith("b") ? null : { root: ROOT.toLowerCase(), chunkCount: CHUNKS }; } });
  try {
    const run = await runProofSpotChecks({ limit: 10, deps: d, only: hashes });
    const ours = run.results;
    assert.equal(ours.length, 3);
    assert.equal(ours.find((r) => r.fileHash === hashes[0]).status, STATUS.PASSED);
    assert.equal(ours.find((r) => r.fileHash === hashes[1]).status, STATUS.NO_ROOT);
    assert.ok(seen.indexOf(hashes[0]) < seen.indexOf(hashes[2]) && seen.indexOf(hashes[1]) < seen.indexOf(hashes[2]), "never-checked files are audited before the recently-checked one");
    const stored = await db.collection("proof_spotchecks").findOne({ fileHash: hashes[0] });
    assert.equal(stored.status, STATUS.PASSED);
    assert.equal(stored.checkCount, 1);
  } finally {
    await db.collection("metadata_files").deleteMany({ fileHash: { $in: hashes } });
    await db.collection("proof_spotchecks").deleteMany({ fileHash: { $in: hashes } });
  }
});
