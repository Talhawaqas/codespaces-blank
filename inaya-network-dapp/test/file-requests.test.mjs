// test/file-requests.test.mjs -- file requests (Sharing 2.0 B3): the browser-side cryptography (real WebCrypto), the server rules against the real
// database, and the HTTP routes. The central claims: the server only ever holds ciphertext; the public side can submit and nothing else; limits
// hold under concurrency; an upload cannot be read by anyone but the requester.
// Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=400000 test/file-requests.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server.js";
import { setup, teardown, makeChatOrg, cookieFor, c as cols } from "./_chat-fixtures.mjs";
import { SESSION_COOKIE, getOrgCollections } from "../src/lib/orgs.js";
import { setOrgFeature } from "../src/lib/featureFlags.js";
import * as C from "../src/lib/filerequests/clientCrypto.js";
import * as R from "../src/lib/filerequests/requests.js";

const T = { timeout: 400000 };
const FUT = (ms = 86400_000) => new Date(Date.now() + ms).toISOString();
const PASS = "correct horse battery staple";
const FAST = { iterations: 2000 }; // the real default is 310k; the tests only need the same code path
const code = (p) => p.then(() => null, (e) => e);
let org, other, db, keys;

// ---------------------------------------------------------------- crypto (no database)
test("crypto: a file round-trips through the sealed key, and only the passphrase holder can open it", T, async () => {
  const k = await C.generateRequestKeys(PASS, FAST);
  assert.equal(k.publicKeyJwk.kty, "EC"); assert.equal(k.publicKeyJwk.crv, "P-256"); assert.equal(C.isValidPublicKeyJwk(k.publicKeyJwk), true);
  assert.equal(JSON.stringify(k.publicKeyJwk).includes('"d"'), false, "the public key carries no private part");
  const data = new Uint8Array(randomBytes(3 * 1024 * 1024 + 17)); data.set(new TextEncoder().encode("TOP-SECRET-MARKER"), 5000);
  const enc = await C.encryptForRequest(k.publicKeyJwk, data, { name: "contract.pdf", type: "application/pdf" }, "req-1");
  assert.ok(enc.ciphertext.length > data.length && enc.ciphertext.length < data.length + 8192, "overhead is a header and a tag");
  assert.equal(Buffer.from(enc.ciphertext).includes(Buffer.from("TOP-SECRET-MARKER")), false);
  assert.equal(enc.keyEnvelope.includes("TOP-SECRET"), false);
  const priv = await C.unwrapPrivateKey(k.wrappedPrivateKey, PASS);
  const out = await C.decryptFromRequest(priv, enc.keyEnvelope, enc.ciphertext, "req-1");
  assert.equal(out.meta.name, "contract.pdf"); assert.equal(out.meta.size, data.length); assert.equal(Buffer.compare(Buffer.from(out.bytes), Buffer.from(data)), 0);
  await assert.rejects(() => C.unwrapPrivateKey(k.wrappedPrivateKey, PASS + "x"), /passphrase/);
  await assert.rejects(() => C.unwrapPrivateKey("{not json", PASS), /damaged/);
  await assert.rejects(() => C.generateRequestKeys("short"), /at least 10/);
});

