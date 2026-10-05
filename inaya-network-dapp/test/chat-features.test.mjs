// test/chat-features.test.mjs -- Secure Chat around the protocol: contacts and blocking, presence and typing (TTL), mute and
// notifications (no plaintext), encrypted attachments, realtime transport, rate limits, organization policy, offline outbox,
// and a scan proving no plaintext reaches logs, notifications or stored rows. Real MongoDB, real MLS.
// Run: node --env-file=.env.local --test --test-force-exit --test-timeout=300000 test/chat-features.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setup, teardown, makeChatOrg, client, c as colsRef } from "./_chat-fixtures.mjs";
import { chatDb, LIMITS } from "../src/lib/chat/common.js";
import * as conv from "../src/lib/chat/conversations.js";
import * as contacts from "../src/lib/chat/contacts.js";
import * as presence from "../src/lib/chat/presence.js";
import * as transport from "../src/lib/chat/transport.js";
import * as att from "../src/lib/chat/attachments.js";
import { DirectApi } from "../src/lib/chat/client/directApi.js";
import { getOrgCollections } from "../src/lib/orgs.js";

let org, A, B, C, group;
const T = { timeout: 300000 };
const SECRET = "ZX-SECRET-4471-neptune";
const logs = [];
const origLog = { log: console.log, error: console.error, warn: console.warn, info: console.info };

before(async () => {
  for (const k of Object.keys(origLog)) console[k] = (...a) => { logs.push(a.map(String).join(" ")); origLog[k](...a); };
  await setup(); org = await makeChatOrg("feat", { settings: { allowExternal: false } });
  [A, B, C] = await Promise.all([client(org, org.alice), client(org, org.bob), client(org, org.carol)]);
  group = (await A.createConversation({ kind: "group", emails: [org.bob.email, org.carol.email] })).conversationId;
  await B.sync(); await C.sync();
});
after(async () => { for (const k of Object.keys(origLog)) console[k] = origLog[k]; await teardown(); });

const api = (who) => new DirectApi({ orgId: org.oid, membership: who.membership, email: who.email });

test("contacts: request, accept, deny, cancel, remove; identical answers whether or not an address exists", T, async () => {
  const r1 = await contacts.requestContact({ orgId: org.oid, email: org.alice.email, toEmail: org.dave.email });
  assert.equal(r1.status, "sent");
  assert.equal((await contacts.listContacts({ orgId: org.oid, email: org.dave.email })).incoming.length, 1);
  assert.equal((await contacts.listContacts({ orgId: org.oid, email: org.alice.email })).outgoing.length, 1);
  const accepted = await contacts.acceptRequest({ email: org.dave.email, requestId: r1.requestId });
  assert.equal(accepted.with, org.alice.email);
  assert.equal((await contacts.listContacts({ orgId: org.oid, email: org.alice.email })).contacts.length, 1);
  assert.equal((await contacts.requestContact({ orgId: org.oid, email: org.alice.email, toEmail: org.dave.email })).status, "already-contacts");
  // only the recipient can accept; a sender cannot accept their own request
  const r2 = await contacts.requestContact({ orgId: org.oid, email: org.bob.email, toEmail: org.dave.email });
  await assert.rejects(() => contacts.acceptRequest({ email: org.bob.email, requestId: r2.requestId }), (e) => e.status === 404);
  assert.equal((await contacts.denyRequest({ email: org.dave.email, requestId: r2.requestId })).status, "denied");
  const r3 = await contacts.requestContact({ orgId: org.oid, email: org.carol.email, toEmail: org.dave.email });
  assert.equal((await contacts.cancelRequest({ email: org.carol.email, requestId: r3.requestId })).status, "cancelled");
  const list = await contacts.listContacts({ orgId: org.oid, email: org.alice.email });
  assert.equal((await contacts.removeContact({ email: org.alice.email, contactId: list.contacts[0].id })).removed, true);
  // outside the organization: refused while the organization does not allow it, and the error does not depend on whether the address exists
  const a = await contacts.requestContact({ orgId: org.oid, email: org.alice.email, toEmail: "nobody-real@example.net" }).catch((e) => e);
  const b = await contacts.requestContact({ orgId: org.oid, email: org.alice.email, toEmail: "someone-else@example.org" }).catch((e) => e);
  assert.equal(a.code, "EXTERNAL_DISABLED"); assert.equal(b.code, "EXTERNAL_DISABLED"); assert.equal(a.message, b.message);
});

