// test/file-locks.test.mjs -- file locking (Sharing 2.0 B4) against the real database and the real S3/Azure store: atomic acquire under
// concurrency, lease expiry, release and forced release, and enforcement at the storage chokepoint for web users AND API credentials.
// Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=400000 test/file-locks.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { NextRequest } from "next/server.js";
import { setup, teardown, makeChatOrg, cookieFor, c as cols } from "./_chat-fixtures.mjs";
import { SESSION_COOKIE, getOrgCollections } from "../src/lib/orgs.js";
import { setOrgFeature } from "../src/lib/featureFlags.js";
import { activeLock, lockedByOther, acquireLock, releaseLock, getLockInfo, listLocks, sweepStaleLocks, LockError } from "../src/lib/filelocks.js";
import { issueS3Credential, ensureS3CompatIndexes } from "../src/lib/s3-compat/credentials.js";
import { putS3Object, deleteS3Object, headS3Object, putBucketVersioning, runLifecycleEnforcement, putLifecyclePolicy } from "../src/lib/s3-compat/store.js";
import { s3Error } from "../src/lib/s3-compat/xml.js";
import { azureError } from "../src/lib/s3-compat/azureXml.js";

const T = { timeout: 400000 };
let org, other, doc, db, route;
const code = (p) => p.then(() => null, (e) => e);
const FUT = (ms) => new Date(Date.now() + ms).toISOString();
const ARGS = (who) => ({ orgId: org.oid, documentId: String(doc._id), actorEmail: who.email, membership: who.membership });

before(async () => {
  await setup(); db = (await getOrgCollections()).db; await ensureS3CompatIndexes(db);
  org = await makeChatOrg("lock"); other = await makeChatOrg("lock-other", { people: ["eve"] });
  const ins = await cols.orgDocuments.insertOne({ orgId: org.orgId, departmentId: new ObjectId(), projectId: new ObjectId(), filename: "spec.docx", fileHash: `0xlock-${randomBytes(4).toString("hex")}`, sizeBytes: 10, cidAlpha: "QmA", cidBeta: "QmB", uploadedByEmail: org.alice.email, txHash: "0xfake", status: "DRAFT", accessLevel: "PRIVATE", createdAt: new Date().toISOString(), deletedAt: null });
  doc = await cols.orgDocuments.findOne({ _id: ins.insertedId });
  route = await import("../src/app/api/orgs/file-locks/route.js");
});
after(async () => {
  const { purgeOrgObjects } = await import("../src/lib/s3-compat/purge.js"); for (const id of [org.oid, other.oid]) await purgeOrgObjects(id).catch(() => {});
  for (const n of ["orgDocuments", "documentActivity", "documentPermissions"]) await cols[n].deleteMany({ $or: [{ orgId: { $in: [org.orgId, other.orgId] } }, { organizationId: { $in: [org.orgId, other.orgId] } }] }).catch(() => {});
  for (const n of ["s3_credentials", "s3_owner_keys", "s3_lifecycle_policies"]) await db.collection(n).deleteMany({ ownerId: { $in: [org.oid, other.oid] } }).catch(() => {});
  await teardown();
});

test("pure rules: a lease in force, an ended lease, the holder versus others", () => {
  const now = Date.now();
  const d = (mins, who = "a@x.com") => ({ lock: { byEmail: who, at: "t", expiresAt: new Date(now + mins * 60000).toISOString() } });
  assert.ok(activeLock(d(5), now)); assert.equal(activeLock(d(-5), now), null); assert.equal(activeLock({}, now), null); assert.equal(activeLock({ lock: { byEmail: "a" } }, now), null);
  assert.equal(lockedByOther(d(5), "A@X.com", now), null, "the holder is not 'other' (case-insensitive)");
  assert.ok(lockedByOther(d(5), "b@x.com", now));
  assert.equal(lockedByOther(d(-1), "b@x.com", now), null, "an ended lease protects nothing");
});