test("crypto: tampering, moving an upload to another request, and another request's key all fail", T, async () => {
  const k = await C.generateRequestKeys(PASS, FAST); const k2 = await C.generateRequestKeys(PASS, FAST);
  const enc = await C.encryptForRequest(k.publicKeyJwk, new TextEncoder().encode("hello"), { name: "a.txt" }, "req-A");
  const priv = await C.unwrapPrivateKey(k.wrappedPrivateKey, PASS); const priv2 = await C.unwrapPrivateKey(k2.wrappedPrivateKey, PASS);
  const flipped = new Uint8Array(enc.ciphertext); flipped[flipped.length - 3] ^= 1;
  await assert.rejects(() => C.decryptFromRequest(priv, enc.keyEnvelope, flipped, "req-A"));
  await assert.rejects(() => C.decryptFromRequest(priv, enc.keyEnvelope, enc.ciphertext, "req-B"), undefined, "bound to its request");
  await assert.rejects(() => C.decryptFromRequest(priv2, enc.keyEnvelope, enc.ciphertext, "req-A"), undefined, "a different key cannot open it");
  const env = JSON.parse(enc.keyEnvelope); env.sealed = Buffer.from(randomBytes(48)).toString("base64");
  await assert.rejects(() => C.decryptFromRequest(priv, JSON.stringify(env), enc.ciphertext, "req-A"));
  await assert.rejects(() => C.decryptFromRequest(priv, JSON.stringify({ ...JSON.parse(enc.keyEnvelope), v: 2 }), enc.ciphertext, "req-A"), /Unsupported/);
  await assert.rejects(() => C.encryptForRequest({ kty: "EC", crv: "P-256", x: "bad", y: "bad" }, new Uint8Array(1), {}, "x"), /not valid/);
  assert.equal(C.isValidPublicKeyJwk({ kty: "RSA" }), false); assert.equal(C.isValidPublicKeyJwk(null), false);
  const e2 = await C.encryptForRequest(k.publicKeyJwk, new Uint8Array(0), { name: "empty" }, "req-A");
  assert.equal((await C.decryptFromRequest(priv, e2.keyEnvelope, e2.ciphertext, "req-A")).bytes.length, 0, "an empty file is fine at the crypto layer");
  const a = await C.encryptForRequest(k.publicKeyJwk, new TextEncoder().encode("same"), {}, "r"); const b = await C.encryptForRequest(k.publicKeyJwk, new TextEncoder().encode("same"), {}, "r");
  assert.notEqual(Buffer.compare(Buffer.from(a.ciphertext), Buffer.from(b.ciphertext)), 0, "fresh key and nonce every time");
});

// ---------------------------------------------------------------- server rules (real database)
before(async () => {
  await setup(); db = (await getOrgCollections()).db;
  org = await makeChatOrg("freq"); other = await makeChatOrg("freq-other", { people: ["eve"] });
  keys = await C.generateRequestKeys(PASS, FAST);
});
after(async () => {
  const ids = [org.orgId, other.orgId];
  const reqs = await db.collection("file_requests").find({ orgId: { $in: ids } }).project({ _id: 1 }).toArray();
  const ups = await db.collection("file_request_uploads").find({ requestId: { $in: reqs.map((r) => String(r._id)) } }).project({ _id: 1 }).toArray();
  await db.collection("file_request_parts").deleteMany({ uploadId: { $in: ups.map((u) => String(u._id)) } });
  await db.collection("file_request_uploads").deleteMany({ requestId: { $in: reqs.map((r) => String(r._id)) } });
  await db.collection("file_requests").deleteMany({ orgId: { $in: ids } });
  await teardown();
});

const base = (o = {}) => ({ title: "Q3 documents", instructions: "Please upload your signed forms.", expiresAt: FUT(), maxFiles: 5, publicKeyJwk: keys.publicKeyJwk, wrappedPrivateKey: keys.wrappedPrivateKey, ...o });
const mk = async (o = {}, who = org.alice) => R.createRequest({ orgId: org.oid, actorEmail: who.email, input: base(o) });
const ident = { name: "Dana Visitor", email: "dana@example.org", company: "Visitor Co" };
async function send(token, requestId, bytes, { name = "form.pdf", ext = "pdf", uploader = ident, ip = "203.0.113.5" } = {}) {
  const enc = await C.encryptForRequest(keys.publicKeyJwk, bytes, { name, type: "application/pdf" }, requestId);
  const partCount = Math.max(1, Math.ceil(enc.ciphertext.length / R.LIMITS.partBytes));
  const b = await R.beginUpload({ token, uploader, ext, size: enc.ciphertext.length, partCount, keyEnvelope: enc.keyEnvelope, ip });
  for (let i = 0; i < partCount; i++) await R.uploadPart({ token, uploadId: b.uploadId, uploadKey: b.uploadKey, index: i, data: Buffer.from(enc.ciphertext.subarray(i * R.LIMITS.partBytes, (i + 1) * R.LIMITS.partBytes)).toString("base64") });
  return { ...b, enc, partCount, complete: () => R.completeUpload({ token, uploadId: b.uploadId, uploadKey: b.uploadKey }) };
}

