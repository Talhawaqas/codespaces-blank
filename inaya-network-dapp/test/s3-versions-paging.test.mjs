// test/s3-versions-paging.test.mjs -- ListObjectVersions paging, prefix filtering and XML shape.
// Run: node --import ./test/_next-loader.mjs --env-file=.env.local --test --test-force-exit test/s3-versions-paging.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac, createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { NextRequest } from "next/server.js";
import { pageVersions } from "../src/lib/s3-compat/versionsPaging.js";
import { listObjectVersionsXml } from "../src/lib/s3-compat/xml.js";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { issueS3Credential, ensureOwnerS3Passphrase, ensureS3CompatIndexes } from "../src/lib/s3-compat/credentials.js";
import { ensureS3Bucket, putBucketVersioning } from "../src/lib/s3-compat/store.js";
import mongoClientPromise from "../src/lib/mongodb.js";

// 3 keys, a:2 versions, b:3 versions (newest is a delete marker), c:1 version -- 6 entries, ordered as listAllObjectVersions returns them.
const ENTRIES = [
  { key: "a", versionId: "a2", isLatest: true }, { key: "a", versionId: "a1", isLatest: false },
  { key: "b", versionId: "b3", isLatest: true, deleteMarker: true }, { key: "b", versionId: "b2", isLatest: false }, { key: "b", versionId: "b1", isLatest: false },
  { key: "c", versionId: "c1", isLatest: true },
];
const ids = (page) => page.entries.map((e) => e.versionId);

test("a page smaller than the listing is truncated and carries the markers to resume from", () => {
  const p = pageVersions(ENTRIES, { maxKeys: 2 });
  assert.deepEqual(ids(p), ["a2", "a1"]);
  assert.equal(p.isTruncated, true);
  assert.equal(p.nextKeyMarker, "a");
  assert.equal(p.nextVersionIdMarker, "a1");
});

test("following the markers walks the whole listing exactly once, including a key split across pages", () => {
  const seen = [];
  let km = "", vm = "", pages = 0;
  for (;;) {
    const p = pageVersions(ENTRIES, { keyMarker: km, versionIdMarker: vm, maxKeys: 2 });
    seen.push(...ids(p)); pages++;
    if (!p.isTruncated) break;
    km = p.nextKeyMarker; vm = p.nextVersionIdMarker;
  }
  assert.deepEqual(seen, ["a2", "a1", "b3", "b2", "b1", "c1"]);
  assert.equal(pages, 3);
  // page size 1 splits key b across three pages
  const one = []; km = ""; vm = "";
  for (;;) { const p = pageVersions(ENTRIES, { keyMarker: km, versionIdMarker: vm, maxKeys: 1 }); one.push(...ids(p)); if (!p.isTruncated) break; km = p.nextKeyMarker; vm = p.nextVersionIdMarker; }
  assert.deepEqual(one, ["a2", "a1", "b3", "b2", "b1", "c1"]);
});

test("a complete listing is not truncated and has no next markers; a key-marker alone starts at the next key", () => {
  const all = pageVersions(ENTRIES, {});
  assert.equal(all.isTruncated, false);
  assert.equal(all.nextKeyMarker, null);
  assert.equal(all.entries.length, 6);
  assert.deepEqual(ids(pageVersions(ENTRIES, { keyMarker: "a" })), ["b3", "b2", "b1", "c1"]);
  assert.deepEqual(ids(pageVersions(ENTRIES, { keyMarker: "zzz" })), []);
});

test("a marker whose version was deleted meanwhile resumes after that key instead of failing or repeating", () => {
  assert.deepEqual(ids(pageVersions(ENTRIES, { keyMarker: "b", versionIdMarker: "deleted-version" })), ["c1"]);
});

test("max-keys is clamped to 1..1000 and junk falls back to the default", () => {
  assert.equal(pageVersions(ENTRIES, { maxKeys: 0 }).maxKeys, 1000);
  assert.equal(pageVersions(ENTRIES, { maxKeys: "abc" }).maxKeys, 1000);
  assert.equal(pageVersions(ENTRIES, { maxKeys: 99999 }).maxKeys, 1000);
  assert.equal(pageVersions(ENTRIES, { maxKeys: -5 }).maxKeys, 1);
});

test("the XML carries the S3 paging elements and distinguishes delete markers", () => {
  const p = pageVersions(ENTRIES, { maxKeys: 3 });
  const xml = listObjectVersionsXml({ bucket: "bk", ...p, prefix: "pre/", keyMarker: "", versionIdMarker: "" });
  for (const el of ["<Name>bk</Name>", "<Prefix>pre/</Prefix>", "<MaxKeys>3</MaxKeys>", "<IsTruncated>true</IsTruncated>", "<NextKeyMarker>b</NextKeyMarker>", "<NextVersionIdMarker>b3</NextVersionIdMarker>"]) assert.ok(xml.includes(el), el);
  assert.ok(xml.includes("<DeleteMarker><Key>b</Key><VersionId>b3</VersionId>"));
  assert.equal((xml.match(/<Version>/g) || []).length, 2);
  const done = listObjectVersionsXml({ bucket: "bk", ...pageVersions(ENTRIES, {}) });
  assert.ok(done.includes("<IsTruncated>false</IsTruncated>") && !done.includes("NextKeyMarker"));
});

// ---------------------------------------------------------------- the real route

const RUN = randomUUID().slice(0, 8);
let c, orgId, cred;

