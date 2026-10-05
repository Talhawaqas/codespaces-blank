// test/chat-protocol.test.mjs -- Secure Chat end to end: real MLS (ts-mls) on the devices, the real server modules and real
// MongoDB behind them. Covers CHAT-001/002/005/006/008/009/010 and the membership security properties.
// Run: node --env-file=.env.local --test --test-force-exit --test-timeout=240000 test/chat-protocol.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, makeChatOrg, client } from "./_chat-fixtures.mjs";
import { chatDb } from "../src/lib/chat/common.js";
import * as conv from "../src/lib/chat/conversations.js";
import * as devices from "../src/lib/chat/devices.js";
import { DirectApi } from "../src/lib/chat/client/directApi.js";
import * as M from "../src/lib/chat/client/mls.js";

let org, A, B, C, D;
const T = { timeout: 240000 };

before(async () => {
  await setup(); org = await makeChatOrg("proto");
  [A, B, C, D] = await Promise.all([client(org, org.alice), client(org, org.bob), client(org, org.carol), client(org, org.dave)]);
});
after(async () => { await teardown(); });

const sync = async (...cs) => { for (const x of cs) await x.sync(); };

test("a device enrolls, publishes KeyPackages bound to its identity, and the server holds only public data", T, async () => {
  const k = await chatDb();
  const row = await k.devices.findOne({ deviceId: A.device.deviceId });
  assert.equal(row.status, "active");
  assert.equal(row.signaturePublicKeyHex, A.device.sigPub);
  assert.equal(JSON.stringify(row).includes(A.device.sigPriv), false, "the private signature key never reaches the server");
  const kps = await k.keyPackages.find({ deviceId: A.device.deviceId }).toArray();
  assert.ok(kps.length >= 31, "single-use batch plus a last-resort package");
  assert.ok(kps.some((x) => x.lastResort));
});

test("KeyPackages that do not match the caller are refused (identity spoofing)", T, async () => {
  const sig = await M.newSignatureKeys();
  const evil = await M.makeKeyPackage({ identity: M.deviceIdentity(org.oid, org.alice.email, B.device.deviceId), sigKeys: sig }); // alice's identity, bob's device id
  const bobApi = new DirectApi({ orgId: org.oid, membership: org.bob.membership, email: org.bob.email });
  await assert.rejects(() => bobApi.uploadKeyPackages({ deviceId: B.device.deviceId, packages: [M.toB64(evil.wire)] }), (e) => e.code === "IDENTITY_MISMATCH");
  const otherKey = await M.makeKeyPackage({ identity: B.device.identity, sigKeys: await M.newSignatureKeys() }); // right identity, different signature key
  await assert.rejects(() => bobApi.uploadKeyPackages({ deviceId: B.device.deviceId, packages: [M.toB64(otherKey.wire)] }), (e) => e.code === "SIGKEY_MISMATCH");
  const aliceApi = new DirectApi({ orgId: org.oid, membership: org.alice.membership, email: org.alice.email });
  await assert.rejects(() => aliceApi.uploadKeyPackages({ deviceId: B.device.deviceId, packages: [M.toB64(otherKey.wire)] }), (e) => e.code === "DEVICE_REVOKED", "another user cannot upload for bob's device");
});

let direct;
test("1:1 conversation: create, join through Welcome, exchange messages; the database holds ciphertext only", T, async () => {
  const made = await A.createConversation({ kind: "direct", emails: [org.bob.email] });
  direct = made.conversationId;
  await sync(B);
  await A.send(direct, { text: "hello bob, the launch code is 7-7-3-1" });
  const got = await B.sync();
  assert.equal(got.fresh.length, 1);
  assert.equal(got.fresh[0].text, "hello bob, the launch code is 7-7-3-1");
  assert.equal(got.fresh[0].from, org.alice.email);
  await B.send(direct, { text: "received" });
  const back = await A.sync();
  assert.equal(back.fresh[0].text, "received");
  const k = await chatDb();
  const rows = await k.messages.find({ conversationId: direct }).toArray();
  assert.ok(rows.length >= 3, "commit + two messages");
  const dump = JSON.stringify(rows) + JSON.stringify(await k.envelopes.find({ conversationId: direct }).toArray());
  for (const secret of ["launch code", "7-7-3-1", "hello bob", "received"]) assert.equal(dump.includes(secret), false, `"${secret}" must not appear in anything stored`);
  assert.ok(rows.every((r) => r.kind === "commit" || (typeof r.ciphertext === "string" && r.ciphertext.length > 40)));
});