test("creation: validation of every field, token shown once, only its hash stored", T, async () => {
  const made = await mk({ allowedExtensions: [".PDF", "docx"], classification: "CONFIDENTIAL", label: "Acme" });
  assert.ok(made.token.length >= 40); assert.equal(made.request.status, "open"); assert.deepEqual(made.request.allowedExtensions, ["pdf", "docx"]);
  const row = await db.collection("file_requests").findOne({ _id: new (await import("mongodb")).ObjectId(made.requestId) });
  assert.equal(JSON.stringify(row).includes(made.token), false); assert.equal(row.tokenHash.length, 64);
  for (const [bad, why] of [[{ title: "" }, "title"], [{ expiresAt: FUT(-1000) }, "past expiry"], [{ expiresAt: FUT(100 * 86400_000) }, "too far"], [{ maxFiles: 0 }, "zero files"], [{ maxFiles: 1000 }, "too many"], [{ maxFileBytes: 10 ** 9 }, "too big"],
    [{ allowedExtensions: ["pdf!"] }, "bad ext"], [{ classification: "TOP" }, "classification"], [{ publicKeyJwk: { kty: "EC" } }, "key"], [{ wrappedPrivateKey: "" }, "wrapped"], [{ wrappedPrivateKey: "{}" }, "wrapped shape"]])
    assert.equal((await code(mk(bad))).status, 400, why);
});

test("public info shows what the uploader needs and nothing else; dead links say only that they are dead", T, async () => {
  const { token, requestId } = await mk();
  const info = await R.publicInfo(token);
  assert.equal(info.status, "open"); assert.equal(info.title, "Q3 documents"); assert.deepEqual(info.publicKeyJwk, keys.publicKeyJwk); assert.equal(info.remaining, 5);
  const dump = JSON.stringify(info); for (const bad of ["wrappedPrivateKey", "createdByEmail", "tokenHash", org.alice.email, "uploads"]) assert.equal(dump.includes(bad), false, `${bad} is not public`);
  assert.equal((await code(R.publicInfo("nope"))).status, 404);
  await R.revokeRequest({ orgId: org.oid, requestId, actorEmail: org.alice.email, membership: org.alice.membership });
  const dead = await R.publicInfo(token); assert.equal(dead.status, "revoked"); assert.equal(dead.title, undefined);
});

test("the full upload: begin, parts, complete; the server holds ciphertext only; the requester decrypts it", T, async () => {
  const { token, requestId } = await mk();
  const data = new Uint8Array(randomBytes(R.LIMITS.partBytes * 2 + 99)); data.set(new TextEncoder().encode("PLAINTEXT-MARKER-77"), 100);
  const up = await send(token, requestId, data, { name: "big.pdf" });
  assert.equal(up.partCount, 3);
  const receipt = await up.complete(); assert.ok(receipt.receiptId); assert.equal((await up.complete()).duplicate, true, "completing twice is harmless");
  const stored = await db.collection("file_request_parts").find({ uploadId: up.uploadId }).toArray();
  const all = Buffer.concat(stored.sort((a, b) => a.index - b.index).map((p) => Buffer.from(p.data.buffer)));
  assert.equal(all.includes(Buffer.from("PLAINTEXT-MARKER-77")), false, "only ciphertext is stored");
  const row = await db.collection("file_request_uploads").findOne({ _id: new (await import("mongodb")).ObjectId(up.uploadId) });
  assert.equal(JSON.stringify(row).includes("big.pdf"), false, "the file name travels inside the ciphertext, not in the row");
  assert.equal(JSON.stringify(row).includes(up.uploadKey), false, "only a hash of the upload key is stored");
  const detail = await R.getRequest({ orgId: org.oid, requestId, actorEmail: org.alice.email, membership: org.alice.membership });
  assert.equal(detail.received, 1); assert.equal(detail.uploads.length, 1); assert.equal(detail.uploads[0].uploaderEmail, ident.email); assert.equal(detail.uploads[0].ipMasked, "203.0.113.0");
  const parts = []; for (let i = 0; i < detail.uploads[0].partCount; i++) parts.push(Buffer.from((await R.readUploadPart({ orgId: org.oid, requestId, uploadId: up.uploadId, index: i, actorEmail: org.alice.email, membership: org.alice.membership })).data, "base64"));
  const priv = await C.unwrapPrivateKey(detail.wrappedPrivateKey, PASS);
  const out = await C.decryptFromRequest(priv, detail.uploads[0].keyEnvelope, new Uint8Array(Buffer.concat(parts)), requestId);
  assert.equal(out.meta.name, "big.pdf"); assert.equal(Buffer.compare(Buffer.from(out.bytes), Buffer.from(data)), 0);
});

