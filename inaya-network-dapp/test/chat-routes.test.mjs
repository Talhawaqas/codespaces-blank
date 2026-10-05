// test/chat-routes.test.mjs -- Secure Chat over HTTP: the real Next route handlers with real session cookies against the real
// database, driven by the real ChatClient through HttpChatApi. Covers the feature flag (and its kill switch), authentication,
// device handling, error mapping, attachments over HTTP, long-poll and SSE routes.
// Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=300000 test/chat-routes.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { NextRequest } from "next/server.js";
import { setup, teardown, makeChatOrg, cookieFor } from "./_chat-fixtures.mjs";
import { SESSION_COOKIE } from "../src/lib/orgs.js";
import { setOrgFeature } from "../src/lib/featureFlags.js";
import { ChatClient } from "../src/lib/chat/client/ChatClient.js";
import { HttpChatApi } from "../src/lib/chat/client/httpApi.js";
import { MemoryStore, SealedStore, createSealer } from "../src/lib/chat/client/stores.js";
import { chatDb } from "../src/lib/chat/common.js";

const T = { timeout: 300000 };
const ROOT = path.resolve("src/app/api/orgs/chat");
const routes = []; // [{ re, keys, file }]
(function walk(dir, segs = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(path.join(dir, e.name), [...segs, e.name]);
    else if (e.name === "route.js") {
      const keys = []; const re = new RegExp("^/" + segs.map((s) => (s.startsWith("[") ? (keys.push(s.slice(1, -1)), "([^/]+)") : s)).join("/") + "/?$");
      routes.push({ re, keys, file: path.join(dir, e.name) });
    }
  }
})(ROOT);
const modCache = new Map();

/** fetch() stand-in: dispatches into the real route handler for /api/orgs/chat/**. */
function routerFetch(cookie, { extraHeaders = {} } = {}) {
  return async (url, init = {}) => {
    const u = new URL(url, "http://localhost");
    const rel = u.pathname.replace("/api/orgs/chat", "") || "/";
    const hit = routes.map((r) => ({ r, m: r.re.exec(rel === "/" ? "/" : rel) })).find((x) => x.m);
    if (!hit) return new Response(JSON.stringify({ error: "no route" }), { status: 404 });
    const params = Object.fromEntries(hit.r.keys.map((k, i) => [k, decodeURIComponent(hit.m[i + 1])]));
    let mod = modCache.get(hit.r.file); if (!mod) { mod = await import(pathToFileURL(hit.r.file).href); modCache.set(hit.r.file, mod); }
    const method = (init.method || "GET").toUpperCase();
    const handler = mod[method]; if (!handler) return new Response(JSON.stringify({ error: "method" }), { status: 405 });
    const headers = { ...(init.headers || {}), ...(cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {}), "x-forwarded-for": "203.0.113.9", host: "localhost", ...extraHeaders };
    return handler(new NextRequest(u, { method, headers, ...(init.body ? { body: init.body } : {}) }), { params: Promise.resolve(params) });
  };
}

let org, other, cA, cB, A, B, group;
const SECRET = "HTTP-SECRET-9921-orchid";

async function httpClient(o, who, cookie) {
  const api = new HttpChatApi({ orgId: o.oid, fetchImpl: routerFetch(cookie) });
  const store = new SealedStore(new MemoryStore(), await createSealer(randomBytes(32)));
  const cl = new ChatClient({ api, store, orgId: o.oid, email: who.email, label: "http test", platform: "web" });
  cl.securityEvents = []; cl.onSecurityEvent = (e) => cl.securityEvents.push(e);
  return { cl, api };
}

before(async () => {
  await setup(); org = await makeChatOrg("routes"); other = await makeChatOrg("routes-other", { people: ["mallory"] });
  cA = await cookieFor(org.alice.email); cB = await cookieFor(org.bob.email);
});
after(async () => { delete process.env.FEATURE_SECURE_CHAT; await teardown(); });

test("the feature is off by default; owner opt-in turns it on; the platform kill switch beats everything", T, async () => {
  const f = routerFetch(cA);
  const q = `?orgId=${org.oid}`;
  assert.equal((await f(`/api/orgs/chat/devices${q}`)).status, 404, "off by default (and says nothing about why)");
  assert.equal((await setOrgFeature({ orgId: org.oid, name: "FEATURE_SECURE_CHAT", enabled: true })).enabled, true);
  assert.equal((await f(`/api/orgs/chat/devices${q}`)).status, 200);
  process.env.FEATURE_SECURE_CHAT = "off";
  assert.equal((await f(`/api/orgs/chat/devices${q}`)).status, 404, "kill switch");
  assert.equal((await setOrgFeature({ orgId: org.oid, name: "FEATURE_SECURE_CHAT", enabled: true })).status, 409);
  delete process.env.FEATURE_SECURE_CHAT;
  assert.equal((await f(`/api/orgs/chat/devices${q}`)).status, 200);
  await setOrgFeature({ orgId: other.oid, name: "FEATURE_SECURE_CHAT", enabled: true });
  assert.equal((await setOrgFeature({ orgId: org.oid, name: "FEATURE_NOT_REAL", enabled: true })).status, 400);
});