test("blocking: removes the contact, stops new conversations either way, and the blocked person is told nothing", T, async () => {
  await contacts.blockPerson({ orgId: org.oid, email: org.carol.email, target: org.dave.email });
  const D = await client(org, org.dave);
  await assert.rejects(() => D.createConversation({ kind: "direct", emails: [org.carol.email] }), (e) => e.status === 403);
  await assert.rejects(() => C.createConversation({ kind: "direct", emails: [org.dave.email] }), (e) => e.status === 403);
  assert.deepEqual((await contacts.searchPeople({ orgId: org.oid, email: org.carol.email, q: "dave" })), [], "a blocked person disappears from search");
  const silent = await contacts.requestContact({ orgId: org.oid, email: org.dave.email, toEmail: org.carol.email });
  assert.equal(silent.status, "sent", "the blocked person sees a normal 'sent'");
  assert.equal((await contacts.listContacts({ orgId: org.oid, email: org.carol.email })).incoming.length, 0, "...but nothing reaches the blocker");
  await contacts.unblockPerson({ email: org.carol.email, target: org.dave.email });
  assert.equal((await contacts.searchPeople({ orgId: org.oid, email: org.carol.email, q: "dave" })).length, 1);
});

test("presence and appear-offline; typing appears for others and expires", T, async () => {
  await presence.heartbeat({ orgId: org.oid, email: org.alice.email });
  let p = await presence.getPresence({ orgId: org.oid, emails: [org.alice.email, org.bob.email] });
  assert.equal(p.find((x) => x.email === org.alice.email).state, "online"); assert.equal(p.find((x) => x.email === org.bob.email).state, "offline");
  await presence.setPrefs({ orgId: org.oid, email: org.alice.email, patch: { appearOffline: true } });
  p = await presence.getPresence({ orgId: org.oid, emails: [org.alice.email] });
  assert.equal(p[0].state, "offline", "appear-offline hides an existing heartbeat at once");
  assert.equal((await presence.heartbeat({ orgId: org.oid, email: org.alice.email })).recorded, false);
  await presence.setPrefs({ orgId: org.oid, email: org.alice.email, patch: { appearOffline: false } });
  // expiry (TTL index deletes lazily, so reads must filter by expiry themselves)
  await presence.heartbeat({ orgId: org.oid, email: org.alice.email });
  const k = await chatDb(); await k.presence.updateOne({ orgId: org.oid, email: org.alice.email }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await presence.getPresence({ orgId: org.oid, emails: [org.alice.email] }))[0].state, "offline");
  await presence.setTyping({ orgId: org.oid, email: org.bob.email, conversationId: group });
  assert.deepEqual(await presence.getTyping({ orgId: org.oid, email: org.alice.email, conversationId: group }), [org.bob.email]);
  assert.deepEqual(await presence.getTyping({ orgId: org.oid, email: org.bob.email, conversationId: group }), [], "you do not see yourself typing");
  await k.typing.updateOne({ conversationId: group, email: org.bob.email }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.deepEqual(await presence.getTyping({ orgId: org.oid, email: org.alice.email, conversationId: group }), []);
  await assert.rejects(() => presence.setTyping({ orgId: org.oid, email: org.dave.email, conversationId: group }), (e) => e.status === 404, "non-participants cannot signal typing");
});