test("acquire: one holder at a time, renewal by the holder, takeover only after the lease ends", T, async () => {
  const a = await acquireLock({ ...ARGS(org.alice), leaseMinutes: 10, reason: "editing the spec" });
  assert.equal(a.locked, true); assert.equal(a.byEmail, org.alice.email); assert.equal(a.reason, "editing the spec");
  const blocked = await code(acquireLock({ ...ARGS(org.bob) })); assert.equal(blocked.status, 423); assert.equal(blocked.lockedBy, org.alice.email); assert.match(blocked.message, /locked by/);
  const renew = await acquireLock({ ...ARGS(org.alice), leaseMinutes: 30 }); assert.ok(new Date(renew.expiresAt) > new Date(a.expiresAt), "renewal extends the lease");
  assert.equal((await code(acquireLock({ ...ARGS(org.alice), leaseMinutes: 0 }))).status, 400);
  assert.ok(new Date((await acquireLock({ ...ARGS(org.alice), leaseMinutes: 99999 })).expiresAt) - Date.now() <= 8 * 3600_000 + 5000, "the lease is capped at 8 hours");
  await cols.orgDocuments.updateOne({ _id: doc._id }, { $set: { "lock.expiresAt": FUT(-1000) } });
  assert.equal((await getLockInfo({ orgId: org.oid, documentId: String(doc._id) })).locked, false, "an ended lease reads as unlocked at once");
  const took = await acquireLock({ ...ARGS(org.bob) }); assert.equal(took.byEmail, org.bob.email, "after the lease ends, someone else can take it");
  assert.equal((await code(acquireLock({ orgId: org.oid, documentId: new ObjectId().toString(), actorEmail: org.bob.email }))).status, 404);
  await releaseLock({ ...ARGS(org.bob) });
});

test("concurrency: five people reaching for the lock at once, exactly one gets it", T, async () => {
  const people = [org.alice, org.bob, org.carol, org.dave, org.owner];
  const rs = await Promise.allSettled(people.map((p) => acquireLock({ ...ARGS(p), leaseMinutes: 5 })));
  const won = rs.filter((r) => r.status === "fulfilled"); assert.equal(won.length, 1);
  assert.ok(rs.filter((r) => r.status === "rejected").every((r) => r.reason instanceof LockError && r.reason.status === 423));
  const holder = (await getLockInfo({ orgId: org.oid, documentId: String(doc._id) })).byEmail; assert.equal(holder, won[0].value.byEmail);
  await releaseLock({ ...ARGS(people.find((p) => p.email === holder)) });
});

test("release: the holder can, others cannot, an admin or MANAGE holder can force; every step is recorded", T, async () => {
  await acquireLock({ ...ARGS(org.alice) });
  assert.equal((await code(releaseLock({ ...ARGS(org.bob) }))).status, 403);
  assert.equal((await code(releaseLock({ ...ARGS(org.bob), force: true }))).status, 403, "force alone is not enough");
  assert.equal((await code(releaseLock({ ...ARGS(org.bob), force: true, canForce: false }))).status, 403);
  const forced = await releaseLock({ ...ARGS(org.owner), force: true }); assert.equal(forced.forced, true); assert.equal(forced.released, true);
  assert.equal((await getLockInfo({ orgId: org.oid, documentId: String(doc._id) })).locked, false);
  assert.equal((await releaseLock({ ...ARGS(org.alice) })).released, false, "releasing an unlocked file is harmless");
  await acquireLock({ ...ARGS(org.alice) }); assert.equal((await releaseLock({ ...ARGS(org.alice) })).released, true);
  await acquireLock({ ...ARGS(org.alice) });
  assert.equal((await releaseLock({ ...ARGS(org.bob), force: true, canForce: true })).forced, true, "someone with MANAGE on the document can force");
  const log = await cols.orgActivity.find({ orgId: org.orgId, recordType: "FILE_LOCK" }).toArray();
  for (const a of ["LOCKED", "UNLOCKED", "FORCE_RELEASED", "RENEWED"]) assert.ok(log.some((e) => e.action === a), `${a} is in the audit trail`);
});

