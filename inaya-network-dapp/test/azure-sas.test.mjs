// test/azure-sas.test.mjs
//
// Azure SAS support. The SAS values are produced by the REAL @azure/storage-blob generators, so the
// verifier is checked against Microsoft's own implementation rather than against one written by the same
// hands. Part 1 is pure; part 2 drives the actual Azure routes with a real credential and a stored blob.
//
// Run: node --import ./test/_next-loader.mjs --env-file=.env.local --test --test-force-exit test/azure-sas.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import {
  StorageSharedKeyCredential, generateBlobSASQueryParameters, generateAccountSASQueryParameters,
  BlobSASPermissions, ContainerSASPermissions, AccountSASPermissions, AccountSASServices, AccountSASResourceTypes, SASProtocol,
} from "@azure/storage-blob";
import { NextRequest } from "next/server.js";
import { verifySas, authorizeSasRequest, signServiceSas, SAS_ACCOUNT_PARAM } from "../src/lib/s3-compat/azureSas.js";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { issueS3Credential, revokeS3Credential, ensureOwnerS3Passphrase, ensureS3CompatIndexes } from "../src/lib/s3-compat/credentials.js";
import { putS3Object } from "../src/lib/s3-compat/store.js";
import { purgeOrgObjects } from "../src/lib/s3-compat/purge.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const ACCOUNT = "INAYAAKSASTEST000001";
const SECRET = "sasTestSecretAccessKey0123456789abcdef";
const KEY_B64 = Buffer.from(SECRET, "utf8").toString("base64"); // how azureAuthMiddleware derives the account key
const cred = new StorageSharedKeyCredential(ACCOUNT, KEY_B64);
const HOUR = 3_600_000;
const NOW = Date.now();
const BASE = "http://localhost:3000/api/azure";

const blobUrl = (container, blob, sas) => new URL(`${BASE}/${container}/${blob.split("/").map(encodeURIComponent).join("/")}?${sas}&${SAS_ACCOUNT_PARAM}=${ACCOUNT}`);
const containerUrl = (container, sas, extra = "") => new URL(`${BASE}/${container}?${extra}${sas}&${SAS_ACCOUNT_PARAM}=${ACCOUNT}`);
const rootUrl = (sas) => new URL(`${BASE}?comp=list&${sas}&${SAS_ACCOUNT_PARAM}=${ACCOUNT}`);
const blobSas = (v) => generateBlobSASQueryParameters({ expiresOn: new Date(NOW + HOUR), ...v }, cred).toString();
const verify = (url, extra = {}) => verifySas({ url, accountName: ACCOUNT, accountKeyBase64: KEY_B64, now: NOW, ...extra });
const allowed = (url, method) => { const v = verify(url); return v.ok ? authorizeSasRequest({ sas: v, method, url }) : v; };

// ------------------------------------------------------------------ part 1: verification against the real SDK

test("a blob SAS made by the real SDK verifies, and grants exactly its permission on exactly that blob", () => {
  const url = blobUrl("docs", "reports/q3.pdf", blobSas({ containerName: "docs", blobName: "reports/q3.pdf", permissions: BlobSASPermissions.parse("r") }));
  assert.equal(verify(url).ok, true);
  assert.equal(allowed(url, "GET").ok, true);
  assert.equal(allowed(url, "HEAD").ok, true);
  assert.equal(allowed(url, "PUT").ok, false, "a read-only SAS cannot write");
  assert.equal(allowed(url, "DELETE").ok, false, "...or delete");
  assert.equal(allowed(url, "PUT").code, "AuthorizationPermissionMismatch");
});

test("a blob SAS cannot be re-aimed at another blob or container", () => {
  const sas = blobSas({ containerName: "docs", blobName: "a.txt", permissions: BlobSASPermissions.parse("r") });
  assert.equal(verify(blobUrl("docs", "b.txt", sas)).ok, false);
  assert.equal(verify(blobUrl("other", "a.txt", sas)).ok, false);
  assert.equal(allowed(containerUrl("docs", sas), "GET").ok, false, "and a blob SAS cannot list the container");
});

