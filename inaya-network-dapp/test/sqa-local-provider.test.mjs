// SQA-025: the opt-in local pinning provider (development / CI only) has the provider interface, is never active on Vercel, and is only listed when configured.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inaya-local-pins-"));
const saved = { dir: process.env.INAYA_LOCAL_PIN_DIR, vercel: process.env.VERCEL };
after(() => { process.env.INAYA_LOCAL_PIN_DIR = saved.dir; if (saved.vercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = saved.vercel; if (saved.dir === undefined) delete process.env.INAYA_LOCAL_PIN_DIR; fs.rmSync(dir, { recursive: true, force: true }); });
const local = await import("../src/lib/pinningProviders/local.js");
const { listAvailableProviders } = await import("../src/lib/pinningProviders/index.js");

test("pin, fetch, status and unpin round-trip; unpin is idempotent", async () => {
  process.env.INAYA_LOCAL_PIN_DIR = dir; delete process.env.VERCEL;
  assert.equal(local.isConfigured(), true);
  const r = await local.pin("shard-content", { name: "s3-compat:org:key:doc:alpha" });
  assert.equal(r.provider, "local"); assert.equal(r.providerRef, "s3-compat:org:key:doc:alpha");
  assert.equal(await local.fetchReplica(r.providerRef), "shard-content"); assert.equal(await local.getPinStatus(r.providerRef), true);
  await local.unpin(r.providerRef); await local.unpin(r.providerRef);
  assert.equal(await local.getPinStatus(r.providerRef), false);
});

test("it is never configured without a directory or on Vercel, and only then appears among the available providers", () => {
  delete process.env.INAYA_LOCAL_PIN_DIR; assert.equal(local.isConfigured(), false); assert.equal(listAvailableProviders().includes("local"), false);
  process.env.INAYA_LOCAL_PIN_DIR = dir; process.env.VERCEL = "1"; assert.equal(local.isConfigured(), false, "no durable disk on Vercel");
  delete process.env.VERCEL; assert.equal(listAvailableProviders().includes("local"), true);
  assert.equal(listAvailableProviders().at(-1), "local", "it is last, so it is only a fallback");
});
