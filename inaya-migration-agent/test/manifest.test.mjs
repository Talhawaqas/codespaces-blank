// test/manifest.test.mjs -- real filesystem, no network. Covers the
// idempotency/resume contract the whole migration engine depends on
// (SOW §4.8).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Manifest, OBJECT_STATUS } from "../src/manifest.js";

async function tmpDir() {
  return mkdtemp(path.join(os.tmpdir(), "inaya-migrate-test-"));
}

test("a fresh manifest has no done keys", async () => {
  const dir = await tmpDir();
  const m = await Manifest.load(path.join(dir, "m.jsonl"));
  assert.equal(m.isDone("any-key"), false);
  await rm(dir, { recursive: true, force: true });
});

test("a MIGRATED record makes isDone true; a FAILED record does not", async () => {
  const dir = await tmpDir();
  const m = await Manifest.load(path.join(dir, "m.jsonl"));
  await m.record({ sourceKey: "a.txt", status: OBJECT_STATUS.MIGRATED });
  await m.record({ sourceKey: "b.txt", status: OBJECT_STATUS.FAILED });
  assert.equal(m.isDone("a.txt"), true);
  assert.equal(m.isDone("b.txt"), false, "a failed attempt must remain retryable, not silently treated as done");
  await rm(dir, { recursive: true, force: true });
});

test("reloading a manifest from disk restores prior state (resume across process restart)", async () => {
  const dir = await tmpDir();
  const file = path.join(dir, "m.jsonl");
  const first = await Manifest.load(file);
  await first.record({ sourceKey: "a.txt", status: OBJECT_STATUS.MIGRATED, byteSize: 10 });
  await first.record({ sourceKey: "b.txt", status: OBJECT_STATUS.MIGRATED, byteSize: 20 });

  // Simulate a fresh process reloading the same manifest file.
  const second = await Manifest.load(file);
  assert.equal(second.isDone("a.txt"), true);
  assert.equal(second.isDone("b.txt"), true);
  assert.equal(second.summary().totalObjects, 2);
  assert.equal(second.summary().totalBytes, 30);
  await rm(dir, { recursive: true, force: true });
});

test("a later record for the same key overrides an earlier one (retry-then-succeed)", async () => {
  const dir = await tmpDir();
  const file = path.join(dir, "m.jsonl");
  const m = await Manifest.load(file);
  await m.record({ sourceKey: "a.txt", status: OBJECT_STATUS.FAILED, failureReason: "network blip" });
  assert.equal(m.isDone("a.txt"), false);
  await m.record({ sourceKey: "a.txt", status: OBJECT_STATUS.MIGRATED, byteSize: 5 });
  assert.equal(m.isDone("a.txt"), true);

  const reloaded = await Manifest.load(file);
  assert.equal(reloaded.isDone("a.txt"), true, "the append log's LAST record for a key must win on reload");
  await rm(dir, { recursive: true, force: true });
});

test("a truncated final line (process killed mid-write) does not crash loading, and prior complete lines are preserved", async () => {
  const dir = await tmpDir();
  const file = path.join(dir, "m.jsonl");
  const m = await Manifest.load(file);
  await m.record({ sourceKey: "a.txt", status: OBJECT_STATUS.MIGRATED });
  const { appendFile } = await import("node:fs/promises");
  await appendFile(file, '{"sourceKey":"b.txt","status":"MIG'); // truncated, no trailing newline

  const reloaded = await Manifest.load(file);
  assert.equal(reloaded.isDone("a.txt"), true);
  assert.equal(reloaded.isDone("b.txt"), false);
  await rm(dir, { recursive: true, force: true });
});