test("keys with spaces, parentheses, plus and non-ASCII characters verify (canonical name uses the decoded key)", () => {
  const name = "dir/file name (v1)+ü.bin";
  const url = blobUrl("docs", name, blobSas({ containerName: "docs", blobName: name, permissions: BlobSASPermissions.parse("rw") }));
  assert.equal(verify(url).ok, true);
  assert.equal(allowed(url, "PUT").ok, true);
});

test("a container SAS covers every blob in that container, can list it, and nothing outside it", () => {
  const sas = blobSas({ containerName: "docs", permissions: ContainerSASPermissions.parse("rwdl") });
  assert.equal(allowed(blobUrl("docs", "x/y.txt", sas), "GET").ok, true);
  assert.equal(allowed(blobUrl("docs", "z.txt", sas), "PUT").ok, true);
  assert.equal(allowed(blobUrl("docs", "z.txt", sas), "DELETE").ok, true);
  assert.equal(allowed(containerUrl("docs", sas, "restype=container&comp=list&"), "GET").ok, true);
  assert.equal(verify(blobUrl("elsewhere", "x.txt", sas)).ok, false);
  assert.equal(allowed(containerUrl("docs", sas, "restype=container&"), "DELETE").ok, false, "a service SAS cannot delete the container itself");
  assert.equal(allowed(containerUrl("docs", sas, "restype=container&"), "PUT").ok, false, "...or create one");
});

test("Put Block / Put Block List need a write-type permission, and Delete needs d", () => {
  const writeOnly = blobSas({ containerName: "docs", blobName: "big.bin", permissions: BlobSASPermissions.parse("w") });
  const base = (q) => new URL(blobUrl("docs", "big.bin", writeOnly).href.replace("?", `?${q}&`));
  assert.equal(allowed(base("comp=block&blockid=AAA"), "PUT").ok, true);
  assert.equal(allowed(base("comp=blocklist"), "PUT").ok, true);
  assert.equal(allowed(base("x=1"), "DELETE").ok, false);
  const readOnly = blobSas({ containerName: "docs", blobName: "big.bin", permissions: BlobSASPermissions.parse("r") });
  assert.equal(allowed(new URL(blobUrl("docs", "big.bin", readOnly).href.replace("?", "?comp=block&blockid=AAA&")), "PUT").ok, false);
});

test("an account SAS is limited by service, resource type and permission", () => {
  const sas = (types, perms = "rwdlac") => generateAccountSASQueryParameters({
    expiresOn: new Date(NOW + HOUR), permissions: AccountSASPermissions.parse(perms), services: AccountSASServices.parse("b").toString(), resourceTypes: AccountSASResourceTypes.parse(types).toString(),
  }, cred).toString();
  const all = sas("sco");
  assert.equal(allowed(rootUrl(all), "GET").ok, true, "list containers");
  assert.equal(allowed(containerUrl("any", all, "restype=container&"), "PUT").ok, true, "create a container");
  assert.equal(allowed(blobUrl("any", "k.txt", all), "GET").ok, true);
  const objectsOnly = sas("o");
  assert.equal(allowed(blobUrl("any", "k.txt", objectsOnly), "GET").ok, true);
  assert.equal(allowed(rootUrl(objectsOnly), "GET").code, "AuthorizationResourceTypeMismatch");
  assert.equal(allowed(containerUrl("any", objectsOnly, "restype=container&"), "PUT").code, "AuthorizationResourceTypeMismatch");
  const noWrite = sas("co", "rl");
  assert.equal(allowed(blobUrl("any", "k.txt", noWrite), "PUT").code, "AuthorizationPermissionMismatch");
  const queueOnly = generateAccountSASQueryParameters({ expiresOn: new Date(NOW + HOUR), permissions: AccountSASPermissions.parse("r"), services: "q", resourceTypes: "o" }, cred).toString();
  assert.equal(allowed(blobUrl("any", "k.txt", queueOnly), "GET").code, "AuthorizationServiceMismatch");
});

