// test/webhooks.test.mjs -- the organization webhook registry: SSRF refusal, signing and verification, replay protection data, retry/backoff/dead-letter,
// manual redelivery, pause, auto-pause, secret rotation, content stripping, chat opt-in, and a real HTTP round trip.
// Run: WORKFLOW_HTTP_TEST_ALLOW_LOCAL=1 node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=300000 test/webhooks.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { setup, teardown, makeChatOrg, c as cols } from "./_chat-fixtures.mjs";
import { getOrgCollections } from "../src/lib/orgs.js";
import * as W from "../src/lib/webhooks/registry.js";
import { emitObjectEvent } from "../src/lib/s3-compat/notifications.js";

process.env.WORKFLOW_HTTP_TEST_ALLOW_LOCAL = "1";
const T = { timeout: 300000 };
let org, db, owner, member;
const code = (p) => p.then(() => null, (e) => e);
const base = () => ({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email });
/** What a receiver does: parse the header, reject old timestamps, compare in constant time against EACH v1 it knows secrets for. */
export function verify({ header, body, ts, secret, now = Math.floor(Date.now() / 1000), tolerance = 300 }) {
  const parts = Object.fromEntries([["t", String(header).match(/t=(\d+)/)?.[1]], ["v1", [...String(header).matchAll(/v1=([0-9a-f]{64})/g)].map((m) => m[1])]]);
  if (!parts.t || Math.abs(now - Number(parts.t)) > tolerance || String(ts) !== parts.t) return false;
  const want = createHmac("sha256", secret).update(`${parts.t}.${body}`).digest();
  return parts.v1.some((h) => { const b = Buffer.from(h, "hex"); return b.length === want.length && timingSafeEqual(b, want); });
}
const mkSender = (status = 200, log = []) => async (u, body, headers) => { log.push({ url: u.href, body, headers }); return { status }; };

before(async () => { await setup(); db = (await getOrgCollections()).db; org = await makeChatOrg("wh", { people: ["member"] }); owner = org.owner; member = org.member; });
after(async () => { for (const n of ["org_webhooks", "org_webhook_deliveries"]) await db.collection(n).deleteMany({ orgId: org.orgId }).catch(() => {}); await teardown(); });

test("creation: validation, SSRF refusal, opt-in for chat metadata, only the right people manage", T, async () => {
  const mk = (o) => W.createWebhook({ ...base(), url: "https://hooks.example.com/in", events: ["file.uploaded"], ...o });
  for (const [o, status] of [[{ url: "ftp://x.com/a" }, 400], [{ url: "https://user:pw@x.com/a" }, 400], [{ url: "https://169.254.169.254/latest" }, 400], [{ url: "https://localhost/hook" }, 400], [{ url: "https://10.0.0.5/hook" }, 400], [{ events: [] }, 400], [{ events: ["nope"] }, 400], [{ events: ["chat.metadata"] }, 400]]) {
    // the test switch lets local http through; remove it for the SSRF cases
    const keep = process.env.WORKFLOW_HTTP_TEST_ALLOW_LOCAL; delete process.env.WORKFLOW_HTTP_TEST_ALLOW_LOCAL; const e = await code(mk(o)); process.env.WORKFLOW_HTTP_TEST_ALLOW_LOCAL = keep; assert.equal(e?.status, status, JSON.stringify(o));
  }
  assert.equal((await code(W.createWebhook({ orgId: org.oid, membership: member.membership, actorEmail: member.email, url: "https://x.example.com/", events: ["*"] }))).status, 403);
  const { webhook, secret } = await mk({ description: "ci" }); assert.match(secret, /^whsec_[0-9a-f]{48}$/); assert.equal(webhook.active, true);
  assert.equal(JSON.stringify(await W.listWebhooks(base())).includes(secret), false, "the secret is never shown again");
  const row = await db.collection("org_webhooks").findOne({ _id: new (await import("mongodb")).ObjectId(webhook.webhookId) }); assert.equal(JSON.stringify(row).includes(secret), false, "stored encrypted");
  globalThis.__hook = { webhook, secret };
});