test("notifications are generic and mute-aware; the message text never appears in one", T, async () => {
  const { db } = await getOrgCollections();
  await db.collection("notifications").deleteMany({ orgId: org.orgId });
  await api(org.carol).conversationDetail({ deviceId: C.device.deviceId, conversationId: group }); // sanity: carol can read the conversation
  await conv.updateMyState({ orgId: org.oid, email: org.carol.email, conversationId: group, patch: { muted: true } });
  await A.send(group, { text: `the code is ${SECRET}` });
  const notes = await db.collection("notifications").find({ orgId: org.orgId }).toArray();
  assert.ok(notes.some((n) => n.targetEmail === org.bob.email), "bob (not muted) is notified");
  assert.equal(notes.some((n) => n.targetEmail === org.carol.email), false, "carol (muted) is not");
  assert.equal(notes.some((n) => n.targetEmail === org.alice.email), false, "the sender is not");
  const dump = JSON.stringify(notes) + JSON.stringify(await (await chatDb()).deliveries.find({ orgId: org.oid }).toArray());
  assert.equal(dump.includes(SECRET), false); assert.equal(dump.includes("the code is"), false);
  assert.ok(notes.every((n) => n.type.startsWith("chat.") ? n.body === "Open Secure Chat to read it." : true), "the body is a fixed generic line");
  await conv.updateMyState({ orgId: org.oid, email: org.carol.email, conversationId: group, patch: { muted: false } });
  await B.sync(); await C.sync();
});

test("encrypted attachment: round trip, ciphertext-only storage, participants-only, tamper-evident", T, async () => {
  const bytes = new Uint8Array(randomBytes(3 * 1024 * 1024 + 123)); bytes.set(new TextEncoder().encode(SECRET + "-FILE"), 1000);
  const d = await A.attachFile(group, { bytes, name: "plan.bin", type: "application/octet-stream" });
  assert.equal(d.kind, "blob"); assert.ok(d.partCount >= 3);
  await A.send(group, { text: "see attached", attachments: [d] });
  const got = await B.sync();
  const m = got.fresh.find((x) => x.type === "msg" && x.text === "see attached");
  assert.equal(m.attachments[0].name, "plan.bin");
  const back = await B.downloadAttachment(group, m.attachments[0]);
  assert.equal(Buffer.compare(Buffer.from(back), Buffer.from(bytes)), 0);
  const k = await chatDb();
  const stored = await k.db.collection("chat_blob_parts").find({ blobId: d.blobId }).toArray();
  assert.equal(stored.length, d.partCount);
  assert.equal(Buffer.concat(stored.sort((x, y) => x.index - y.index).map((s) => Buffer.from(s.data.buffer))).includes(Buffer.from(SECRET)), false, "the stored bytes are ciphertext");
  // outsider (a member of the org who is not in the conversation) and a removed person cannot fetch
  await assert.rejects(() => att.readPart({ orgId: org.oid, email: org.dave.email, conversationId: group, blobId: d.blobId, index: 0 }), (e) => e.status === 404);
  const otherOrg = await makeChatOrg("feat-other", { people: ["eve"] });
  await assert.rejects(() => att.readPart({ orgId: otherOrg.oid, email: otherOrg.eve.email, conversationId: group, blobId: d.blobId, index: 0 }), (e) => e.status === 404);
  // tampering with a stored part is detected on download
  await k.db.collection("chat_blob_parts").updateOne({ blobId: d.blobId, index: 1 }, { $set: { data: new (await import("mongodb")).Binary(Buffer.alloc(stored.find((s) => s.index === 1).data.length(), 7)) } });
  await assert.rejects(() => B.downloadAttachment(group, m.attachments[0]), /integrity/);
  // limits
  await assert.rejects(() => att.beginAttachment({ orgId: org.oid, email: org.alice.email, conversationId: group, size: 40 * 1024 * 1024, partCount: 30 }), (e) => e.code === "TOO_LARGE");
  await assert.rejects(async () => att.completeAttachment({ orgId: org.oid, email: org.alice.email, conversationId: group, blobId: (await att.beginAttachment({ orgId: org.oid, email: org.alice.email, conversationId: group, size: 100, partCount: 1 })).blobId }), (e) => e.code === "INCOMPLETE");
});

test("a newcomer cannot fetch an attachment uploaded before they joined", T, async () => {
  const D = await client(org, org.dave);
  const d = await A.attachFile(group, { bytes: new Uint8Array(randomBytes(2000)), name: "old.bin", type: "application/octet-stream" });
  await new Promise((r) => setTimeout(r, 20));
  await A.addParticipants(group, [org.dave.email]); await D.sync();
  await assert.rejects(() => D.downloadAttachment(group, d), (e) => e.status === 404);
  const fresh = await A.attachFile(group, { bytes: new Uint8Array(randomBytes(2000)), name: "new.bin", type: "application/octet-stream" });
  assert.equal((await D.downloadAttachment(group, fresh)).length, 2000);
});

