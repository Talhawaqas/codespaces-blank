// test/metrics.test.mjs -- privacy-safe metrics (OBS-001): a fixed catalog (unknown names and free-text labels are dropped), latency buckets, per-organization counters, hooks in the real chat/gateway/compliance paths,
// organization route role rules, the client-report allowlist, and the platform Prometheus export (token gated, no organization id, no e-mail). Real MongoDB.
// Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=300000 test/metrics.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { setup, teardown, makeChatOrg, c as cols } from "./_chat-fixtures.mjs";
import { getOrgCollections, createSession, toObjectId } from "../src/lib/orgs.js";
import { setOrgFeature } from "../src/lib/featureFlags.js";
import * as M from "../src/lib/metrics/metrics.js";
import { recordSecurityEvent } from "../src/lib/chat/common.js";
import { takeSnapshot } from "../src/lib/compliance/implementation.js";
import * as orgRoute from "../src/app/api/orgs/metrics/[[...path]]/route.js";
import * as platformRoute from "../src/app/api/metrics/route.js";

const T = { timeout: 300000 };
let org, orgB, db, auditor, owner, member;
const settle = () => new Promise((r) => setTimeout(r, 600));
const total = async (o, name, days = 7) => (await M.orgMetrics({ orgId: o.oid, membership: o.owner.membership, days })).counters[name]?.total || 0;

before(async () => {
  await setup(); db = (await getOrgCollections()).db; org = await makeChatOrg("met", { people: ["member", "auditor"] }); orgB = await makeChatOrg("metb", { people: [] }); owner = org.owner; member = org.member;
  await cols.orgMembers.updateOne({ orgId: org.orgId, email: org.auditor.email }, { $set: { adminRoles: ["auditor"] } }); auditor = org.auditor;
  await setOrgFeature({ orgId: org.oid, name: "FEATURE_COMPLIANCE_READINESS", enabled: true });
});
after(async () => { await db.collection("metric_counters").deleteMany({ orgId: { $in: [org.orgId, orgB.orgId] } }); await db.collection("compliance_snapshots").deleteMany({ orgId: org.orgId }).catch(() => {}); await teardown(); });

test("catalog enforcement: unknown names, unknown labels and free-text labels are dropped; values are validated; latency goes into fixed buckets", T, async () => {
  assert.equal(await M.record("chat.not_a_metric", { orgId: org.oid }), false);
  assert.equal(await M.record("chat.security_event", { orgId: org.oid, label: "alice@example.com sent 'secret plan'" }), false, "free text can never become a label");
  assert.equal(await M.record("chat.message_sent", { orgId: org.oid, label: "anything" }), false, "a metric with no labels refuses one");
  assert.equal(await M.record("chat.message_sent", { orgId: org.oid, value: -1 }), false); assert.equal(await M.record("chat.message_sent", { orgId: org.oid, value: "x" }), false);
  assert.deepEqual([M.normalize("chat.delivery_latency_ms", { value: 90 }).label, M.normalize("chat.delivery_latency_ms", { value: 600 }).label, M.normalize("chat.delivery_latency_ms", { value: 99999 }).label], ["100", "1000", "inf"]);
  assert.equal(await M.record("chat.message_sent", { orgId: org.oid }), true); assert.equal(await total(org, "chat.message_sent"), 1);
  const all = JSON.stringify(await db.collection("metric_counters").find({ orgId: org.orgId }).toArray()); assert.equal(/secret plan|alice@/.test(all), false, "nothing free-text was stored");
  assert.equal(await M.metric("chat.message_sent", { orgId: "not-an-id" }), undefined, "recording never throws");
});

test("counters are per organization and aggregate per day and label", T, async () => {
  await M.record("storage.share_created", { orgId: org.oid, label: "link" }); await M.record("storage.share_created", { orgId: org.oid, label: "link" }); await M.record("storage.share_created", { orgId: org.oid, label: "member" }); await M.record("storage.share_created", { orgId: orgB.oid, label: "link" });
  const m = await M.orgMetrics({ orgId: org.oid, membership: owner.membership }); assert.equal(m.counters["storage.share_created"].total, 3); assert.deepEqual(m.counters["storage.share_created"].byLabel, { link: 2, member: 1 }); assert.equal(Object.keys(m.counters["storage.share_created"].byDay).length, 1);
  assert.equal((await M.orgMetrics({ orgId: orgB.oid, membership: orgB.owner.membership })).counters["storage.share_created"].total, 1, "another organization's counts are separate");
  assert.equal((await db.collection("metric_counters").countDocuments({ orgId: org.orgId, name: "storage.share_created" })), 2, "one document per (day, name, label), not per event");
});

test("hooks: real chat security events, snapshots and key operations produce counters", T, async () => {
  const before = await total(org, "chat.security_event"); await recordSecurityEvent({ orgId: org.oid, email: owner.email, type: "DEVICE_REVOKED", detail: "x" }); await recordSecurityEvent({ orgId: org.oid, email: owner.email, type: "SOMETHING_NEW" }); await settle();
  const m = await M.orgMetrics({ orgId: org.oid, membership: owner.membership }); assert.equal(m.counters["chat.security_event"].total, before + 2); assert.equal(m.counters["chat.security_event"].byLabel.OTHER, 1, "an unknown event type is bucketed as OTHER");
  await takeSnapshot({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email }); await settle(); assert.equal(await total(org, "compliance.snapshot"), 1);
});