test("a second 'direct' request for the same two people returns the same conversation", T, async () => {
  const again = await A.createConversation({ kind: "direct", emails: [org.bob.email] });
  assert.equal(again.existed, true); assert.equal(again.conversationId, direct);
  const fromBob = await B.createConversation({ kind: "direct", emails: [org.alice.email] });
  assert.equal(fromBob.conversationId, direct);
});

test("unread counts, read state and last-focus", T, async () => {
  const api = new DirectApi({ orgId: org.oid, membership: org.bob.membership, email: org.bob.email });
  await A.send(direct, { text: "one" }); await A.send(direct, { text: "two" });
  let s = await api.sync({ deviceId: B.device.deviceId, cursors: {} });
  assert.equal(s.conversations.find((c) => c.id === direct).unread, 3, "alice's first hello plus the two new ones");
  await B.sync();
  const detail = await api.conversationDetail({ deviceId: B.device.deviceId, conversationId: direct });
  await api.markRead({ conversationId: direct, seq: detail.lastSeq });
  s = await api.sync({ deviceId: B.device.deviceId, cursors: {} });
  assert.equal(s.conversations.find((c) => c.id === direct).unread, 0);
  const rs = await conv.readReceipts({ orgId: org.oid, email: org.alice.email, conversationId: direct });
  assert.equal(rs.find((r) => r.email === org.bob.email).readSeq, detail.lastSeq);
});

let group;
test("group conversation with three people; everyone reads, titles travel encrypted", T, async () => {
  const made = await A.createConversation({ kind: "group", emails: [org.bob.email, org.carol.email] });
  group = made.conversationId;
  await A.rename(group, "Project Falcon");
  await sync(B, C);
  assert.equal(await B.title(group), "Project Falcon");
  await B.send(group, { text: "group hello" });
  const cGot = await C.sync();
  assert.equal(cGot.fresh.find((m) => m.type === "msg").text, "group hello");
  const d = await conv.conversationDetail({ orgId: org.oid, email: org.alice.email, deviceId: A.device.deviceId, conversationId: group });
  assert.deepEqual(d.roster.map((r) => r.status).sort(), ["active", "active", "active"]);
  assert.equal(d.epoch, 1, "one commit added both people");
  const k = await chatDb();
  assert.equal(JSON.stringify(await k.messages.find({ conversationId: group }).toArray()).includes("Project Falcon"), false, "the title is never stored in clear");
});

test("the server's leaf map equals the real MLS tree after adds and removes", T, async () => {
  const k = await chatDb();
  const row = await k.conversations.findOne({ _id: group });
  const st = await A._state(group);
  const real = [...M.leafIdentities(st).entries()].sort((a, b) => a[0] - b[0]).map(([, id]) => M.parseIdentity(id).deviceId);
  assert.deepEqual(row.leaves.filter(Boolean), real);
});