test("restrictions: identity fields, extension list, risky types, size, part count, malformed input", T, async () => {
  const { token, requestId } = await mk({ allowedExtensions: ["pdf"], maxFileBytes: 200_000 });
  const tiny = new Uint8Array(100);
  assert.equal((await code(send(token, requestId, tiny, { uploader: { email: "a@b.co" } }))).status, 400, "name required");
  assert.equal((await code(send(token, requestId, tiny, { uploader: { name: "x", email: "not-an-email" } }))).status, 400, "valid email required");
  const bad = await code(send(token, requestId, tiny, { ext: "docx", name: "x.docx" })); assert.equal(bad.status, 400); assert.equal(bad.code, "TYPE_NOT_ALLOWED");
  assert.equal((await code(send(token, requestId, new Uint8Array(300_000)))).code, "TOO_LARGE");
  const open = await mk({}); // no list: risky types are refused unless the requester names them
  assert.equal((await code(send(open.token, open.requestId, tiny, { ext: "exe", name: "setup.exe" }))).code, "TYPE_NOT_ALLOWED");
  assert.equal((await code(send(open.token, open.requestId, tiny, { ext: "docm", name: "m.docm" }))).code, "TYPE_NOT_ALLOWED");
  const explicit = await mk({ allowedExtensions: ["exe"] }); assert.ok((await send(explicit.token, explicit.requestId, tiny, { ext: "exe", name: "setup.exe" })).uploadId, "a requester can explicitly allow it");
  for (const evil of ["../x", "a b", "p.d.f", "x".repeat(20)]) assert.equal((await code(R.beginUpload({ token: open.token, uploader: ident, ext: evil, size: 10, partCount: 1, keyEnvelope: "{}", ip: "1.1.1.1" }))).status, 400, evil);
  const env = (await C.encryptForRequest(keys.publicKeyJwk, tiny, {}, open.requestId)).keyEnvelope;
  assert.equal((await code(R.beginUpload({ token: open.token, uploader: ident, ext: "pdf", size: 10, partCount: 5, keyEnvelope: env, ip: "1.1.1.1" }))).status, 400, "part count must match the size");
  assert.equal((await code(R.beginUpload({ token: open.token, uploader: ident, ext: "pdf", size: 0, partCount: 1, keyEnvelope: env, ip: "1.1.1.1" }))).status, 400);
  assert.equal((await code(R.beginUpload({ token: open.token, uploader: ident, ext: "pdf", size: 10, partCount: 1, keyEnvelope: "garbage", ip: "1.1.1.1" }))).status, 400, "an invalid envelope is refused");
  assert.equal((await code(R.beginUpload({ token: "nope", uploader: ident, ext: "pdf", size: 10, partCount: 1, keyEnvelope: env, ip: "1.1.1.1" }))).status, 404);
});

test("part and completion rules: wrong key, wrong index, duplicates, incomplete, size mismatch, oversize, malformed", T, async () => {
  const { token, requestId } = await mk();
  const up = await send(token, requestId, new Uint8Array(randomBytes(R.LIMITS.partBytes + 10)));
  const part = (o) => R.uploadPart({ token, uploadId: up.uploadId, uploadKey: up.uploadKey, index: 0, data: "AAAA", ...o });
  assert.equal((await code(part({ uploadKey: "wrong" }))).status, 404, "another visitor cannot add to this upload");
  assert.equal((await code(part({ uploadId: "f".repeat(24) }))).status, 404);
  assert.equal((await code(part({ index: 9 }))).status, 400); assert.equal((await code(part({ index: -1 }))).status, 400);
  assert.equal((await code(part({ data: "***" }))).status, 400); assert.equal((await code(part({ data: Buffer.alloc(R.LIMITS.partBytes + 500).toString("base64") }))).status, 413);
  assert.equal((await part({ index: 0, data: Buffer.from(randomBytes(R.LIMITS.partBytes)).toString("base64") })).duplicate, true, "re-sending a part is ignored");
  const other2 = await send(token, requestId, new Uint8Array(randomBytes(R.LIMITS.partBytes + 10)));
  await db.collection("file_request_parts").deleteOne({ uploadId: other2.uploadId, index: 1 });
  assert.equal((await code(other2.complete())).code, "INCOMPLETE");
  const third = await send(token, requestId, new Uint8Array(randomBytes(500)));
  await db.collection("file_request_parts").updateOne({ uploadId: third.uploadId, index: 0 }, { $set: { data: new (await import("mongodb")).Binary(Buffer.alloc(10)) } });
  assert.equal((await code(third.complete())).code, "SIZE_MISMATCH");
  assert.equal((await code(R.completeUpload({ token, uploadId: up.uploadId, uploadKey: "bad" }))).status, 404);
});