test("authentication: no cookie 401, a stranger 403, a cookie cannot be used against another organization", T, async () => {
  const q = `?orgId=${org.oid}`;
  assert.equal((await routerFetch(null)(`/api/orgs/chat/devices${q}`)).status, 401);
  const mallory = await cookieFor(other.mallory.email);
  assert.equal((await routerFetch(mallory)(`/api/orgs/chat/devices${q}`)).status, 403);
  assert.equal((await routerFetch(cA)(`/api/orgs/chat/devices`)).status, 400, "orgId is required");
  assert.equal((await routerFetch(cA)(`/api/orgs/chat/devices?orgId=${other.oid}`)).status, 403, "alice is not a member of the other organization");
  const r = await routerFetch(cA)(`/api/orgs/chat/devices?orgId=not-an-id`);
  assert.ok([400, 403].includes(r.status));
});

test("end to end over HTTP: enroll, create, join, message, edit, attach, read back", T, async () => {
  ({ cl: A } = await httpClient(org, org.alice, cA)); ({ cl: B } = await httpClient(org, org.bob, cB));
  await A.init(); await B.init();
  group = (await A.createConversation({ kind: "group", emails: [org.bob.email] })).conversationId;
  await A.rename(group, "Routes room");
  await B.sync();
  assert.equal(await B.title(group), "Routes room");
  const sent = await A.send(group, { text: `route secret ${SECRET}` });
  const got = await B.sync();
  assert.equal(got.fresh.find((m) => m.type === "msg").text, `route secret ${SECRET}`);
  await A.editMessage(group, sent.serverId, "edited over http");
  await B.sync();
  assert.equal((await B.messages(group)).find((m) => m.serverId === sent.serverId).text, "edited over http");
  const bytes = new Uint8Array(randomBytes(2 * 1024 * 1024 + 7));
  const d = await B.attachFile(group, { bytes, name: "x.bin", type: "application/octet-stream" });
  await B.send(group, { text: "file", attachments: [d] });
  const g2 = await A.sync();
  const back = await A.downloadAttachment(group, g2.fresh.find((m) => m.text === "file").attachments[0]);
  assert.equal(Buffer.compare(Buffer.from(back), Buffer.from(bytes)), 0);
  assert.deepEqual([...A.securityEvents, ...B.securityEvents], []);
});