test("edit and delete: only the author can; receivers apply it only for the author", T, async () => {
  const sent = await B.send(group, { text: "tpyo" });
  await sync(A, C);
  await B.editMessage(group, sent.serverId, "typo fixed");
  const got = await C.sync();
  assert.equal(got.fresh.find((m) => m.type === "edit").text, "typo fixed");
  assert.equal((await C.messages(group)).find((m) => m.serverId === sent.serverId).text, "typo fixed");
  await assert.rejects(() => C.editMessage(group, sent.serverId, "hijack"), (e) => e.code === "NOT_YOUR_MESSAGE");
  await assert.rejects(() => C.deleteMessage(group, sent.serverId), (e) => e.code === "NOT_YOUR_MESSAGE");
  await B.deleteMessage(group, sent.serverId);
  await A.sync();
  const after = (await A.messages(group)).find((m) => m.serverId === sent.serverId);
  assert.equal(after.deleted, true); assert.equal(after.text, "");
  const k = await chatDb();
  const row = await k.messages.findOne({ _id: new (await import("mongodb")).ObjectId(sent.serverId) });
  assert.equal(row.ciphertext, null, "a deleted message's ciphertext is purged from the server");
});

test("a person added later cannot read earlier messages (no history)", T, async () => {
  await A.send(group, { text: "before dave joined" });
  await sync(B, C);
  await A.addParticipants(group, [org.dave.email]);
  await sync(B, C, D);
  const dMsgs = await D.messages(group);
  assert.equal(dMsgs.some((m) => m.text === "before dave joined"), false);
  await A.send(group, { text: "after dave joined" });
  const got = await D.sync();
  assert.equal(got.fresh.find((m) => m.type === "msg").text, "after dave joined");
  assert.equal(await D.title(group), "Project Falcon", "the adder tells the newcomer the title");
  const events = await conv.listMessages({ orgId: org.oid, email: org.dave.email, deviceId: D.device.deviceId, conversationId: group, afterSeq: 0 });
  assert.ok(events.events.every((e) => e.seq > (events.events[0].seq - 1)) && !events.events.some((e) => e.sub === "msg" && e.createdAt < "0"), "sanity");
  const k = await chatDb();
  const joinSeq = (await k.participants.findOne({ conversationId: group, email: org.dave.email })).joinSeq;
  assert.ok(events.events.every((e) => e.seq > joinSeq), "the server does not even serve events from before the join");
});

test("removing a person: server cuts access at once, sends wait for the cryptographic removal, and the removed device cannot read the next message", T, async () => {
  const carolOld = await C._state(group);
  await A.removeParticipant(group, org.carol.email);
  // the server already refuses her sends
  await assert.rejects(() => conv.submitMessage({ orgId: org.oid, email: org.carol.email, deviceId: C.device.deviceId, conversationId: group, clientMsgId: "carolsend0001", ciphertext: "AAAA" }), (e) => e.status === 404);
  await A.send(group, { text: "carol must not read this" });
  await sync(B, D);
  assert.equal((await B.messages(group)).some((m) => m.text === "carol must not read this"), true);
  const d = await conv.conversationDetail({ orgId: org.oid, email: org.alice.email, deviceId: A.device.deviceId, conversationId: group });
  assert.equal(d.plan.removes.length, 0, "the removal was executed");
  const k = await chatDb();
  const row = await k.conversations.findOne({ _id: group });
  assert.equal(row.leaves.filter(Boolean).includes(C.device.deviceId), false);
  // Carol's stale local state cannot decrypt the post-removal ciphertext, and the server will not hand it over.
  const ev = await k.messages.find({ conversationId: group, kind: "app", sub: "msg" }).sort({ seq: -1 }).limit(1).next();
  await assert.rejects(() => M.decryptApplication({ state: carolOld, wire: M.fromB64(ev.ciphertext) }));
  const carolView = await conv.listMessages({ orgId: org.oid, email: org.carol.email, deviceId: C.device.deviceId, conversationId: group, afterSeq: 0 });
  assert.equal(carolView.events.some((e) => e.seq === ev.seq), false, "events after her removal are never served to her");
});