test("an existing Inaya document is referenced, not copied: no bytes and no key travel in the chat", T, async () => {
  const ref = A.attachInayaDocument({ documentId: "64b64b64b64b64b64b64b64b", name: "Q3.pdf", size: 1234 });
  await A.send(group, { text: "the Q3 report", attachments: [ref] });
  const got = await B.sync();
  const m = got.fresh.find((x) => x.text === "the Q3 report");
  assert.deepEqual(Object.keys(m.attachments[0]).sort(), ["documentId", "kind", "name", "size"]);
  await assert.rejects(() => B.downloadAttachment(group, m.attachments[0]), /Files view/);
});

test("transport: long-poll returns at once on news, waits (bounded) when there is none, and SSE signals news", T, async () => {
  const since0 = new Date().toISOString();
  const quiet = Date.now();
  await transport.longPollSync({ orgId: org.oid, email: org.bob.email, deviceId: B.device.deviceId, since: since0, waitMs: 2200, intervalMs: 500 });
  assert.ok(Date.now() - quiet >= 2000, "no news: held for about the wait time");
  await A.send(group, { text: "wake up" });
  const t0 = Date.now();
  const s = await transport.longPollSync({ orgId: org.oid, email: org.bob.email, deviceId: B.device.deviceId, since: since0, waitMs: 20000, intervalMs: 500 });
  assert.ok(Date.now() - t0 < 12000, "news: returned without waiting out the 20 s hold (the bound is generous because every database call here crosses the internet)");
  assert.ok(s.conversations.find((x) => x.id === group).lastSeq > 0);
  assert.equal(await transport.hasNewsSince({ orgId: org.oid, email: org.bob.email, deviceId: B.device.deviceId, since: new Date(Date.now() + 60000).toISOString() }), false);
  await assert.rejects(() => transport.longPollSync({ orgId: org.oid, email: org.bob.email, deviceId: "f".repeat(24), waitMs: 0 }), (e) => e.code === "DEVICE_REVOKED");
  const stream = transport.eventStream({ orgId: org.oid, email: org.bob.email, deviceId: B.device.deviceId, since: since0, maxMs: 4000, intervalMs: 300 });
  const reader = stream.getReader(); let text = ""; const end = Date.now() + 6000;
  while (Date.now() < end) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); if (text.includes("event: news")) break; }
  await reader.cancel().catch(() => {});
  assert.ok(text.includes("event: news"), "the stream announced the change");
  assert.equal(text.includes("wake up"), false, "the stream carries no content");
});

test("rate limits: message floods and contact-request floods are refused with 429", T, async () => {
  const old = LIMITS.messagesPerMinute; LIMITS.messagesPerMinute = 4;
  try {
    let refused = null;
    for (let i = 0; i < 8 && !refused; i++) { try { await B.send(group, { text: `flood ${i}` }); } catch (e) { refused = e; } }
    assert.equal(refused?.code, "RATE_LIMITED"); assert.equal(refused.status, 429);
  } finally { LIMITS.messagesPerMinute = old; }
  const oldC = LIMITS.contactRequestsPerHour; LIMITS.contactRequestsPerHour = 2;
  try {
    await assert.rejects(async () => { for (let i = 0; i < 5; i++) await contacts.requestContact({ orgId: org.oid, email: org.bob.email, toEmail: `x${i}-${org.dave.email}`.replace("chat-", "zz-") }).catch((e) => { if (e.code === "RATE_LIMITED") throw e; }); }, (e) => e.code === "RATE_LIMITED");
  } finally { LIMITS.contactRequestsPerHour = oldC; }
});

