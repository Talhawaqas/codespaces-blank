// Security hardening pass (September 2026): /api/feedback/upload previously trusted the
// client-supplied Content-Type outright and never scanned the bytes. Real Pinata network calls are
// intercepted (this is a public, real-money-billed account) but the magic-byte check and the real
// malware scanner (EICAR signature, static inspection) run for real, unmocked.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "../src/app/api/feedback/upload/route.js";
import { EICAR_TEST_STRING } from "../src/lib/support/scanner.js";

process.env.PINATA_JWT = process.env.PINATA_JWT || "test-jwt";
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://api.pinata.cloud/")) return new Response(JSON.stringify({ IpfsHash: "bafytestfakehash" }), { status: 200 });
  return realFetch(url, init);
};
after(() => { globalThis.fetch = realFetch; });

const REAL_PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"); // real PNG magic bytes + partial IHDR

function req(fd) {
  return new NextRequest("http://localhost/api/feedback/upload", { method: "POST", body: fd });
}

test("a real PNG with a matching Content-Type is accepted", async () => {
  const fd = new FormData();
  fd.append("file", new Blob([REAL_PNG], { type: "image/png" }), "shot.png");
  const res = await POST(req(fd));
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.ok(body.url.includes("bafytestfakehash"));
});

test("a file claiming to be a PNG but with different bytes is refused (spoofed Content-Type)", async () => {
  const fd = new FormData();
  fd.append("file", new Blob([Buffer.from("this is definitely not a png")], { type: "image/png" }), "evil.png");
  const res = await POST(req(fd));
  assert.equal(res.status, 415);
});

test("the real malware scanner refuses an EICAR test file even under an allowed type", async () => {
  const fd = new FormData();
  fd.append("file", new Blob([Buffer.from(EICAR_TEST_STRING)], { type: "text/plain" }), "note.txt");
  const res = await POST(req(fd));
  const body = await res.json();
  assert.equal(res.status, 422, JSON.stringify(body));
});

test("an unlisted MIME type is still refused before any bytes are inspected", async () => {
  const fd = new FormData();
  fd.append("file", new Blob([Buffer.from("MZ...")], { type: "application/x-msdownload" }), "evil.exe");
  const res = await POST(req(fd));
  assert.equal(res.status, 400);
});