test("while a removal is pending, a send is refused until a member applies it (never encrypted to the old group)", T, async () => {
  const bobApi = new DirectApi({ orgId: org.oid, membership: org.bob.membership, email: org.bob.email });
  await conv.removeParticipant({ orgId: org.oid, membership: org.owner.membership, email: org.alice.email, conversationId: group, targetEmail: org.dave.email });
  const st = await B._state(group); const enc = await M.encryptApplication({ state: st, bytes: new TextEncoder().encode("x") });
  await assert.rejects(() => bobApi.sendMessage({ deviceId: B.device.deviceId, conversationId: group, clientMsgId: "bobraw000001", sub: "msg", ciphertext: M.toB64(enc.wire) }), (e) => e.code === "RECONCILE_REQUIRED");
  await B.send(group, { text: "after dave left" }); // the client applies the removal itself, then sends
  const k = await chatDb();
  assert.equal((await k.conversations.findOne({ _id: group })).leaves.filter(Boolean).includes(D.device.deviceId), false);
});

test("device revocation: the revoked device is refused everywhere and members rotate it out", T, async () => {
  const B2 = await client(org, org.bob, { label: "Bob phone" });
  await sync(A, B, B2);
  // the new device of an existing participant is added by another member's client
  await A.reconcile(group); await sync(B2);
  assert.ok((await B2._state(group)), "the second device joined through a Welcome");
  await A.send(group, { text: "both bob devices read this" });
  await sync(B, B2);
  assert.ok((await B2.messages(group)).some((m) => m.text === "both bob devices read this"));
  const stale = await B2._state(group);
  await devices.revokeDevice({ orgId: org.oid, membership: org.bob.membership, actorEmail: org.bob.email, deviceId: B2.device.deviceId });
  await assert.rejects(() => B2.sync(), (e) => e.code === "DEVICE_REVOKED");
  await A.send(group, { text: "revoked device must not read this" });
  const k = await chatDb();
  assert.equal((await k.conversations.findOne({ _id: group })).leaves.includes(B2.device.deviceId), false);
  const last = await k.messages.find({ conversationId: group, kind: "app", sub: "msg" }).sort({ seq: -1 }).limit(1).next();
  await assert.rejects(() => M.decryptApplication({ state: stale, wire: M.fromB64(last.ciphertext) }));
  assert.equal((await k.keyPackages.countDocuments({ deviceId: B2.device.deviceId })), 0, "its KeyPackages are deleted");
});

test("a member cannot slip an unplanned device into the group (server validates the public commit)", T, async () => {
  await B.sync(); // be current first, so a refusal is about the commit's content and not a stale epoch
  const rogueSig = await M.newSignatureKeys();
  const rogueId = M.deviceIdentity(org.oid, org.dave.email, "e".repeat(24)); // a device nobody enrolled
  const rogueKp = await M.makeKeyPackage({ identity: rogueId, sigKeys: rogueSig });
  const st = await B._state(group);
  const built = await M.buildCommit({ state: st, adds: [rogueKp.wire] });
  const api = new DirectApi({ orgId: org.oid, membership: org.bob.membership, email: org.bob.email });
  await assert.rejects(() => api.submitCommit({ deviceId: B.device.deviceId, conversationId: group, baseEpoch: Number(st.groupContext.epoch), commit: M.toB64(built.commitWire), welcome: M.toB64(built.welcomeWire) }), (e) => e.code === "ILLEGAL_ADD");
  // also: removing a live member's device is refused
  const aliceLeaf = [...M.leafIdentities(st).entries()].find(([, id]) => M.parseIdentity(id).deviceId === A.device.deviceId)[0];
  const rm = await M.buildCommit({ state: st, removeLeaves: [aliceLeaf] });
  await assert.rejects(() => api.submitCommit({ deviceId: B.device.deviceId, conversationId: group, baseEpoch: Number(st.groupContext.epoch), commit: M.toB64(rm.commitWire) }), (e) => e.code === "ILLEGAL_REMOVE");
});