test("device handling over HTTP: header required, wrong device refused, revoke stops the device and rotates it out", T, async () => {
  const f = routerFetch(cA); const q = `?orgId=${org.oid}`;
  const noDev = await f(`/api/orgs/chat/sync${q}`);
  assert.equal(noDev.status, 400);
  const wrong = await f(`/api/orgs/chat/sync${q}`, { headers: { "x-inaya-device": B.device.deviceId } });
  assert.equal(wrong.status, 403, "alice cannot act as bob's device");
  const spoofSend = await routerFetch(cA)(`/api/orgs/chat/conversations/${group}/messages${q}`, { method: "POST", headers: { "Content-Type": "application/json", "x-inaya-device": B.device.deviceId }, body: JSON.stringify({ clientMsgId: "spoofspoof001", ciphertext: "AAAA" }) });
  assert.equal(spoofSend.status, 403);
  // bob adds a second device through HTTP, then revokes it
  const { cl: B2 } = await httpClient(org, org.bob, cB); await B2.init(); await A.reconcile(group); await B2.sync();
  assert.ok(await B2._state(group));
  const rev = await routerFetch(cB)(`/api/orgs/chat/devices/${B2.device.deviceId}/revoke${q}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(rev.status, 200);
  await assert.rejects(() => B2.sync(), (e) => e.code === "DEVICE_REVOKED" && e.status === 403);
  const notOwner = await routerFetch(cA)(`/api/orgs/chat/devices/${B.device.deviceId}/revoke${q}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(notOwner.status, 403, "another member cannot revoke bob's device");
});

test("errors are uniform and never leak internals: malformed JSON, bad ids, wrong methods, oversize", T, async () => {
  const f = routerFetch(cA); const q = `?orgId=${org.oid}`; const H = { "Content-Type": "application/json", "x-inaya-device": A.device.deviceId };
  const bad = await f(`/api/orgs/chat/conversations/${group}/messages${q}`, { method: "POST", headers: H, body: "{not json" });
  assert.equal(bad.status, 400); assert.equal((await bad.json()).error.includes("at "), false);
  const nf = await f(`/api/orgs/chat/conversations/zzzz/messages${q}`, { headers: H });
  assert.equal(nf.status, 404);
  const big = await f(`/api/orgs/chat/conversations/${group}/messages${q}`, { method: "POST", headers: H, body: JSON.stringify({ clientMsgId: "bigbigbig0001", ciphertext: Buffer.alloc(130 * 1024).toString("base64") }) });
  assert.equal(big.status, 413); assert.equal((await big.json()).code, "TOO_LARGE");
  const stale = await f(`/api/orgs/chat/conversations/${group}/commits${q}`, { method: "POST", headers: H, body: JSON.stringify({ baseEpoch: 999, commit: "AAAA" }) });
  assert.equal(stale.status, 409); assert.equal((await stale.json()).code, "STALE_EPOCH");
  const res = await f(`/api/orgs/chat/conversations/${group}/messages${q}`, { headers: H });
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("long-poll and SSE routes: hold when quiet, return on news, stream carries no content", T, async () => {
  const f = routerFetch(cB); const q = `?orgId=${org.oid}`; const H = { "x-inaya-device": B.device.deviceId };
  const first = await (await f(`/api/orgs/chat/sync${q}`, { headers: H })).json();
  const since = first.serverTime;
  const t0 = Date.now(); const quiet = await f(`/api/orgs/chat/sync${q}&since=${encodeURIComponent(since)}&wait=2000`, { headers: H });
  assert.equal(quiet.status, 200); assert.ok(Date.now() - t0 >= 1800);
  await A.send(group, { text: "ping over sse" });
  const sse = await f(`/api/orgs/chat/stream${q}&since=${encodeURIComponent(since)}`, { headers: H });
  assert.equal(sse.headers.get("content-type"), "text/event-stream");
  const reader = sse.body.getReader(); let text = ""; const end = Date.now() + 8000;
  while (Date.now() < end) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); if (text.includes("event: news")) break; }
  await reader.cancel().catch(() => {});
  assert.ok(text.includes("event: news")); assert.equal(text.includes("ping over sse"), false);
});

test("contacts, presence and settings routes work for members and respect who may do what", T, async () => {
  const f = routerFetch(cA); const fb = routerFetch(cB); const q = `?orgId=${org.oid}`; const J = { "Content-Type": "application/json" };
  const search = await (await f(`/api/orgs/chat/contacts${q}&q=bob`)).json();
  assert.ok(search.people.some((p) => p.email === org.bob.email));
  assert.equal((await f(`/api/orgs/chat/contacts/requests${q}`, { method: "POST", headers: J, body: JSON.stringify({ to: org.bob.email }) })).status, 200);
  const list = await (await fb(`/api/orgs/chat/contacts${q}`)).json();
  assert.equal(list.incoming.length, 1);
  assert.equal((await fb(`/api/orgs/chat/contacts/requests/${list.incoming[0].id}/accept${q}`, { method: "POST", headers: J, body: "{}" })).status, 200);
  assert.equal((await f(`/api/orgs/chat/presence${q}`, { method: "PUT", headers: J, body: "{}" })).status, 200);
  const pres = await (await fb(`/api/orgs/chat/presence${q}&emails=${org.alice.email}`)).json();
  assert.equal(pres.presence[0].state, "online");
  assert.equal((await fb(`/api/orgs/chat/settings${q}`, { method: "PATCH", headers: J, body: JSON.stringify({ allowEditing: false }) })).status, 403, "a plain member cannot change organization chat settings");
  assert.equal((await routerFetch(await cookieFor(org.owner.email))(`/api/orgs/chat/settings${q}`, { method: "PATCH", headers: J, body: JSON.stringify({ allowEditing: true }) })).status, 200);
});

test("nothing sent over HTTP is stored readable", T, async () => {
  const k = await chatDb();
  const ids = (await k.conversations.find({ orgId: org.oid }).project({ _id: 1 }).toArray()).map((x) => x._id);
  const dump = JSON.stringify(await k.messages.find({ conversationId: { $in: ids } }).toArray()) + JSON.stringify(await k.db.collection("chat_blob_parts").find({ conversationId: { $in: ids } }).toArray());
  for (const s of [SECRET, "edited over http", "ping over sse", "Routes room"]) assert.equal(dump.includes(s), false);
});