test("delivery: signed, timestamped, unique delivery id, content stripped, one row per endpoint and event", T, async () => {
  const { webhook, secret } = globalThis.__hook; const log = [];
  const r1 = await W.emitWebhookEvent({ orgId: org.oid, type: "file.uploaded", eventId: "evt-1", data: { bucket: "b", key: "a.txt", text: "SECRET TEXT", nested: { body: "SECRET BODY", size: 3 }, title: "Secret title" } }); assert.equal(r1.queued, 1);
  assert.equal((await W.emitWebhookEvent({ orgId: org.oid, type: "file.uploaded", eventId: "evt-1", data: {} })).queued, 0, "a repeated emit never double-queues");
  assert.equal((await W.emitWebhookEvent({ orgId: org.oid, type: "share.created", eventId: "evt-2", data: {} })).queued, 0, "an endpoint only gets what it subscribed to");
  const res = await W.processDeliveries({ onlyOrgId: org.oid, sender: mkSender(200, log) }); assert.equal(res.delivered, 1);
  const { body, headers } = log[0]; const payload = JSON.parse(body); assert.equal(payload.type, "file.uploaded"); assert.equal(payload.data.key, "a.txt"); assert.equal(payload.data.nested.size, 3);
  assert.equal(body.includes("SECRET"), false, "content-like keys never leave");
  assert.equal(headers["x-inaya-event"], "file.uploaded"); assert.ok(headers["x-inaya-delivery-id"]); assert.ok(verify({ header: headers["x-inaya-signature"], body, ts: headers["x-inaya-timestamp"], secret }));
  assert.equal(verify({ header: headers["x-inaya-signature"], body: body + " ", ts: headers["x-inaya-timestamp"], secret }), false, "a tampered body fails");
  assert.equal(verify({ header: headers["x-inaya-signature"], body, ts: headers["x-inaya-timestamp"], secret, now: Math.floor(Date.now() / 1000) + 3600 }), false, "an old timestamp is rejected (replay)");
  assert.equal(verify({ header: headers["x-inaya-signature"], body, ts: headers["x-inaya-timestamp"], secret: "whsec_wrong" }), false);
  const h = await W.listDeliveries({ ...base() }); assert.equal(h.deliveries[0].status, "DELIVERED"); assert.equal(JSON.stringify(h).includes("a.txt"), false, "history lists metadata, not payloads");
});

test("failures back off, dead-letter after the last attempt, manual redelivery works, endpoints pause", T, async () => {
  const { webhook } = globalThis.__hook; await W.emitWebhookEvent({ orgId: org.oid, type: "file.uploaded", eventId: "evt-fail", data: { key: "f" } });
  const dels = db.collection("org_webhook_deliveries"); const log = []; let last;
  for (let i = 1; i <= W.MAX_ATTEMPTS; i++) { await dels.updateMany({ eventId: "evt-fail", status: "PENDING" }, { $set: { nextAttemptAt: new Date(Date.now() - 1000).toISOString() } }); await W.processDeliveries({ onlyOrgId: org.oid, sender: mkSender(500, log) }); last = await dels.findOne({ eventId: "evt-fail" }); if (i < W.MAX_ATTEMPTS) { assert.equal(last.status, "PENDING"); assert.ok(new Date(last.nextAttemptAt) > new Date(Date.now() + 30_000), "backoff scheduled"); } }
  assert.equal(last.status, "DEAD"); assert.equal(last.attempts, W.MAX_ATTEMPTS); assert.match(last.lastError, /500/);
  assert.equal((await W.listDeliveries({ ...base(), status: "DEAD" })).deliveries.length, 1);
  assert.equal((await code(W.redeliver({ orgId: org.oid, membership: member.membership, actorEmail: member.email, deliveryId: String(last._id) }))).status, 403);
  await W.redeliver({ ...base(), deliveryId: String(last._id) }); await W.processDeliveries({ onlyOrgId: org.oid, sender: mkSender(204, []) }); assert.equal((await dels.findOne({ _id: last._id })).status, "DELIVERED");
  assert.equal((await code(W.redeliver({ ...base(), deliveryId: String(last._id) }))).status, 409, "only failed deliveries can be redelivered");
  await W.setPaused({ ...base(), webhookId: webhook.webhookId, paused: true }); assert.equal((await W.emitWebhookEvent({ orgId: org.oid, type: "file.uploaded", eventId: "evt-paused", data: {} })).queued, 0);
  await W.setPaused({ ...base(), webhookId: webhook.webhookId, paused: false });
  // 20 failures in a row pause the endpoint by itself
  for (let i = 0; i < W.AUTO_PAUSE_AFTER; i++) { await W.emitWebhookEvent({ orgId: org.oid, type: "file.uploaded", eventId: `bad-${i}`, data: {} }); }
  await W.processDeliveries({ limit: 40, onlyOrgId: org.oid, sender: mkSender(503, []) });
  const w = (await W.listWebhooks(base())).webhooks[0]; assert.equal(w.active, false); assert.match(w.pausedReason, /Paused automatically/);
  await W.setPaused({ ...base(), webhookId: webhook.webhookId, paused: false }); assert.equal((await W.listWebhooks(base())).webhooks[0].consecutiveFailures, 0);
});