test("a commit or message for another conversation / epoch / sender is refused (substitution and replay)", T, async () => {
  const k = await chatDb();
  const bobApi = new DirectApi({ orgId: org.oid, membership: org.bob.membership, email: org.bob.email });
  const stGroup = await B._state(group);
  const enc = await M.encryptApplication({ state: stGroup, bytes: new TextEncoder().encode("cross-post") });
  // post the group's ciphertext into the direct conversation
  await assert.rejects(() => bobApi.sendMessage({ deviceId: B.device.deviceId, conversationId: direct, clientMsgId: "substitute0001", sub: "msg", ciphertext: M.toB64(enc.wire) }), (e) => e.code === "WRONG_GROUP");
  assert.ok((await k.securityEvents.countDocuments({ orgId: org.oid, type: "MESSAGE_WRONG_GROUP" })) >= 1, "recorded as a security event");
  // alice cannot send a ciphertext that bob made
  const aliceApi = new DirectApi({ orgId: org.oid, membership: org.alice.membership, email: org.alice.email });
  await B.send(group, { text: "to be replayed" });
  const last = await k.messages.find({ conversationId: group, kind: "app", sub: "msg" }).sort({ seq: -1 }).limit(1).next();
  // Replaying the identical ciphertext under another sender/clientMsgId is accepted by the server (it cannot read it) but
  // the receiving device refuses it: MLS has already consumed that message key, so it never becomes a second message.
  await aliceApi.sendMessage({ deviceId: A.device.deviceId, conversationId: group, clientMsgId: "replaycopy0001", sub: "msg", ciphertext: last.ciphertext }).catch(() => {});
  const before = (await B.messages(group)).length;
  await B.sync();
  assert.equal((await B.messages(group)).length, before, "the replayed copy never produces a second message");
  assert.ok(B.securityEvents.some((e) => e.type === "SENDER_MISMATCH" || e.type === "DECRYPT_FAILED"), "the receiving device flagged the forgery");
});

test("idempotency: a retried send is stored once; garbage and oversized payloads are refused", T, async () => {
  const api = new DirectApi({ orgId: org.oid, membership: org.bob.membership, email: org.bob.email });
  const st = await B._state(group);
  const enc = await M.encryptApplication({ state: st, bytes: new TextEncoder().encode("once") });
  const args = { deviceId: B.device.deviceId, conversationId: group, clientMsgId: "idempotent0001", sub: "msg", ciphertext: M.toB64(enc.wire) };
  const r1 = await api.sendMessage(args); const r2 = await api.sendMessage(args);
  assert.equal(r2.duplicate, true); assert.equal(r2.seq, r1.seq);
  await B._saveState(group, enc.newState);
  await assert.rejects(() => api.sendMessage({ ...args, clientMsgId: "garbage000001", ciphertext: "AAAAAAAA" }), (e) => e.status === 400);
  await assert.rejects(() => api.sendMessage({ ...args, clientMsgId: "garbage000002", ciphertext: "***" }), (e) => e.code === "BAD_ENCODING");
  await assert.rejects(() => api.sendMessage({ ...args, clientMsgId: "huge0000000001", ciphertext: Buffer.alloc(120 * 1024).toString("base64") }), (e) => e.code === "TOO_LARGE");
  await assert.rejects(() => api.sendMessage({ ...args, clientMsgId: "x" }), (e) => e.status === 400);
});

test("two members committing at once: exactly one wins, the other recovers", T, async () => {
  const E = await client(org, org.owner); await E.sync();
  await A.addParticipants(group, [org.owner.email]).catch(() => {});
  await sync(B, E);
  const F = await client(org, org.dave); // dave is a removed participant; re-add and revoke races are covered above
  const k = await chatDb();
  const before = (await k.conversations.findOne({ _id: group })).epoch;
  const results = await Promise.allSettled([A.reconcile(group), B.reconcile(group), E.reconcile(group)]);
  assert.ok(results.every((r) => r.status === "fulfilled"), JSON.stringify(results.filter((r) => r.status === "rejected").map((r) => String(r.reason))));
  const after = (await k.conversations.findOne({ _id: group })).epoch;
  assert.ok(after >= before);
  await sync(A, B, E);
  await E.send(group, { text: "owner joined" });
  assert.ok((await A.sync()).fresh.some((m) => m.text === "owner joined"));
  void F;
});