test("time, protocol and IP restrictions inside the SAS are enforced", () => {
  const expired = blobSas({ containerName: "docs", blobName: "a", permissions: BlobSASPermissions.parse("r"), expiresOn: new Date(NOW - 1000) });
  assert.match(verify(blobUrl("docs", "a", expired)).reason, /expired/);
  const future = blobSas({ containerName: "docs", blobName: "a", permissions: BlobSASPermissions.parse("r"), startsOn: new Date(NOW + 2 * HOUR), expiresOn: new Date(NOW + 3 * HOUR) });
  assert.match(verify(blobUrl("docs", "a", future)).reason, /not yet valid/);
  const httpsOnly = blobSas({ containerName: "docs", blobName: "a", permissions: BlobSASPermissions.parse("r"), protocol: SASProtocol.Https });
  assert.equal(verify(blobUrl("docs", "a", httpsOnly), { isHttps: true }).ok, true);
  assert.match(verify(blobUrl("docs", "a", httpsOnly), { isHttps: false }).reason, /HTTPS/);
  const ranged = blobSas({ containerName: "docs", blobName: "a", permissions: BlobSASPermissions.parse("r"), ipRange: { start: "10.0.0.1", end: "10.0.0.50" } });
  assert.equal(verify(blobUrl("docs", "a", ranged), { clientIp: "10.0.0.20" }).ok, true);
  assert.match(verify(blobUrl("docs", "a", ranged), { clientIp: "10.0.1.20" }).reason, /IP/);
  assert.match(verify(blobUrl("docs", "a", ranged), { clientIp: null }).reason, /IP/);
});

test("tampering, the wrong key, unsupported forms and a mangled signature are all handled", () => {
  const sas = blobSas({ containerName: "docs", blobName: "a", permissions: BlobSASPermissions.parse("r") });
  const widened = new URL(blobUrl("docs", "a", sas)); widened.searchParams.set("sp", "rwd");
  assert.equal(verify(widened).ok, false, "widening the permissions breaks the signature");
  const longer = new URL(blobUrl("docs", "a", sas)); longer.searchParams.set("se", new Date(NOW + 100 * HOUR).toISOString().replace(/\.\d{3}Z$/, "Z"));
  assert.equal(verify(longer).ok, false, "extending the expiry breaks the signature");
  assert.equal(verify(blobUrl("docs", "a", sas), { accountKeyBase64: Buffer.from("a-different-secret").toString("base64") }).ok, false);

  const withPolicy = new URL(blobUrl("docs", "a", sas)); withPolicy.searchParams.set("si", "policy1");
  assert.match(verify(withPolicy).reason, /Stored access policies/);
  const old = new URL(blobUrl("docs", "a", sas)); old.searchParams.set("sv", "2015-04-05");
  assert.match(verify(old).reason, /not supported/);
  const dir = new URL(blobUrl("docs", "a", sas)); dir.searchParams.set("sr", "d");
  assert.match(verify(dir).reason, /Directory SAS/);

  // an unescaped "+" in the base64 signature arrives as a space; it must still verify
  const sig = new URL(blobUrl("docs", "a", sas)).searchParams.get("sig");
  const raw = blobUrl("docs", "a", sas).href.replace(/sig=[^&]+/, `sig=${sig}`);
  assert.equal(verify(new URL(raw)).ok, true);
});

test("older signed versions (2020-02-10, 2019-12-12) use the layout without an encryption scope and verify", () => {
  for (const version of ["2020-02-10", "2019-12-12"]) {
    const url = blobUrl("docs", "a.txt", blobSas({ containerName: "docs", blobName: "a.txt", permissions: BlobSASPermissions.parse("r"), version }));
    assert.equal(verify(url).ok, true, `version ${version}`);
  }
});

test("a SAS signed by the server (signServiceSas) is byte-identical to the real SDK's, and verifies", () => {
  const expiresAt = Math.floor((NOW + HOUR) / 1000) * 1000;
  const mine = new URLSearchParams(signServiceSas({ accountName: ACCOUNT, accountKeyBase64: KEY_B64, container: "docs", blob: "k/v.txt", permissions: "r", expiresAt }));
  const theirs = generateBlobSASQueryParameters({ containerName: "docs", blobName: "k/v.txt", permissions: BlobSASPermissions.parse("r"), expiresOn: new Date(expiresAt), version: "2021-08-06" }, cred).toString();
  assert.equal(mine.get("sig"), new URLSearchParams(theirs).get("sig"), "same signature as Microsoft's own generator");
  assert.equal(verify(blobUrl("docs", "k/v.txt", mine.toString().replace(`&${SAS_ACCOUNT_PARAM}=${ACCOUNT}`, "")), {}).ok, true);

  const containerSas = signServiceSas({ accountName: ACCOUNT, accountKeyBase64: KEY_B64, container: "docs", permissions: "rl", expiresAt });
  const theirsContainer = generateBlobSASQueryParameters({ containerName: "docs", permissions: ContainerSASPermissions.parse("rl"), expiresOn: new Date(expiresAt), version: "2021-08-06" }, cred).toString();
  assert.equal(new URLSearchParams(containerSas).get("sig"), new URLSearchParams(theirsContainer).get("sig"));
});