before(async () => {
  await ensureOrgIndexes();
  c = await getOrgCollections();
  await ensureS3CompatIndexes(c.db);
  orgId = new ObjectId();
  await c.orgs.insertOne({ _id: orgId, name: `vers-paging-${RUN}`, createdAt: new Date().toISOString() });
  await ensureOwnerS3Passphrase({ type: "org", orgId: String(orgId) });
  cred = await issueS3Credential({ owner: { type: "org", orgId: String(orgId) }, label: "t", actorEmail: "t@example.com" });
  const bucket = await ensureS3Bucket({ orgId: String(orgId), bucket: "vb", actorEmail: "t@example.com" });
  await putBucketVersioning({ orgId: String(orgId), bucket: "vb", status: "Enabled" });
  // Rows inserted directly (no pinning needed to test listing): 2 keys under "logs/", 1 under "img/", several versions each.
  const mk = (filename, n, deleted = false) => ({
    _id: new ObjectId(), orgId, departmentId: bucket.departmentId, projectId: bucket._id, filename, versionId: `${filename}#${n}`, isLatest: n === 3,
    sizeBytes: 10 + n, etag: `e${n}`, fileHash: randomUUID(), contentType: "text/plain", createdAt: new Date(Date.now() - (10 - n) * 1000).toISOString(), deletedAt: deleted ? new Date().toISOString() : null,
  });
  await c.orgDocuments.insertMany([1, 2, 3].flatMap((n) => [mk("logs/a.txt", n), mk("logs/b.txt", n), mk("img/x.png", n)]));
});

after(async () => {
  await c.orgs.deleteMany({ _id: orgId });
  for (const k of ["departments", "projects", "orgDocuments", "orgActivity"]) await c[k].deleteMany({ orgId });
  await c.db.collection("s3_credentials").deleteMany({ ownerId: String(orgId) });
  await c.db.collection("s3_owner_keys").deleteMany({ ownerId: String(orgId) });
  await (await mongoClientPromise).close();
});

const sha256 = (v) => createHash("sha256").update(v).digest("hex");
const hm = (k, d) => createHmac("sha256", k).update(d, "utf8").digest();
function signedGet(path, query) {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""); const date = amzDate.slice(0, 8);
  const headers = { host: "localhost:3000", "x-amz-date": amzDate, "x-amz-content-sha256": sha256("") };
  const names = Object.keys(headers).sort();
  const canonicalQuery = [...new URLSearchParams(query).entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const canonical = ["GET", path, canonicalQuery, names.map((k) => `${k}:${headers[k]}\n`).join(""), names.join(";"), sha256("")].join("\n");
  const scope = `${date}/inaya/s3/aws4_request`;
  const key = hm(hm(hm(hm(`AWS4${cred.secretAccessKey}`, date), "inaya"), "s3"), "aws4_request");
  const sig = createHmac("sha256", key).update(["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n"), "utf8").digest("hex");
  return new NextRequest(`http://localhost:3000${path}?${query}`, { headers: { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${cred.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}` } });
}
const listVersions = async (query) => {
  const { GET } = await import("../src/app/api/s3/[bucket]/route.js");
  const res = await GET(signedGet("/api/s3/vb", query), { params: { bucket: "vb" } });
  assert.equal(res.status, 200, await res.clone().text());
  return res.text();
};
const keysOf = (xml) => [...xml.matchAll(/<Version><Key>([^<]+)<\/Key><VersionId>([^<]+)</g)].map((m) => `${m[1]}@${m[2]}`);

test("route: a prefix-filtered request returns S3 XML for just that prefix (not the old single-key JSON)", async () => {
  const xml = await listVersions("versions=&prefix=logs%2F");
  assert.ok(xml.includes("<ListVersionsResult"));
  const keys = keysOf(xml);
  assert.equal(keys.length, 6);
  assert.ok(keys.every((k) => k.startsWith("logs/")));
});

test("route: paging with max-keys, key-marker and version-id-marker returns every version exactly once", async () => {
  const seen = []; let km = "", vm = "", pages = 0;
  for (;;) {
    const q = `versions=&max-keys=4${km ? `&key-marker=${encodeURIComponent(km)}` : ""}${vm ? `&version-id-marker=${encodeURIComponent(vm)}` : ""}`;
    const xml = await listVersions(q);
    seen.push(...keysOf(xml)); pages++;
    if (!xml.includes("<IsTruncated>true</IsTruncated>")) break;
    km = xml.match(/<NextKeyMarker>([^<]*)</)[1]; vm = decodeURIComponent(xml.match(/<NextVersionIdMarker>([^<]*)</)[1]);
    assert.ok(pages < 10, "must terminate");
  }
  assert.equal(seen.length, 9);
  assert.equal(new Set(seen).size, 9, "no version appears twice");
  assert.ok(pages >= 3);
  assert.deepEqual([...seen].map((s) => s.split("@")[0]), [...seen].map((s) => s.split("@")[0]).sort(), "keys come back in ascending order");
});

test("route: format=json still returns the old single-key JSON for anything that relied on it", async () => {
  const { GET } = await import("../src/app/api/s3/[bucket]/route.js");
  const res = await GET(signedGet("/api/s3/vb", "versions=&prefix=logs%2Fa.txt&format=json"), { params: { bucket: "vb" } });
  const body = await res.json();
  assert.equal(body.key, "logs/a.txt");
  assert.equal(body.versions.length, 3);
});