test("limits hold under concurrency: maxFiles=2 accepts exactly two of five simultaneous completions", T, async () => {
  const { token, requestId } = await mk({ maxFiles: 2 });
  const ups = await Promise.all([1, 2, 3, 4, 5].map((i) => send(token, requestId, new Uint8Array(randomBytes(300)), { ip: `198.51.100.${i}`, uploader: { name: `P${i}`, email: `p${i}@example.org` } })));
  const rs = await Promise.allSettled(ups.map((u) => u.complete()));
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 2);
  assert.ok(rs.filter((r) => r.status === "rejected").every((r) => r.reason.status === 410));
  assert.equal((await db.collection("file_requests").findOne({ _id: new (await import("mongodb")).ObjectId(requestId) })).received, 2, "never exceeds the limit");
  assert.equal(await db.collection("file_request_parts").countDocuments({ uploadId: { $in: ups.map((u) => u.uploadId) } }) <= 2 * 1 + 0, true, "the losers' parts were discarded");
  assert.equal((await R.publicInfo(token)).status, "full");
  assert.equal((await code(R.beginUpload({ token, uploader: ident, ext: "pdf", size: 10, partCount: 1, keyEnvelope: ups[0].enc.keyEnvelope, ip: "1.1.1.1" }))).status, 410);
});

test("rate limiting: a flood from one address is refused", T, async () => {
  const { token, requestId } = await mk({ maxFiles: 100 });
  const old = R.LIMITS.uploadsPerHourPerIp; R.LIMITS.uploadsPerHourPerIp = 3;
  try {
    let refused = null;
    for (let i = 0; i < 6 && !refused; i++) { try { await send(token, requestId, new Uint8Array(50), { ip: "192.0.2.77" }); } catch (e) { refused = e; } }
    assert.equal(refused?.status, 429);
    assert.ok((await send(token, requestId, new Uint8Array(50), { ip: "192.0.2.200" })).uploadId, "a different address is unaffected");
  } finally { R.LIMITS.uploadsPerHourPerIp = old; }
});

test("expiry and revocation stop uploads at once; in-progress uploads are discarded, completed ones kept", T, async () => {
  const { token, requestId } = await mk();
  const done = await send(token, requestId, new Uint8Array(200)); await done.complete();
  const mid = await send(token, requestId, new Uint8Array(200));
  await R.revokeRequest({ orgId: org.oid, requestId, actorEmail: org.alice.email, membership: org.alice.membership });
  assert.equal((await code(mid.complete())).status, 404, "the in-progress upload is gone");
  assert.equal((await code(R.beginUpload({ token, uploader: ident, ext: "pdf", size: 10, partCount: 1, keyEnvelope: done.enc.keyEnvelope, ip: "1.1.1.1" }))).status, 410);
  assert.equal((await R.getRequest({ orgId: org.oid, requestId, actorEmail: org.alice.email, membership: org.alice.membership })).uploads.length, 1, "the finished upload is still there to collect");
  const t2 = await mk(); await db.collection("file_requests").updateOne({ _id: new (await import("mongodb")).ObjectId(t2.requestId) }, { $set: { expiresAt: FUT(-1000) } });
  assert.equal((await R.publicInfo(t2.token)).status, "expired"); assert.equal((await code(R.beginUpload({ token: t2.token, uploader: ident, ext: "pdf", size: 10, partCount: 1, keyEnvelope: done.enc.keyEnvelope, ip: "1.1.1.1" }))).status, 410);
});