// ------------------------------------------------------------------ part 2: the real routes

const RUN = randomUUID().slice(0, 8);
const cleanup = { orgIds: [] };
let collections, orgId, credential, container;
const BODY = Buffer.from(`sas-route-test-${RUN}`);

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  await ensureS3CompatIndexes(collections.db);
  orgId = new ObjectId();
  cleanup.orgIds.push(orgId);
  await collections.orgs.insertOne({ _id: orgId, name: `azure-sas-${RUN}`, createdAt: new Date().toISOString() });
  await ensureOwnerS3Passphrase({ type: "org", orgId: String(orgId) });
  credential = await issueS3Credential({ owner: { type: "org", orgId: String(orgId) }, label: "sas test", actorEmail: "t@example.com" });
  container = `sas-${RUN}`;
  await putS3Object({ orgId: String(orgId), bucket: container, key: "hello.txt", bodyBuffer: BODY, contentType: "text/plain", actorEmail: "t@example.com" });
});

after(async () => {
  await purgeOrgObjects(orgId).catch(() => {});
  const { orgs, departments, projects, orgDocuments, orgActivity, db } = collections;
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  await departments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await projects.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgDocuments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgActivity.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await db.collection("s3_credentials").deleteMany({ ownerId: { $in: cleanup.orgIds.map(String) } });
  await db.collection("s3_owner_keys").deleteMany({ ownerId: { $in: cleanup.orgIds.map(String) } });
  await (await mongoClientPromise).close();
});

const credFor = () => new StorageSharedKeyCredential(credential.accessKeyId, Buffer.from(credential.secretAccessKey, "utf8").toString("base64"));
const sasFor = (values) => generateBlobSASQueryParameters({ expiresOn: new Date(Date.now() + HOUR), ...values }, credFor()).toString();
const req = (path, sas, { method = "GET", account = credential.accessKeyId, headers = {} } = {}) =>
  new NextRequest(`http://localhost:3000/api/azure${path}?${sas}${account ? `&${SAS_ACCOUNT_PARAM}=${account}` : ""}`, { method, headers: { "x-forwarded-proto": "https", "x-forwarded-for": "198.51.100.9", ...headers } });

test("route: GET with a blob SAS returns the stored bytes", async () => {
  const { GET } = await import("../src/app/api/azure/[container]/[...blob]/route.js");
  const sas = sasFor({ containerName: container, blobName: "hello.txt", permissions: BlobSASPermissions.parse("r") });
  const res = await GET(req(`/${container}/hello.txt`, sas), { params: { container, blob: ["hello.txt"] } });
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), BODY);
});

test("route: the same read-only SAS is refused for DELETE, and the object is still there", async () => {
  const { GET, DELETE } = await import("../src/app/api/azure/[container]/[...blob]/route.js");
  const sas = sasFor({ containerName: container, blobName: "hello.txt", permissions: BlobSASPermissions.parse("r") });
  const res = await DELETE(req(`/${container}/hello.txt`, sas, { method: "DELETE" }), { params: { container, blob: ["hello.txt"] } });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /AuthorizationPermissionMismatch/);
  const still = await GET(req(`/${container}/hello.txt`, sas), { params: { container, blob: ["hello.txt"] } });
  assert.equal(still.status, 200);
});