test("stale sweep and listings: bounded, scoped, admin-only for the whole organization", T, async () => {
  await acquireLock({ ...ARGS(org.alice), leaseMinutes: 5 });
  const mine = await listLocks({ orgId: org.oid, actorEmail: org.alice.email, membership: org.alice.membership }); assert.equal(mine.locks.length, 1); assert.equal(mine.locks[0].filename, "spec.docx");
  assert.equal((await listLocks({ orgId: org.oid, actorEmail: org.bob.email, membership: org.bob.membership })).locks.length, 0, "Bob holds none");
  assert.equal((await code(listLocks({ orgId: org.oid, actorEmail: org.bob.email, membership: org.bob.membership, scope: "org" }))).status, 403);
  assert.equal((await listLocks({ orgId: org.oid, actorEmail: org.owner.email, membership: org.owner.membership, scope: "org" })).locks.length, 1);
  assert.equal((await listLocks({ orgId: other.oid, actorEmail: other.eve.email, membership: other.eve.membership })).locks.length, 0, "another organization sees nothing");
  await cols.orgDocuments.updateOne({ _id: doc._id }, { $set: { "lock.expiresAt": FUT(-1000) } });
  const sw = await sweepStaleLocks(); assert.ok(sw.cleared >= 1);
  assert.equal((await cols.orgDocuments.findOne({ _id: doc._id })).lock, undefined, "the stored fields are tidied");
});

test("the S3/Azure store enforces the lock for everyone but the holder (people and API credentials), with versioning on or off", T, async () => {
  const bucket = `lock-${randomBytes(3).toString("hex")}`;
  const credAlice = await issueS3Credential({ owner: { type: "org", orgId: org.oid }, label: "alice", actorEmail: org.alice.email });
  const credBob = await issueS3Credential({ owner: { type: "org", orgId: org.oid }, label: "bob", actorEmail: org.bob.email });
  const put = (actor, body = "v") => putS3Object({ orgId: org.oid, bucket, key: "design/spec.txt", bodyBuffer: Buffer.from(body), contentType: "text/plain", actorEmail: actor });
  await put(credAlice.accessKeyId, "first");
  const obj = await headS3Object({ orgId: org.oid, bucket, key: "design/spec.txt" });
  const lockIt = (who) => acquireLock({ orgId: org.oid, documentId: String(obj._id), actorEmail: who.email, leaseMinutes: 10 });
  await lockIt(org.alice);

  const bobPut = await code(put(credBob.accessKeyId, "bob edit")); assert.equal(bobPut.reason, "FileLocked"); assert.match(bobPut.message, /locked by/);
  const bobWeb = await code(put(org.bob.email, "bob edit")); assert.equal(bobWeb.reason, "FileLocked", "a person writing as themselves is refused too");
  const bobDel = await code(deleteS3Object({ orgId: org.oid, bucket, key: "design/spec.txt", actorEmail: credBob.accessKeyId })); assert.equal(bobDel.reason, "FileLocked");
  const unknown = await code(put("AKIAUNKNOWNKEY0000", "x")); assert.equal(unknown.reason, "FileLocked", "an unknown writer is not the holder");
  const nobody = await code(put(undefined, "x")); assert.equal(nobody.reason, "FileLocked");
  assert.ok(await put(credAlice.accessKeyId, "alice edit"), "the holder's own credential still writes");
  assert.ok(await put(org.alice.email, "alice web edit"), "the holder writing as themselves too");

  await putBucketVersioning({ orgId: org.oid, bucket, status: "Enabled" });
  const cur = await headS3Object({ orgId: org.oid, bucket, key: "design/spec.txt" });
  await acquireLock({ orgId: org.oid, documentId: String(cur._id), actorEmail: org.alice.email, leaseMinutes: 10 });
  assert.equal((await code(put(credBob.accessKeyId, "versioned bob"))).reason, "FileLocked", "a lock holds even when versioning would keep the old bytes");
  assert.equal((await code(deleteS3Object({ orgId: org.oid, bucket, key: "design/spec.txt", actorEmail: credBob.accessKeyId }))).reason, "FileLocked", "no delete marker either");
  await releaseLock({ orgId: org.oid, documentId: String(cur._id), actorEmail: org.alice.email, membership: org.alice.membership });
  assert.ok(await put(credBob.accessKeyId, "bob after release"), "after the release Bob can write");
  const bobDoc = await headS3Object({ orgId: org.oid, bucket, key: "design/spec.txt" });
  await acquireLock({ orgId: org.oid, documentId: String(bobDoc._id), actorEmail: org.bob.email, leaseMinutes: 10 });
  await cols.orgDocuments.updateOne({ _id: bobDoc._id }, { $set: { "lock.expiresAt": FUT(-1000) } });
  assert.ok(await put(credAlice.accessKeyId, "alice after expiry"), "an ended lease no longer blocks anyone");
});

