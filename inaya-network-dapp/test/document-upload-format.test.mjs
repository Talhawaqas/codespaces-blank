// test/document-upload-format.test.mjs -- which storage format a Business Workspace upload uses (17 Nov 2026):
// every file goes up chunked (about 1 byte stored per byte); a small file falls back to the original format only when
// the chunked storage is unavailable, and a refusal such as a plan limit is reported, never routed around.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

globalThis.window ||= globalThis; // clientCrypto.js uses window.crypto
const realFetch = globalThis.fetch;
let calls; let startStatus; let putOk;
beforeEach(() => { calls = []; startStatus = 200; putOk = true; });
after(() => { globalThis.fetch = realFetch; });

globalThis.fetch = async (url, init = {}) => {
  const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : null;
  const json = (status, obj, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...headers } });
  if (url === "/api/orgs/uploads/chunked") {
    calls.push(`chunked:${body.action}`);
    if (body.action === "start") return startStatus === 200 ? json(200, { uploadId: "u".repeat(24), token: "tok", pieceSize: 1024 * 1024, count: 1 }) : json(startStatus, { error: startStatus === 403 ? "Your plan's storage is full." : "Storage is unavailable." });
    if (body.action === "sign") return json(200, { pieces: [{ index: 0, alpha: { key: "a/0", url: "put:a/0" }, beta: { key: "b/0", url: "put:b/0" } }] });
    if (body.action === "manifests") return json(200, { alpha: { key: "alpha.json", url: "put:alpha.json" }, beta: { key: "beta.json", url: "put:beta.json" } });
    if (body.action === "abort") return json(200, { deleted: 0 });
  }
  if (String(url).startsWith("put:")) { calls.push("put"); return putOk ? new Response("", { status: 200, headers: { "x-amz-meta-cid": `cid-${url}` } }) : new Response("", { status: 500 }); }
  if (url === "/api/upload") { calls.push("legacy-pin"); return json(200, { IpfsHash: `legacy-${calls.length}` }); }
  throw new Error(`unexpected fetch ${url}`);
};

const { uploadDocumentFile } = await import("../src/components/viewer/documentFiles.js");
const small = () => new Blob([new Uint8Array(2048).fill(7)], { type: "application/pdf" });

test("a small file is uploaded in the chunked format and returns an upload token to register", async () => {
  const out = await uploadDocumentFile(small(), "pass", { orgId: "org1" });
  assert.ok(out.chunkedUploadToken, "registered with the chunked token");
  assert.ok(calls.includes("chunked:start") && calls.includes("put"));
  assert.ok(!calls.includes("legacy-pin"), "the original format was not used");
});

test("when the chunked storage is unavailable (503), a small file falls back to the original format", async () => {
  startStatus = 503;
  const out = await uploadDocumentFile(small(), "pass", { orgId: "org1" });
  assert.equal(out.chunkedUploadToken, undefined);
  assert.equal(calls.filter((c) => c === "legacy-pin").length, 2, "both shards pinned the original way");
});

test("when storage refuses the pieces, the partial upload is removed and the small file falls back", async () => {
  putOk = false;
  const out = await uploadDocumentFile(small(), "pass", { orgId: "org1" });
  assert.ok(calls.includes("chunked:abort"), "pieces that arrived are cleaned up");
  assert.ok(out.cidAlpha.startsWith("legacy-"));
});

test("a plan-limit refusal is reported, not routed around", async () => {
  startStatus = 403;
  await assert.rejects(uploadDocumentFile(small(), "pass", { orgId: "org1" }), /storage is full/);
  assert.ok(!calls.includes("legacy-pin"));
});