test("hooks: real encrypted chat messages and epoch changes are counted without content", T, async () => {
  const { client } = await import("./_chat-fixtures.mjs"); const org2 = await makeChatOrg("metchat", { people: ["alice", "bob"] });
  try {
    const a = await client(org2, org2.alice, { label: "A" }); const b = await client(org2, org2.bob, { label: "B" }); const id = (await a.createConversation({ kind: "group", emails: [org2.bob.email] })).conversationId; await b.sync(); await a.send(id, { text: "hello metrics" }); await a.send(id, { text: "second" }); await settle();
    const m = await M.orgMetrics({ orgId: org2.oid, membership: org2.owner.membership }); assert.ok(m.counters["chat.message_sent"]?.total >= 2, `messages counted (${m.counters["chat.message_sent"]?.total})`); assert.ok(m.counters["chat.key_rotation"]?.total >= 1, "the epoch change counted");
    assert.equal(/hello metrics|second/.test(JSON.stringify(await db.collection("metric_counters").find({ orgId: org2.orgId }).toArray())), false);
  } finally { await db.collection("metric_counters").deleteMany({ orgId: org2.orgId }); }
});

test("organization route: administrators and auditors read, members cannot; gauges are live; client reports accept only the client allowlist", T, async () => {
  const sess = async (e) => (await createSession(e)).sessionToken; const [o, a, mem] = [await sess(owner.email), await sess(auditor.email), await sess(member.email)];
  const call = (cookie, path, method = "GET", body) => orgRoute[method](new NextRequest(`http://localhost:3000/api/orgs/metrics/${path}${path.includes("?") ? "&" : "?"}orgId=${org.oid}`, { method, headers: { cookie: `inaya_org_session=${cookie}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), { params: Promise.resolve({ path: path.split("?")[0].split("/").filter(Boolean) }) });
  assert.equal((await call(o, "")).status, 200); assert.equal((await call(a, "")).status, 200); assert.equal((await call(mem, "")).status, 403);
  assert.equal((await orgRoute.GET(new NextRequest(`http://localhost:3000/api/orgs/metrics?orgId=${org.oid}`), { params: Promise.resolve({ path: [] }) })).status, 401);
  const j = await (await call(o, "?days=7")).json(); assert.ok(j.gauges.gateway && j.gauges.storage && "jobs" in j.gauges); assert.equal(j.gauges.gateway.gateways, 0); assert.match(j.privacy, /No message text/); assert.ok(j.notCollected.length);
  const r = await (await call(mem, "client", "POST", { events: [{ name: "chat.decrypt_failure" }, { name: "chat.reconnect" }, { name: "chat.delivery_latency_ms", value: 320 }, { name: "chat.message_sent" }, { name: "storage.share_created", label: "link" }, { name: "evil", label: "<script>" }, { name: "storage.preview_failure", label: "x.pdf" }] })).json();
  assert.deepEqual([r.accepted, r.dropped], [3, 4], "server-side counters cannot be forged by a client, and a label on an unlabeled metric is dropped");
  const after = await (await call(o, "?days=7")).json(); assert.equal(after.counters["chat.decrypt_failure"].total, 1); assert.deepEqual(after.counters["chat.delivery_latency_ms"].byLabel, { 500: 1 });
  assert.equal((await call(mem, "client", "POST", { events: [] })).status, 200);
});

test("platform export: 404 without a configured token, 401 with a wrong one, Prometheus text with no organization id or e-mail when authorized", T, async () => {
  const req = (h) => new NextRequest("http://localhost:3000/api/metrics", { headers: h || {} }); const prev = process.env.METRICS_TOKEN;
  try {
    delete process.env.METRICS_TOKEN; assert.equal((await platformRoute.GET(req())).status, 404);
    process.env.METRICS_TOKEN = "short"; assert.equal((await platformRoute.GET(req({ authorization: "Bearer short" }))).status, 401, "a token under 16 characters is never accepted");
    process.env.METRICS_TOKEN = "t".repeat(32); assert.equal((await platformRoute.GET(req())).status, 401); assert.equal((await platformRoute.GET(req({ authorization: "Bearer wrong" }))).status, 401);
    const ok = await platformRoute.GET(req({ authorization: `Bearer ${"t".repeat(32)}` })); assert.equal(ok.status, 200); assert.match(ok.headers.get("content-type"), /text\/plain/);
    const text = await ok.text(); assert.match(text, /# TYPE inaya_chat_message_sent_total counter/); assert.match(text, /inaya_chat_message_sent_total \d+/); assert.match(text, /inaya_gateways_active \d+/);
    assert.equal(text.includes(org.oid) || text.includes(orgB.oid) || /@example\.com/.test(text), false, "no organization id or e-mail in the platform export");
    for (const line of text.split("\n").filter((l) => l && !l.startsWith("#"))) assert.match(line, /^[a-z0-9_]+(\{[a-zA-Z_]+="[^"]*"(,[a-zA-Z_]+="[^"]*")*\})? [\d.]+$/, `well-formed sample: ${line}`);
  } finally { if (prev === undefined) delete process.env.METRICS_TOKEN; else process.env.METRICS_TOKEN = prev; }
});