test("route: a container SAS with write permission can PUT a new blob, and list shows it", async () => {
  const { PUT } = await import("../src/app/api/azure/[container]/[...blob]/route.js");
  const { GET: list } = await import("../src/app/api/azure/[container]/route.js");
  const sas = sasFor({ containerName: container, permissions: ContainerSASPermissions.parse("rwl") });
  const hint = `${SAS_ACCOUNT_PARAM}=${credential.accessKeyId}`;

  const put = await PUT(
    new NextRequest(`http://localhost:3000/api/azure/${container}/uploaded.txt?${sas}&${hint}`, {
      method: "PUT", body: "hello", headers: { "x-ms-blob-type": "BlockBlob", "content-type": "text/plain", "x-forwarded-proto": "https" },
    }),
    { params: { container, blob: ["uploaded.txt"] } }
  );
  assert.equal(put.status, 201);

  const listed = await list(
    new NextRequest(`http://localhost:3000/api/azure/${container}?restype=container&comp=list&${sas}&${hint}`, { headers: { "x-forwarded-proto": "https" } }),
    { params: { container } }
  );
  assert.equal(listed.status, 200);
  assert.match(await listed.text(), /uploaded.txt/);
});

test("route: a SAS without the inaya-account parameter, with a wrong one, or an expired one is refused", async () => {
  const { GET } = await import("../src/app/api/azure/[container]/[...blob]/route.js");
  const params = { params: { container, blob: ["hello.txt"] } };
  const sas = sasFor({ containerName: container, blobName: "hello.txt", permissions: BlobSASPermissions.parse("r") });
  const noHint = await GET(req(`/${container}/hello.txt`, sas, { account: null }), params);
  assert.equal(noHint.status, 403);
  assert.match(await noHint.text(), /inaya-account/);
  assert.equal((await GET(req(`/${container}/hello.txt`, sas, { account: "INAYAAKDOESNOTEXIST0000" }), params)).status, 403);
  const expired = sasFor({ containerName: container, blobName: "hello.txt", permissions: BlobSASPermissions.parse("r"), expiresOn: new Date(Date.now() - 1000) });
  assert.equal((await GET(req(`/${container}/hello.txt`, expired), params)).status, 403);
});

test("route: revoking the signing credential kills every SAS it signed", async () => {
  const { GET } = await import("../src/app/api/azure/[container]/[...blob]/route.js");
  const second = await issueS3Credential({ owner: { type: "org", orgId: String(orgId) }, label: "to revoke", actorEmail: "t@example.com" });
  const secondCred = new StorageSharedKeyCredential(second.accessKeyId, Buffer.from(second.secretAccessKey, "utf8").toString("base64"));
  const sas = generateBlobSASQueryParameters({ containerName: container, blobName: "hello.txt", permissions: BlobSASPermissions.parse("r"), expiresOn: new Date(Date.now() + HOUR) }, secondCred).toString();
  const params = { params: { container, blob: ["hello.txt"] } };
  assert.equal((await GET(req(`/${container}/hello.txt`, sas, { account: second.accessKeyId }), params)).status, 200);
  await revokeS3Credential({ owner: { type: "org", orgId: String(orgId) }, accessKeyId: second.accessKeyId });
  assert.equal((await GET(req(`/${container}/hello.txt`, sas, { account: second.accessKeyId }), params)).status, 403);
});

test("route: a SAS can't exceed the credential's own scope (a bucket-scoped credential can't reach another container)", async () => {
  const { GET } = await import("../src/app/api/azure/[container]/[...blob]/route.js");
  const scoped = await issueS3Credential({ owner: { type: "org", orgId: String(orgId) }, label: "scoped", actorEmail: "t@example.com", scope: { bucket: container, operations: ["READ"] } });
  const scopedCred = new StorageSharedKeyCredential(scoped.accessKeyId, Buffer.from(scoped.secretAccessKey, "utf8").toString("base64"));
  const other = `${container}-other`;
  await putS3Object({ orgId: String(orgId), bucket: other, key: "x.txt", bodyBuffer: Buffer.from("x"), actorEmail: "t@example.com" });
  const sasFor2 = (c) => generateBlobSASQueryParameters({ containerName: c, blobName: c === container ? "hello.txt" : "x.txt", permissions: BlobSASPermissions.parse("r"), expiresOn: new Date(Date.now() + HOUR) }, scopedCred).toString();
  const ok = await GET(req(`/${container}/hello.txt`, sasFor2(container), { account: scoped.accessKeyId }), { params: { container, blob: ["hello.txt"] } });
  assert.equal(ok.status, 200);
  const denied = await GET(req(`/${other}/x.txt`, sasFor2(other), { account: scoped.accessKeyId }), { params: { container: other, blob: ["x.txt"] } });
  assert.equal(denied.status, 403);
  assert.match(await denied.text(), /scope/i);
});