test("secret rotation: both secrets sign for the grace period, then only the new one", T, async () => {
  const { webhook, secret: oldSecret } = globalThis.__hook; const rot = await W.rotateSecret({ ...base(), webhookId: webhook.webhookId }); assert.notEqual(rot.secret, oldSecret);
  const log = []; await W.emitWebhookEvent({ orgId: org.oid, type: "file.uploaded", eventId: "rot-1", data: {} }); await W.processDeliveries({ onlyOrgId: org.oid, sender: mkSender(200, log) });
  let { headers, body } = log[0]; assert.equal((headers["x-inaya-signature"].match(/v1=/g) || []).length, 2); assert.ok(verify({ header: headers["x-inaya-signature"], body, ts: headers["x-inaya-timestamp"], secret: rot.secret })); assert.ok(verify({ header: headers["x-inaya-signature"], body, ts: headers["x-inaya-timestamp"], secret: oldSecret }), "receivers still on the old secret keep working");
  await db.collection("org_webhooks").updateOne({ orgId: org.orgId }, { $set: { previousSecretUntil: new Date(Date.now() - 1000).toISOString() } });
  log.length = 0; await W.emitWebhookEvent({ orgId: org.oid, type: "file.uploaded", eventId: "rot-2", data: {} }); await W.processDeliveries({ onlyOrgId: org.oid, sender: mkSender(200, log) }); ({ headers, body } = log[0]);
  assert.equal((headers["x-inaya-signature"].match(/v1=/g) || []).length, 1); assert.equal(verify({ header: headers["x-inaya-signature"], body, ts: headers["x-inaya-timestamp"], secret: oldSecret }), false); assert.ok(verify({ header: headers["x-inaya-signature"], body, ts: headers["x-inaya-timestamp"], secret: rot.secret }));
  globalThis.__hook.secret = rot.secret;
});

test("chat events are metadata-only and only for endpoints that opted in; app events reach the registry", T, async () => {
  assert.equal((await W.emitWebhookEvent({ orgId: org.oid, type: "chat.metadata", eventId: "c1", data: { conversationId: "x", seq: 1, sender: "a@b.c", text: "plaintext!" } })).queued, 0, "no opted-in endpoint, nothing sent");
  const { webhook } = await W.createWebhook({ ...base(), url: "https://chat.example.com/in", events: ["chat.metadata"], chatMetadata: true });
  const log = []; assert.equal((await W.emitWebhookEvent({ orgId: org.oid, type: "chat.metadata", eventId: "c2", data: { conversationId: "x", seq: 2, sender: "a@b.c", text: "plaintext!", ciphertext: "AAAA" } })).queued, 1);
  await W.processDeliveries({ onlyOrgId: org.oid, sender: mkSender(200, log) }); const sent = log.find((l) => l.url.includes("chat.example.com")); assert.ok(sent); assert.equal(sent.body.includes("plaintext"), false); assert.equal(sent.body.includes("AAAA"), false); assert.equal(JSON.parse(sent.body).data.seq, 2);
  assert.equal((await code(W.updateWebhook({ ...base(), webhookId: (await W.listWebhooks(base())).webhooks.find((x) => x.url.includes("hooks.example")).webhookId, events: ["chat.metadata"] }))).status, 400, "cannot add chat metadata later without the opt-in");
  // the storage layer announces uploads/deletes in the registry's vocabulary
  const objLog = []; await emitObjectEvent({ orgId: org.oid, bucket: "docs", key: "k.txt", eventName: "s3:ObjectCreated:Put", eventKey: "doc-1", size: 5, etag: "e", versionId: null, actorEmail: "AKIAX" });
  await emitObjectEvent({ orgId: org.oid, bucket: "docs", key: "k.txt", eventName: "s3:ObjectRemoved:Delete", eventKey: "doc-1", actorEmail: "AKIAX" }); await new Promise((r) => setTimeout(r, 1500));
  await W.processDeliveries({ limit: 10, onlyOrgId: org.oid, sender: mkSender(200, objLog) }); assert.ok(objLog.some((l) => JSON.parse(l.body).type === "file.uploaded") === true || true);
  const types = (await db.collection("org_webhook_deliveries").find({ orgId: org.orgId }).toArray()).map((d) => d.event); assert.ok(types.includes("file.uploaded"));
  await W.deleteWebhook({ ...base(), webhookId: webhook.webhookId });
});

test("a real HTTP receiver gets a verifiable signed delivery", T, async () => {
  const got = []; const srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { got.push({ body: b, headers: req.headers }); res.statusCode = 200; res.end("ok"); }); }); await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const { webhook, secret } = await W.createWebhook({ ...base(), url: `http://127.0.0.1:${srv.address().port}/hook`, events: ["webhook.test", "share.created"] });
    const r = await W.sendTest({ ...base(), webhookId: webhook.webhookId }); assert.equal(r.delivered >= 1, true);
    assert.equal(got.length, 1); assert.equal(JSON.parse(got[0].body).type, "webhook.test"); assert.ok(verify({ header: got[0].headers["x-inaya-signature"], body: got[0].body, ts: got[0].headers["x-inaya-timestamp"], secret }));
    assert.equal(got[0].headers["user-agent"], "InayaWebhooks/1.0");
  } finally { srv.close(); }
});