test("a locked object is not expired by lifecycle policy", T, async () => {
  const bucket = `life-${randomBytes(3).toString("hex")}`;
  const cred = await issueS3Credential({ owner: { type: "org", orgId: org.oid }, label: "life", actorEmail: org.alice.email });
  await putS3Object({ orgId: org.oid, bucket, key: "old.txt", bodyBuffer: Buffer.from("old"), contentType: "text/plain", actorEmail: cred.accessKeyId });
  const obj = await headS3Object({ orgId: org.oid, bucket, key: "old.txt" });
  await putLifecyclePolicy({ orgId: org.oid, bucket, rules: [{ id: "r1", prefix: "", expirationDays: 1 }], actorEmail: org.alice.email });
  await cols.orgDocuments.updateOne({ _id: obj._id }, { $set: { createdAt: FUT(-5 * 86400_000) } });
  await acquireLock({ orgId: org.oid, documentId: String(obj._id), actorEmail: org.bob.email, leaseMinutes: 60 });
  const r = await runLifecycleEnforcement({ limit: 50 });
  assert.ok((await cols.orgDocuments.findOne({ _id: obj._id })).deletedAt === null, "the locked object survived the lifecycle run");
  assert.ok(r.skippedLocked >= 1, "it was counted as skipped because of the lock");
});

test("the S3 and Azure error codes for a locked file", () => {
  const s3 = s3Error("OperationAborted", "locked"); assert.equal(s3.status, 409);
  const az = azureError("LeaseIdMissing", "locked"); assert.equal(az.status, 412);
});

test("the lock endpoint over HTTP: needs the feature, EDIT access, tells the loser who holds it, and force needs MANAGE", T, async () => {
  const ck = async (who) => `${SESSION_COOKIE}=${await cookieFor(who.email)}`;
  const call = async (method, { cookie, body, query = {} } = {}) => {
    const url = new URL("http://localhost/api/orgs/file-locks"); for (const [k, v] of Object.entries({ orgId: org.oid, ...query })) url.searchParams.set(k, v);
    const res = await route[method](new NextRequest(url, { method, headers: { host: "localhost", cookie, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify({ orgId: org.oid, ...body }) } : {}) }));
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const [cA, cB, cO] = [await ck(org.alice), await ck(org.bob), await ck(org.owner)];
  await releaseLock({ ...ARGS(org.owner), force: true, canForce: true }).catch(() => {});
  assert.equal((await call("POST", { cookie: cA, body: { documentId: String(doc._id) } })).status, 404, "off until the feature is on");
  await setOrgFeature({ orgId: org.oid, name: "FEATURE_ADVANCED_SHARING", enabled: true });
  assert.equal((await call("POST", { cookie: undefined, body: { documentId: String(doc._id) } })).status, 401);
  assert.equal((await call("POST", { cookie: cB, body: { documentId: String(doc._id) } })).status, 403, "Bob cannot edit Alice's private document, so he cannot lock it");
  const ok = await call("POST", { cookie: cA, body: { documentId: String(doc._id), leaseMinutes: 20, reason: "draft" } }); assert.equal(ok.status, 200); assert.equal(ok.data.locked, true);
  await cols.documentPermissions.updateOne({ orgId: org.orgId, documentId: doc._id, email: org.bob.email }, { $set: { level: "EDIT", grantedByEmail: org.alice.email, grantedAt: new Date().toISOString() }, $setOnInsert: { orgId: org.orgId, documentId: doc._id, email: org.bob.email } }, { upsert: true });
  const clash = await call("POST", { cookie: cB, body: { documentId: String(doc._id) } }); assert.equal(clash.status, 423); assert.equal(clash.data.lockedBy, org.alice.email);
  assert.equal((await call("GET", { cookie: cB, query: { documentId: String(doc._id) } })).data.byEmail, org.alice.email);
  assert.equal((await call("DELETE", { cookie: cB, query: { documentId: String(doc._id) } })).status, 403);
  assert.equal((await call("DELETE", { cookie: cB, query: { documentId: String(doc._id), force: "1" } })).status, 403, "EDIT is not enough to break a lock");
  assert.equal((await call("DELETE", { cookie: cO, query: { documentId: String(doc._id), force: "1" } })).data.forced, true, "an organization owner can");
  assert.equal((await call("GET", { cookie: cA, query: { scope: "org" } })).status, 403);
  assert.equal((await call("GET", { cookie: cA, query: {} })).data.locks.length, 0);
});