test("who can see what: the requester and admins only; other members and other organizations get nothing", T, async () => {
  const { token, requestId } = await mk(); const up = await send(token, requestId, new Uint8Array(300)); await up.complete();
  const as = (who, o = org) => ({ orgId: o.oid, requestId, actorEmail: who.email, membership: who.membership });
  assert.equal((await code(R.getRequest(as(org.bob)))).status, 403); assert.equal((await code(R.readUploadPart({ ...as(org.bob), uploadId: up.uploadId, index: 0 }))).status, 403);
  assert.equal((await code(R.revokeRequest(as(org.bob)))).status, 403); assert.equal((await code(R.deleteUpload({ ...as(org.bob), uploadId: up.uploadId }))).status, 403);
  assert.equal((await code(R.getRequest(as(other.eve, other)))).status, 404, "another organization cannot even tell it exists");
  assert.equal((await R.getRequest(as(org.owner))).uploads.length, 1, "an organization admin can");
  assert.equal((await code(R.listRequests({ orgId: org.oid, actorEmail: org.bob.email, membership: org.bob.membership, scope: "org" }))).status, 403);
  const mine = await R.listRequests({ orgId: org.oid, actorEmail: org.alice.email, membership: org.alice.membership, limit: 3 });
  assert.equal(mine.items.length, 3); assert.ok(mine.nextCursor); assert.equal(JSON.stringify(mine).includes("wrappedPrivateKey"), false, "the list never carries key material");
  assert.equal((await R.listRequests({ orgId: org.oid, actorEmail: org.bob.email, membership: org.bob.membership })).items.length, 0);
  const del = await R.deleteUpload({ ...as(org.alice), uploadId: up.uploadId }); assert.equal(del.deleted, true);
  assert.equal((await R.getRequest(as(org.alice))).received, 0, "the count follows");
  assert.equal(await db.collection("file_request_parts").countDocuments({ uploadId: up.uploadId }), 0);
});

test("notification and audit: generic, escaped, no file content; abandoned uploads are swept", T, async () => {
  const { token, requestId } = await mk({ title: "Invoices <b>2026</b>" });
  const up = await send(token, requestId, new Uint8Array(300), { uploader: { name: "Eve <script>", email: "eve@example.org" } }); await up.complete();
  const n = await db.collection("notifications").findOne({ orgId: org.orgId, type: "file_request.received", targetEmail: org.alice.email });
  assert.ok(n); assert.equal(n.body.includes("<"), false, "markup is stripped from names and titles"); assert.match(n.body, /1 of 5/);
  const log = await cols.orgActivity.find({ orgId: org.orgId, recordType: "FILE_REQUEST" }).toArray();
  assert.ok(log.some((e) => e.action === "CREATED") && log.some((e) => e.action === "FILE_RECEIVED"));
  assert.equal(JSON.stringify(log).includes("script"), false);
  const stale = await send(token, requestId, new Uint8Array(300)); await db.collection("file_request_uploads").updateOne({ _id: new (await import("mongodb")).ObjectId(stale.uploadId) }, { $set: { createdAt: FUT(-7200_000) } });
  assert.ok((await R.sweepAbandonedUploads()).removed >= 1); assert.equal(await db.collection("file_request_parts").countDocuments({ uploadId: stale.uploadId }), 0);
});