test("organization policy: editing can be switched off; only an owner/admin changes settings; org-wide conversations need an admin", T, async () => {
  await assert.rejects(() => conv.setChatSettings({ orgId: org.oid, membership: org.bob.membership, actorEmail: org.bob.email, patch: { allowEditing: false } }), (e) => e.status === 403);
  const sent = await A.send(group, { text: "editable?" });
  await conv.setChatSettings({ orgId: org.oid, membership: org.owner.membership, actorEmail: org.owner.email, patch: { allowEditing: false } });
  await assert.rejects(() => A.editMessage(group, sent.serverId, "changed"), (e) => e.code === "POLICY");
  await conv.setChatSettings({ orgId: org.oid, membership: org.owner.membership, actorEmail: org.owner.email, patch: { allowEditing: true } });
  await A.editMessage(group, sent.serverId, "changed");
  await assert.rejects(() => A.createConversation({ kind: "org" }), (e) => e.status === 403);
  const O = await client(org, org.owner);
  const made = await O.createConversation({ kind: "org" });
  const view = await conv.conversationDetail({ orgId: org.oid, email: org.owner.email, deviceId: O.device.deviceId, conversationId: made.conversationId });
  assert.ok(view.roster.length >= 5, "everyone in the organization is a participant");
  await A.sync();
  await O.send(made.conversationId, { text: "all hands" });
  assert.ok((await A.sync()).fresh.some((m) => m.text === "all hands"));
});

test("offline outbox: a send that fails on the network is queued and delivered exactly once on reconnect", T, async () => {
  const realSend = B.api.sendMessage.bind(B.api); let down = true;
  B.api.sendMessage = async (p) => { if (down) throw new Error("network down"); return realSend(p); };
  await assert.rejects(() => B.send(group, { text: "sent while offline" }), (e) => e.queued === true);
  assert.equal((await B.store.keys("outbox:")).length, 1);
  down = false; await B.sync();
  assert.equal((await B.store.keys("outbox:")).length, 0, "the queue drained");
  const got = await A.sync();
  assert.equal(got.fresh.filter((m) => m.text === "sent while offline").length, 1);
  await B.sync(); // a second flush must not duplicate
  assert.equal((await A.sync()).fresh.filter((m) => m.text === "sent while offline").length, 0);
  B.api.sendMessage = realSend;
});

test("local search runs on the device over decrypted text; the server never sees the query", T, async () => {
  await A.send(group, { text: "quarterly budget review tomorrow" });
  await B.sync();
  const hits = await B.search("budget review");
  assert.ok(hits.length >= 1 && hits[0].text.includes("budget"));
  assert.equal((await B.search("zzz-not-present")).length, 0);
  assert.equal(typeof B.api.search, "undefined", "there is no server search call at all");
});

test("revoking a device needs its owner or an admin; the security-event log records metadata only", T, async () => {
  const devs = await import("../src/lib/chat/devices.js");
  await assert.rejects(() => devs.revokeDevice({ orgId: org.oid, membership: org.bob.membership, actorEmail: org.bob.email, deviceId: A.device.deviceId }), (e) => e.status === 403);
  const k = await chatDb();
  const events = await k.securityEvents.find({ orgId: org.oid }).toArray();
  assert.ok(JSON.stringify(events).includes(SECRET) === false);
});

test("no plaintext anywhere: not in any stored row, notification, activity entry, or log line", T, async () => {
  const k = await chatDb(); const { db } = await getOrgCollections();
  const convIds = (await k.conversations.find({ orgId: org.oid }).project({ _id: 1 }).toArray()).map((x) => x._id);
  const rows = [
    await k.messages.find({ conversationId: { $in: convIds } }).toArray(), await k.envelopes.find({ conversationId: { $in: convIds } }).toArray(),
    await k.participants.find({ conversationId: { $in: convIds } }).toArray(), await k.conversations.find({ orgId: org.oid }).toArray(),
    await k.devices.find({ orgId: org.oid }).toArray(), await k.securityEvents.find({ orgId: org.oid }).toArray(),
    await db.collection("org_activity").find({ orgId: org.orgId, recordType: /^CHAT/ }).toArray(), await db.collection("notifications").find({ orgId: org.orgId }).toArray(),
  ];
  const all = JSON.stringify(rows);
  for (const s of [SECRET, "the code is", "see attached", "quarterly budget", "flood ", "all hands", "Project", "sent while offline"]) assert.equal(all.includes(s), false, `"${s}" leaked into storage`);
  const priv = [A, B, C].map((x) => x.device.sigPriv);
  for (const p of priv) assert.equal(all.includes(p), false, "a private signature key leaked");
  assert.equal(logs.join("\n").includes(SECRET), false, "plaintext reached a log line");
  void colsRef;
});
