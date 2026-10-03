// test/s3-credential-scope-enforcement.test.mjs
//
// Regression: resolveS3Credential() dropped a credential's stored `scope`, so every bucket / prefix /
// operation / expiry-scoped credential was enforced as full owner access by the S3 and Azure HTTP paths
// (checkScope was only ever unit-tested on hand-built objects). These tests go through the real
// authentication function with real SigV4-signed requests.
//
// Run: node --import ./test/_next-loader.mjs --env-file=.env.local --test --test-force-exit test/s3-credential-scope-enforcement.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, createHash, randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { NextRequest } from "next/server.js";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { issueS3Credential, resolveS3Credential, ensureOwnerS3Passphrase, ensureS3CompatIndexes } from "../src/lib/s3-compat/credentials.js";
import { authenticateS3Request, S3AuthError } from "../src/lib/s3-compat/auth.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN = randomUUID().slice(0, 8);
let collections, orgId, owner, scoped, unscoped, expired;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  await ensureS3CompatIndexes(collections.db);
  orgId = new ObjectId();
  await collections.orgs.insertOne({ _id: orgId, name: `scope-enforce-${RUN}`, createdAt: new Date().toISOString() });
  owner = { type: "org", orgId: String(orgId) };
  await ensureOwnerS3Passphrase(owner);
  scoped = await issueS3Credential({ owner, label: "scoped", actorEmail: "t@example.com", scope: { bucket: "allowed", prefix: "pub/", operations: ["READ"] } });
  unscoped = await issueS3Credential({ owner, label: "unscoped", actorEmail: "t@example.com" });
  expired = await issueS3Credential({ owner, label: "expired", actorEmail: "t@example.com", scope: { bucket: "allowed", operations: ["READ"], expiresAt: new Date(Date.now() + 60_000).toISOString() } });
  // Move the expiry into the past after issuing (issuing rejects a past date).
  await collections.db.collection("s3_credentials").updateOne({ accessKeyId: expired.accessKeyId }, { $set: { "scope.expiresAt": new Date(Date.now() - 60_000).toISOString() } });
});

after(async () => {
  await collections.orgs.deleteMany({ _id: orgId });
  await collections.db.collection("s3_credentials").deleteMany({ ownerId: String(orgId) });
  await collections.db.collection("s3_owner_keys").deleteMany({ ownerId: String(orgId) });
  await (await mongoClientPromise).close();
});

const sha256 = (v) => createHash("sha256").update(v).digest("hex");
const hmac = (k, d) => createHmac("sha256", k).update(d, "utf8").digest();

function signed({ method = "GET", path, credential, body = Buffer.alloc(0) }) {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const headers = { host: "localhost:3000", "x-amz-date": amzDate, "x-amz-content-sha256": sha256(body) };
  const names = Object.keys(headers).sort();
  const canonical = [method, path, "", names.map((k) => `${k}:${headers[k]}\n`).join(""), names.join(";"), sha256(body)].join("\n");
  const scope = `${date}/inaya/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${credential.secretAccessKey}`, date), "inaya"), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign, "utf8").digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${credential.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  return new NextRequest(`http://localhost:3000${path}`, { method, headers: { ...headers, authorization }, ...(body.length ? { body } : {}) });
}

async function attempt(opts, bucket, key) {
  try { return { ok: true, result: await authenticateS3Request(signed(opts), opts.body || Buffer.alloc(0), { bucket, key }) }; }
  catch (err) { if (err instanceof S3AuthError) return { ok: false, code: err.code, message: err.message }; throw err; }
}

test("resolveS3Credential returns the stored scope (and null for an unscoped credential)", async () => {
  const s = await resolveS3Credential(scoped.accessKeyId);
  assert.deepEqual({ bucket: s.scope.bucket, prefix: s.scope.prefix, operations: s.scope.operations }, { bucket: "allowed", prefix: "pub/", operations: ["READ"] });
  assert.equal((await resolveS3Credential(unscoped.accessKeyId)).scope, null);
});

test("a scoped credential can do exactly what its grant allows, over real signed requests", async () => {
  const ok = await attempt({ path: "/api/s3/allowed/pub/a.txt", credential: scoped }, "allowed", "pub/a.txt");
  assert.equal(ok.ok, true, "READ inside bucket and prefix is allowed");
});

test("...and is refused everything else: other prefix, other bucket, writes, deletes, and listing every bucket", async () => {
  const cases = [
    ["other prefix", { path: "/api/s3/allowed/private/a.txt", credential: scoped }, "allowed", "private/a.txt", /PrefixScopeDenied/],
    ["other bucket", { path: "/api/s3/finance/pub/a.txt", credential: scoped }, "finance", "pub/a.txt", /BucketScopeDenied/],
    ["write", { method: "PUT", path: "/api/s3/allowed/pub/new.txt", credential: scoped, body: Buffer.from("x") }, "allowed", "pub/new.txt", /OperationScopeDenied/],
    ["delete", { method: "DELETE", path: "/api/s3/allowed/pub/a.txt", credential: scoped }, "allowed", "pub/a.txt", /OperationScopeDenied/],
  ];
  for (const [label, opts, bucket, key, reason] of cases) {
    const r = await attempt(opts, bucket, key);
    assert.equal(r.ok, false, `${label} must be denied`);
    assert.equal(r.code, "AccessDenied", label);
    assert.match(r.message, reason, label);
  }
  const listAll = await attempt({ path: "/api/s3", credential: scoped }, null, null);
  assert.equal(listAll.ok, false, "a bucket-scoped credential cannot enumerate every bucket");
});

test("an expired grant is refused", async () => {
  const r = await attempt({ path: "/api/s3/allowed/a.txt", credential: expired }, "allowed", "a.txt");
  assert.equal(r.ok, false);
  assert.equal(r.code, "ExpiredToken");
});

test("control: an unscoped (owner-level) credential is unaffected", async () => {
  assert.equal((await attempt({ path: "/api/s3/finance/anything.txt", credential: unscoped }, "finance", "anything.txt")).ok, true);
  assert.equal((await attempt({ method: "DELETE", path: "/api/s3/finance/anything.txt", credential: unscoped }, "finance", "anything.txt")).ok, true);
});