// ---------------------------------------------------------------- HTTP
const mod = {}; const load = async (p) => (mod[p] ||= await import(p));
async function http(file, method, { path = "/x", cookie, body, query = {}, params = {}, ip = "203.0.113.9" } = {}) {
  const m = await load(file); const url = new URL("http://localhost" + path); for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await m[method](new NextRequest(url, { method, headers: { host: "localhost", "x-forwarded-for": ip, ...(cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), { params: Promise.resolve(params) });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const F = {
  create: (cookie, body, orgId) => http("../src/app/api/orgs/file-requests/route.js", "POST", { cookie, body: { orgId: orgId || org.oid, ...body } }),
  list: (cookie, q) => http("../src/app/api/orgs/file-requests/route.js", "GET", { cookie, query: { orgId: org.oid, ...q } }),
  detail: (cookie, id) => http("../src/app/api/orgs/file-requests/[requestId]/route.js", "GET", { cookie, query: { orgId: org.oid }, params: { requestId: id } }),
  revoke: (cookie, id) => http("../src/app/api/orgs/file-requests/[requestId]/route.js", "DELETE", { cookie, query: { orgId: org.oid }, params: { requestId: id } }),
  part: (cookie, id, uid, i) => http("../src/app/api/orgs/file-requests/[requestId]/uploads/[uploadId]/route.js", "GET", { cookie, query: { orgId: org.oid, index: String(i) }, params: { requestId: id, uploadId: uid } }),
  pubGet: (token) => http("../src/app/api/public/file-requests/[token]/route.js", "GET", { params: { token } }),
  pubPost: (token, body, ip) => http("../src/app/api/public/file-requests/[token]/route.js", "POST", { params: { token }, body, ip }),
};

test("HTTP: the requester routes need the feature, a session and the right role; the public routes are inbound-only", T, async () => {
  const cA = await cookieFor(org.alice.email), cB = await cookieFor(org.bob.email);
  const body = { title: "Via HTTP", expirationPreset: "7d", maxFiles: 3, publicKeyJwk: keys.publicKeyJwk, wrappedPrivateKey: keys.wrappedPrivateKey };
  assert.equal((await F.create(cA, body)).status, 404, "off until the feature is on");
  await setOrgFeature({ orgId: org.oid, name: "FEATURE_ADVANCED_SHARING", enabled: true });
  assert.equal((await F.create(null, body)).status, 401);
  assert.equal((await F.create(cA, { ...body, title: "" })).status, 400);
  assert.equal((await F.create(cA, body, other.oid)).status, 403);
  const made = await F.create(cA, body); assert.equal(made.status, 200); assert.match(made.data.uploadUrl, /\/request\/[A-Za-z0-9_-]{40,}$/); assert.equal(made.data.wrappedPrivateKey, undefined);
  const token = made.data.uploadUrl.split("/").pop(); const id = made.data.requestId;
  const info = await F.pubGet(token); assert.equal(info.status, 200); assert.equal(info.data.status, "open"); assert.equal(info.data.requestId, id);
  const enc = await C.encryptForRequest(keys.publicKeyJwk, new TextEncoder().encode("hello over http"), { name: "h.txt" }, id);
  const begin = await F.pubPost(token, { action: "begin", uploader: ident, ext: "txt", size: enc.ciphertext.length, partCount: 1, keyEnvelope: enc.keyEnvelope }); assert.equal(begin.status, 200);
  assert.equal((await F.pubPost(token, { action: "part", uploadId: begin.data.uploadId, uploadKey: begin.data.uploadKey, index: 0, data: Buffer.from(enc.ciphertext).toString("base64") })).status, 200);
  assert.equal((await F.pubPost(token, { action: "complete", uploadId: begin.data.uploadId, uploadKey: begin.data.uploadKey })).status, 200);
  assert.equal((await F.pubPost(token, { action: "dance" })).status, 400);
  assert.equal((await F.pubGet("A".repeat(43))).status, 404);
  const m = await load("../src/app/api/public/file-requests/[token]/route.js"); assert.equal(typeof m.DELETE, "undefined"); assert.equal(typeof m.PUT, "undefined");
  const d = await F.detail(cA, id); assert.equal(d.status, 200); assert.equal(d.data.uploads.length, 1); assert.ok(d.data.wrappedPrivateKey);
  assert.equal((await F.detail(cB, id)).status, 403); assert.equal((await F.detail(null, id)).status, 401);
  const p = await F.part(cA, id, begin.data.uploadId, 0); assert.equal(p.status, 200);
  const priv = await C.unwrapPrivateKey(d.data.wrappedPrivateKey, PASS);
  const out = await C.decryptFromRequest(priv, d.data.uploads[0].keyEnvelope, new Uint8Array(Buffer.from(p.data.data, "base64")), id);
  assert.equal(new TextDecoder().decode(out.bytes), "hello over http");
  assert.equal((await F.part(cB, id, begin.data.uploadId, 0)).status, 403);
  assert.equal((await F.list(cA, {})).data.items.some((i) => i.requestId === id), true);
  assert.equal((await F.revoke(cB, id)).status, 403); assert.equal((await F.revoke(cA, id)).status, 200);
  assert.equal((await F.pubGet(token)).data.status, "revoked");
  const bad = await load("../src/app/api/public/file-requests/[token]/route.js");
  const res = await bad.POST(new NextRequest("http://localhost/x", { method: "POST", body: "{not json", headers: { "x-forwarded-for": "203.0.113.50" } }), { params: Promise.resolve({ token }) });
  assert.equal(res.status, 400); assert.equal(JSON.stringify(await res.json()).includes("at "), false);
});
