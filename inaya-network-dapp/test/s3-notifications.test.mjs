// test/s3-notifications.test.mjs -- S3 event notifications: matching, AWS-shaped payloads, signed delivery, retry,
// dead-letter, redeliver, SSRF rules, org isolation, and the real put/delete hooks.
//
// Run: node --import ./test/_next-loader.mjs --env-file=.env.local --test --test-force-exit test/s3-notifications.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { NextRequest } from "next/server.js";
import { getOrgCollections, ensureOrgIndexes, createSession, SESSION_COOKIE } from "../src/lib/orgs.js";
import { ensureOwnerS3Passphrase, ensureS3CompatIndexes } from "../src/lib/s3-compat/credentials.js";
import { putS3Object, deleteS3Object } from "../src/lib/s3-compat/store.js";
import { purgeOrgObjects } from "../src/lib/s3-compat/purge.js";
import {
  eventMatches, filterMatches, buildPayload, createNotificationConfig, listNotificationConfigs, emitObjectEvent,
  processNotificationDeliveries, listNotificationDeliveries, redeliverNotification, sendTestNotification, setNotificationActive,
} from "../src/lib/s3-compat/notifications.js";
import mongoClientPromise from "../src/lib/mongodb.js";

process.env.WORKFLOW_HTTP_TEST_ALLOW_LOCAL = "1"; // the receiver below is on 127.0.0.1; the SSRF test turns this off again

// ------------------------------------------------------------------ pure

test("event patterns: exact names and the S3 wildcard forms", () => {
  assert.equal(eventMatches(["s3:ObjectCreated:*"], "s3:ObjectCreated:Put"), true);
  assert.equal(eventMatches(["s3:ObjectCreated:*"], "s3:ObjectCreated:CompleteMultipartUpload"), true);
  assert.equal(eventMatches(["s3:ObjectCreated:*"], "s3:ObjectRemoved:Delete"), false);
  assert.equal(eventMatches(["s3:ObjectRemoved:Delete"], "s3:ObjectRemoved:DeleteMarkerCreated"), false, "an exact name is exact");
  assert.equal(eventMatches(["s3:*"], "s3:LifecycleExpiration:Delete"), true);
  assert.equal(eventMatches(["s3:ObjectRemoved:*", "s3:ObjectCreated:Put"], "s3:ObjectCreated:Put"), true);
});

test("prefix and suffix filters", () => {
  assert.equal(filterMatches({ prefix: "logs/", suffix: ".gz" }, "logs/2026/a.gz"), true);
  assert.equal(filterMatches({ prefix: "logs/", suffix: ".gz" }, "logs/2026/a.txt"), false);
  assert.equal(filterMatches({ prefix: "logs/" }, "img/a.gz"), false);
  assert.equal(filterMatches({}, "anything"), true);
});

test("the payload is AWS's S3 event shape, with the key URL-encoded and no leading s3: in the event name", () => {
  const p = buildPayload({ configId: "cfg1", eventName: "s3:ObjectCreated:Put", bucket: "bk", key: "dir/file name+ü.txt", size: 12, etag: '"abc"', versionId: "v9", actor: "me@x.com", eventTime: "2026-10-03T12:00:00.000Z" });
  const r = p.Records[0];
  assert.equal(r.eventVersion, "2.1");
  assert.equal(r.eventSource, "inaya:s3");
  assert.equal(r.eventName, "ObjectCreated:Put");
  assert.equal(r.s3.bucket.name, "bk");
  assert.equal(r.s3.object.key, "dir/file%20name%2B%C3%BC.txt");
  assert.deepEqual([r.s3.object.size, r.s3.object.eTag, r.s3.object.versionId], [12, "abc", "v9"]);
  assert.equal(r.userIdentity.principalId, "me@x.com");
  assert.equal(r.s3.configurationId, "cfg1");
  assert.ok(!("versionId" in buildPayload({ configId: "c", eventName: "s3:ObjectRemoved:Delete", bucket: "b", key: "k", versionId: "null" }).Records[0].s3.object), "the literal 'null' version of an unversioned bucket is omitted");
});

// ------------------------------------------------------------------ receiver

