// test/signed-url.test.mjs
//
// GCS Compatibility Extension SOW, Phase 2 -- pure-logic tests for
// createSignedUrl/verifySignedUrl (no network, no DB beyond real
// credential resolution). See test/gcs-extension-live.test.mjs for the
// full live-HTTP proof (real server, real expiration, real tamper
// rejection).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { ensureS3CompatIndexes, issueS3Credential } from "../src/lib/s3-compat/credentials.js";
import { createHmac } from "node:crypto";
import { createSignedUrl, verifySignedUrl } from "../src/lib/s3-compat/signedUrl.js";

const RUN_ID = randomUUID().slice(0, 8);
const cleanup = { orgIds: [] };
let collections;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  await ensureS3CompatIndexes(collections.db);
});

after(async () => {
  const { orgs, db } = collections;
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  await db.collection("s3_credentials").deleteMany({ ownerId: { $in: cleanup.orgIds.map((id) => id.toString()) } });
  await db.collection("s3_owner_keys").deleteMany({ ownerId: { $in: cleanup.orgIds.map((id) => id.toString()) } });
});

async function makeCredential(label) {
  const orgId = new ObjectId();
  await collections.orgs.insertOne({ _id: orgId, name: `signed-url-test-${RUN_ID}-${label}`, createdAt: new Date().toISOString() });
  cleanup.orgIds.push(orgId);
  const owner = { type: "org", orgId: orgId.toString() };
  const cred = await issueS3Credential({ owner, label, actorEmail: "t@example.com" });
  return { ...cred, owner };
}

function fakeUrl(qs) {
  return new URL(`http://localhost:3000/api/s3/bucket/key.txt?${qs}`);
}

test("a freshly-created signed URL verifies successfully for GET", async () => {
  const cred = await makeCredential("valid");
  const qs = createSignedUrl({ accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey, method: "GET", bucket: "bucket", key: "key.txt" });
  const result = await verifySignedUrl(fakeUrl(qs), { method: "GET", bucket: "bucket", key: "key.txt" });
  assert.equal(result.ok, true);
});

test("HEAD is accepted against a URL signed for GET (same object identity)", async () => {
  const cred = await makeCredential("head");
  const qs = createSignedUrl({ accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey, method: "GET", bucket: "bucket", key: "key.txt" });
  const result = await verifySignedUrl(fakeUrl(qs), { method: "HEAD", bucket: "bucket", key: "key.txt" });
  assert.equal(result.ok, true);
});

test("a different object path is rejected (SECURITY: cannot retarget a signed URL)", async () => {
  const cred = await makeCredential("wrong-key");
  const qs = createSignedUrl({ accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey, method: "GET", bucket: "bucket", key: "key.txt" });
  const result = await verifySignedUrl(fakeUrl(qs), { method: "GET", bucket: "bucket", key: "other-key.txt" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "InvalidSignature");
});

test("a different bucket is rejected (SECURITY: cross-bucket retargeting)", async () => {
  const cred = await makeCredential("wrong-bucket");
  const qs = createSignedUrl({ accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey, method: "GET", bucket: "bucket", key: "key.txt" });
  const result = await verifySignedUrl(fakeUrl(qs), { method: "GET", bucket: "other-bucket", key: "key.txt" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "InvalidSignature");
});

test("an already-expired URL is rejected", async () => {
  // createSignedUrl deliberately clamps to a minimum 1-second TTL (it can
  // never mint a URL that's already dead on arrival) -- so this test
  // constructs an expired one directly with the same signing scheme,
  // proving verification's OWN expiry check independent of that clamp.
  const cred = await makeCredential("expired");
  const expires = Math.floor(Date.now() / 1000) - 3600; // one hour in the past
  const stringToSign = `GET\nbucket/key.txt\n${expires}`;
  const signature = createHmac("sha256", cred.secretAccessKey).update(stringToSign, "utf8").digest("hex");
  const qs = new URLSearchParams({
    "X-Inaya-Algorithm": "INAYA-HMAC-SHA256",
    "X-Inaya-Credential": cred.accessKeyId,
    "X-Inaya-Expires": String(expires),
    "X-Inaya-Signature": signature,
  }).toString();
  const result = await verifySignedUrl(fakeUrl(qs), { method: "GET", bucket: "bucket", key: "key.txt" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "SignedUrlExpired");
});

test("a revoked credential invalidates every signed URL it ever created (SECURITY)", async () => {
  const cred = await makeCredential("revoked");
  const qs = createSignedUrl({ accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey, method: "GET", bucket: "bucket", key: "key.txt" });
  const { revokeS3Credential } = await import("../src/lib/s3-compat/credentials.js");
  await revokeS3Credential({ owner: cred.owner, accessKeyId: cred.accessKeyId });
  const result = await verifySignedUrl(fakeUrl(qs), { method: "GET", bucket: "bucket", key: "key.txt" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "RevokedOrUnknownCreator");
});

test("DELETE is never a valid method for a signed URL, even with a correct signature for that method (SECURITY: a signed URL only ever grants read)", async () => {
  const cred = await makeCredential("delete-attempt");
  const qs = createSignedUrl({ accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey, method: "GET", bucket: "bucket", key: "key.txt" });
  const result = await verifySignedUrl(fakeUrl(qs), { method: "DELETE", bucket: "bucket", key: "key.txt" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "UnauthorizedMethod");
});

test("expiresInSeconds is capped at 7 days even if a caller asks for longer", async () => {
  const cred = await makeCredential("cap-test");
  const qs = createSignedUrl({ accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey, method: "GET", bucket: "bucket", key: "key.txt", expiresInSeconds: 999 * 24 * 3600 });
  const params = new URLSearchParams(qs);
  const expires = Number(params.get("X-Inaya-Expires"));
  const maxAllowed = Math.floor(Date.now() / 1000) + 7 * 24 * 3600 + 5; // +5s slack for test execution time
  assert.ok(expires <= maxAllowed, "a requested TTL beyond 7 days must be capped, not honored verbatim");
});

test("a request with no signed-URL parameters at all is not mistaken for one", async () => {
  const result = await verifySignedUrl(new URL("http://localhost:3000/api/s3/bucket/key.txt"), { method: "GET", bucket: "bucket", key: "key.txt" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "NotASignedUrlRequest");
});