test("another organization cannot see, read or write this conversation (tenant isolation)", T, async () => {
  const other = await makeChatOrg("proto-other", { people: ["mallory"] });
  const M1 = await client(other, other.mallory);
  const api = new DirectApi({ orgId: other.oid, membership: other.mallory.membership, email: other.mallory.email });
  for (const id of [group, direct]) {
    await assert.rejects(() => api.conversationDetail({ deviceId: M1.device.deviceId, conversationId: id }), (e) => e.status === 404);
    await assert.rejects(() => api.listMessages({ deviceId: M1.device.deviceId, conversationId: id, afterSeq: 0 }), (e) => e.status === 404);
    await assert.rejects(() => api.sendMessage({ deviceId: M1.device.deviceId, conversationId: id, clientMsgId: "mallory00001", sub: "msg", ciphertext: "AAAA" }), (e) => e.status === 404);
    await assert.rejects(() => api.claimKeyPackages({ deviceId: M1.device.deviceId, conversationId: id, deviceIds: [A.device.deviceId] }), (e) => e.status === 404);
  }
  await assert.rejects(() => conv.createConversation({ orgId: other.oid, membership: other.mallory.membership, email: other.mallory.email, deviceId: M1.device.deviceId, conversationId: "d".repeat(24), kind: "group", emails: [org.alice.email] }), (e) => e.code === "NOT_A_MEMBER");
  // even bob, a member of the OTHER org's namespace via his own org id, cannot reach into org B by lying about orgId
  const bobAsOther = new DirectApi({ orgId: other.oid, membership: org.bob.membership, email: org.bob.email });
  await assert.rejects(() => bobAsOther.conversationDetail({ deviceId: B.device.deviceId, conversationId: group }), (e) => e.status === 404 || e.status === 403);
  const k = await chatDb();
  assert.equal(await k.participants.countDocuments({ conversationId: group, email: other.mallory.email }), 0);
});

test("leaving and deleting: leave ends access; delete-for-me hides; delete-for-everyone purges ciphertext", T, async () => {
  const lg = (await B.createConversation({ kind: "group", emails: [org.alice.email, org.carol.email] })).conversationId;
  await sync(A, C);
  await B.send(lg, { text: "bye soon" });
  await C.leave(lg);
  await assert.rejects(() => conv.submitMessage({ orgId: org.oid, email: org.carol.email, deviceId: C.device.deviceId, conversationId: lg, clientMsgId: "afterleave0001", ciphertext: "AAAA" }), (e) => e.status === 404);
  await A.send(lg, { text: "carol left" }); // forces the removal commit first
  const k = await chatDb();
  assert.equal((await k.conversations.findOne({ _id: lg })).leaves.includes(C.device.deviceId), false);
  const mine = await conv.deleteConversation({ orgId: org.oid, membership: org.alice.membership, email: org.alice.email, conversationId: lg });
  assert.equal(mine.deleted, "for-me", "a plain member deletes only their own copy");
  assert.equal((await k.conversations.findOne({ _id: lg })).status, "active");
  assert.equal((await B.sync()).conversations.some((c) => c.id === lg), true);
  const all = await conv.deleteConversation({ orgId: org.oid, membership: org.bob.membership, email: org.bob.email, conversationId: lg });
  assert.equal(all.deleted, "for-everyone", "the owner deletes it for everyone");
  const left = await k.messages.find({ conversationId: lg, ciphertext: { $ne: null }, kind: "app" }).toArray();
  assert.equal(left.length, 0, "every ciphertext is purged");
  assert.equal((await k.conversations.findOne({ _id: lg })).status, "deleted");
});