let server, port, mode = 200;
const received = [];
before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { received.push({ headers: req.headers, body }); res.writeHead(mode); res.end("ok"); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
const url = () => `http://127.0.0.1:${port}/hook`;

// ------------------------------------------------------------------ database

const RUN = randomUUID().slice(0, 8);
let c, orgId, otherOrg, owner, otherOwner, ownerToken, otherToken;
const orgs = [];

before(async () => {
  await ensureOrgIndexes();
  c = await getOrgCollections();
  await ensureS3CompatIndexes(c.db);
  orgId = new ObjectId(); otherOrg = new ObjectId(); orgs.push(orgId, otherOrg);
  owner = `notif-owner-${RUN}@example.com`; otherOwner = `notif-other-${RUN}@example.com`;
  const iso = new Date().toISOString();
  await c.orgs.insertMany([{ _id: orgId, name: `notif-a-${RUN}`, createdAt: iso }, { _id: otherOrg, name: `notif-b-${RUN}`, createdAt: iso }]);
  await c.orgMembers.insertMany([{ orgId, email: owner, role: "owner", status: "active", createdAt: iso }, { orgId: otherOrg, email: otherOwner, role: "owner", status: "active", createdAt: iso }]);
  await ensureOwnerS3Passphrase({ type: "org", orgId: String(orgId) });
  ownerToken = (await createSession(owner)).sessionToken;
  otherToken = (await createSession(otherOwner)).sessionToken;
});

after(async () => {
  server?.close();
  await purgeOrgObjects(orgId).catch(() => {});
  for (const k of ["departments", "projects", "orgDocuments", "orgActivity", "orgMembers"]) await c[k].deleteMany({ orgId: { $in: orgs } });
  await c.orgs.deleteMany({ _id: { $in: orgs } });
  await c.db.collection("s3_notification_configs").deleteMany({ orgId: { $in: orgs } });
  await c.db.collection("s3_notification_deliveries").deleteMany({ orgId: { $in: orgs } });
  await c.db.collection("s3_owner_keys").deleteMany({ ownerId: { $in: orgs.map(String) } });
  await (await mongoClientPromise).close();
});

const make = async (overrides = {}) => {
  const r = await createNotificationConfig({ orgId: String(orgId), bucket: "b", url: url(), events: ["s3:ObjectCreated:*"], actorEmail: owner, ...overrides });
  assert.ok(r.notification, JSON.stringify(r));
  return r;
};
const drain = async () => { received.length = 0; return processNotificationDeliveries({ limit: 50 }); };
const deliveries = async (configId) => (await listNotificationDeliveries({ orgId: String(orgId), configId })).deliveries;

test("a config's signing secret is shown once and never listed; URLs must pass the SSRF rules", async () => {
  const { notification, secret } = await make();
  assert.match(secret, /^whsec_[0-9a-f]{48}$/);
  const listed = JSON.stringify(await listNotificationConfigs({ orgId: String(orgId), bucket: "b" }));
  assert.ok(listed.includes(notification.configId) && !listed.includes(secret) && !listed.includes("secretEncrypted"));

  assert.match((await createNotificationConfig({ orgId: String(orgId), bucket: "b", url: "http://169.254.169.254/latest", events: ["s3:*"] })).error, /metadata/i);
  assert.match((await createNotificationConfig({ orgId: String(orgId), bucket: "b", url: "ftp://example.com/x", events: ["s3:*"] })).error, /https/i);
  assert.match((await createNotificationConfig({ orgId: String(orgId), bucket: "b", url: "https://user:pw@example.com/x", events: ["s3:*"] })).error, /Credentials/i);
  assert.match((await createNotificationConfig({ orgId: String(orgId), bucket: "b", url: url(), events: ["s3:Nope"] })).error, /events must be/);
  process.env.WORKFLOW_HTTP_TEST_ALLOW_LOCAL = "0";
  assert.match((await createNotificationConfig({ orgId: String(orgId), bucket: "b", url: "https://127.0.0.1/x", events: ["s3:*"] })).error, /Private|loopback/i);
  process.env.WORKFLOW_HTTP_TEST_ALLOW_LOCAL = "1";
});

test("a matching event is delivered once, signed so the receiver can verify it, with the AWS payload", async () => {
  const { notification, secret } = await make({ bucket: "signed" });
  await emitObjectEvent({ orgId: String(orgId), bucket: "signed", key: "docs/report.pdf", eventName: "s3:ObjectCreated:Put", eventKey: "e1", size: 42, etag: "abc", versionId: "v1", actorEmail: "u@x.com" });
  const result = await drain();
  assert.ok(result.delivered >= 1);
  const hit = received.find((r) => r.body.includes("docs/report.pdf"));
  assert.ok(hit, "the receiver got the event");
  const ts = hit.headers["x-inaya-timestamp"];
  const expected = createHmac("sha256", secret).update(`${ts}.${hit.body}`).digest("hex");
  assert.equal(hit.headers["x-inaya-signature"], `v1=${expected}`, "the signature verifies with the secret returned at creation");
  assert.equal(hit.headers["x-inaya-event"], "s3:ObjectCreated:Put");
  assert.equal(JSON.parse(hit.body).Records[0].s3.object.key, "docs/report.pdf");
  const [d] = await deliveries(notification.configId);
  assert.equal(d.status, "DELIVERED");
  assert.equal(d.responseStatus, 200);
});

test("events the config didn't ask for, or whose key misses the prefix/suffix, are never queued", async () => {
  const { notification } = await make({ bucket: "filtered", events: ["s3:ObjectCreated:*"], prefix: "logs/", suffix: ".gz" });
  const emit = (key, eventName, eventKey) => emitObjectEvent({ orgId: String(orgId), bucket: "filtered", key, eventName, eventKey });
  await emit("logs/a.gz", "s3:ObjectRemoved:Delete", "r1");
  await emit("logs/a.txt", "s3:ObjectCreated:Put", "r2");
  await emit("img/a.gz", "s3:ObjectCreated:Put", "r3");
  assert.equal((await deliveries(notification.configId)).length, 0);
  assert.equal((await emitObjectEvent({ orgId: String(orgId), bucket: "filtered", key: "logs/a.gz", eventName: "s3:ObjectCreated:Put", eventKey: "r4" })).queued, 1);
  assert.equal((await deliveries(notification.configId)).length, 1);
});

test("emitting the same event twice queues one delivery (a retried write can't double-notify)", async () => {
  const { notification } = await make({ bucket: "dedupe" });
  const args = { orgId: String(orgId), bucket: "dedupe", key: "k", eventName: "s3:ObjectCreated:Put", eventKey: "same" };
  assert.equal((await emitObjectEvent(args)).queued, 1);
  assert.equal((await emitObjectEvent(args)).queued, 0);
  assert.equal((await deliveries(notification.configId)).length, 1);
});

test("a failing endpoint is retried with backoff, dead-lettered after the last attempt, and can be redelivered", async () => {
  const { notification } = await make({ bucket: "flaky" });
  await emitObjectEvent({ orgId: String(orgId), bucket: "flaky", key: "k", eventName: "s3:ObjectCreated:Put", eventKey: "f1" });
  mode = 500;
  const col = c.db.collection("s3_notification_deliveries");
  let d;
  for (let attempt = 1; attempt <= 6; attempt++) {
    await col.updateOne({ configId: new ObjectId(notification.configId) }, { $set: { nextAttemptAt: new Date(Date.now() - 1000).toISOString() } }); // pretend the backoff elapsed
    await drain();
    [d] = await deliveries(notification.configId);
    assert.equal(d.attempts, attempt);
    if (attempt < 6) { assert.equal(d.status, "PENDING"); assert.match(d.lastError, /500/); assert.ok(new Date(d.nextAttemptAt) > new Date(), "the next try is in the future"); }
  }
  assert.equal(d.status, "DEAD", "dead-lettered after the final attempt");
  assert.equal((await redeliverNotification({ orgId: String(orgId), deliveryId: d.deliveryId })).queued, true);

  mode = 200;
  await drain();
  [d] = await deliveries(notification.configId);
  assert.equal(d.status, "DELIVERED", "redelivery succeeds once the endpoint recovers");
  assert.equal((await redeliverNotification({ orgId: String(orgId), deliveryId: d.deliveryId })).status, 409, "a delivered row can't be redelivered");
});

test("disabling a config dead-letters its pending deliveries instead of sending them", async () => {
  const { notification } = await make({ bucket: "disabled" });
  await emitObjectEvent({ orgId: String(orgId), bucket: "disabled", key: "k", eventName: "s3:ObjectCreated:Put", eventKey: "d1" });
  await setNotificationActive({ orgId: String(orgId), configId: notification.configId, active: false });
  await drain();
  assert.equal(received.length, 0);
  const [d] = await deliveries(notification.configId);
  assert.equal(d.status, "DEAD");
  assert.match(d.lastError, /disabled/);
});

test("a test notification reaches the endpoint synchronously and reports the outcome", async () => {
  const { notification } = await make({ bucket: "tested" });
  received.length = 0;
  const ok = await sendTestNotification({ orgId: String(orgId), configId: notification.configId });
  assert.equal(ok.ok, true);
  assert.equal(JSON.parse(received[0].body).Event, "s3:TestEvent");
  mode = 503;
  assert.equal((await sendTestNotification({ orgId: String(orgId), configId: notification.configId })).ok, false);
  mode = 200;
  assert.equal((await sendTestNotification({ orgId: String(otherOrg), configId: notification.configId })).status, 404, "another org can't trigger it");
});

test("the real store hooks: an upload and a delete each produce a notification for the right bucket and key", async () => {
  const { notification } = await make({ bucket: "live", events: ["s3:*"] });
  const doc = await putS3Object({ orgId: String(orgId), bucket: "live", key: "hello world.txt", bodyBuffer: Buffer.from("hello"), actorEmail: owner });
  await deleteS3Object({ orgId: String(orgId), bucket: "live", key: "hello world.txt", actorEmail: owner });
  const rows = await deliveries(notification.configId);
  assert.deepEqual(rows.map((r) => r.event).sort(), ["s3:ObjectCreated:Put", "s3:ObjectRemoved:Delete"]);
  await drain();
  const bodies = received.map((r) => JSON.parse(r.body).Records[0]);
  const created = bodies.find((r) => r.eventName === "ObjectCreated:Put");
  assert.equal(created.s3.bucket.name, "live");
  assert.equal(created.s3.object.key, "hello%20world.txt");
  assert.equal(created.s3.object.size, 5);
  assert.ok(bodies.find((r) => r.eventName === "ObjectRemoved:Delete"));
  assert.ok(doc.etag);
});

// ------------------------------------------------------------------ route

const req = (path, token, { method = "GET", body } = {}) =>
  new NextRequest(`http://localhost${path}`, { method, headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });

test("route: the owner manages notifications; another org's owner can't see, change or delete them", async () => {
  const { GET, POST, PATCH, DELETE } = await import("../src/app/api/orgs/s3-compat/notifications/route.js");
  const created = await (await POST(req("/x", ownerToken, { method: "POST", body: { orgId: String(orgId), action: "create", bucket: "routed", url: url(), events: ["s3:ObjectCreated:*"] } }))).json();
  assert.ok(created.secret && created.notification.configId);
  const id = created.notification.configId;

  const own = await (await GET(req(`/x?orgId=${orgId}&bucket=routed`, ownerToken))).json();
  assert.equal(own.notifications.length, 1);

  assert.equal((await GET(req(`/x?orgId=${orgId}`, otherToken))).status, 403, "not a member of that org");
  const asOther = await (await GET(req(`/x?orgId=${otherOrg}&bucket=routed`, otherToken))).json();
  assert.equal(asOther.notifications.length, 0, "their own org has none");
  assert.equal((await PATCH(req("/x", otherToken, { method: "PATCH", body: { orgId: String(otherOrg), configId: id, active: false } }))).status, 404, "can't reach another org's config id through their own org");
  assert.equal((await DELETE(req(`/x?orgId=${otherOrg}&configId=${id}`, otherToken, { method: "DELETE" }))).status, 404);

  assert.equal((await PATCH(req("/x", ownerToken, { method: "PATCH", body: { orgId: String(orgId), configId: id, active: false } }))).status, 200);
  assert.equal((await DELETE(req(`/x?orgId=${orgId}&configId=${id}`, ownerToken, { method: "DELETE" }))).status, 200);
  assert.equal((await (await GET(req(`/x?orgId=${orgId}&bucket=routed`, ownerToken))).json()).notifications.length, 0);
});

test("route: the delivery cron needs the cron secret", async () => {
  const { GET } = await import("../src/app/api/cron/s3-notifications/route.js");
  process.env.CRON_SECRET = `cron-${RUN}`;
  assert.equal((await GET(new NextRequest("http://localhost/api/cron/s3-notifications"))).status, 401);
  const ok = await GET(new NextRequest("http://localhost/api/cron/s3-notifications", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
  assert.equal(ok.status, 200);
});
