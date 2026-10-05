// test/desktop-chat.test.mjs -- the server and client-library parts of the desktop Secure Chat work (Competitive Expansion SOW A9, section 40): the organization sign-out policy,
// desktop devices (platform and label), erasing a device's readable history without breaking it, and revoking a device. Real MongoDB. The window-level parts (single owner window,
// pop-out, offline indicator, sign-out hook) are exercised in a real browser; the native alert text is covered by `cargo test chat_alert_tests` in inaya-desktop.
// Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=300000 test/desktop-chat.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, makeChatOrg, client } from "./_chat-fixtures.mjs";
import { getOrgCollections } from "../src/lib/orgs.js";
import { setOrgFeature } from "../src/lib/featureFlags.js";
import * as conv from "../src/lib/chat/conversations.js";
import * as devices from "../src/lib/chat/devices.js";

const T = { timeout: 300000 };
const code = (p) => p.then(() => null, (e) => e);
let org, A, B, group;
before(async () => { await setup(); org = await makeChatOrg("dsk", { people: ["alice", "bob"] }); await setOrgFeature({ orgId: org.oid, name: "FEATURE_SECURE_CHAT", enabled: true }); });
after(async () => { await teardown(); });

test("sign-out policy: defaults to keep, owner can set clear or revoke, a member cannot, an unknown value is refused, and refused changes leave it alone", T, async () => {
  assert.equal((await conv.getChatSettings(org.oid)).signOutPolicy, "keep");
  const set = (who, v) => conv.setChatSettings({ orgId: org.oid, membership: who.membership, actorEmail: who.email, patch: { signOutPolicy: v } });
  assert.equal((await set(org.owner, "clear")).signOutPolicy, "clear"); assert.equal((await conv.getChatSettings(org.oid)).signOutPolicy, "clear"); assert.equal((await set(org.owner, "revoke")).signOutPolicy, "revoke");
  assert.equal((await code(set(org.alice, "keep"))).status, 403, "a member cannot change it"); assert.equal((await code(set(org.owner, "wipe-everything"))).status, 400); assert.equal((await code(set(org.owner, 5))).status, 400);
  assert.equal((await conv.getChatSettings(org.oid)).signOutPolicy, "revoke", "refused changes leave it alone");
  assert.equal((await set(org.owner, "keep")).signOutPolicy, "keep");
  assert.equal((await conv.getChatSettings(org.oid)).allowEditing, true, "other settings are unaffected");
});

test("a desktop device is enrolled with its platform and label and is listed as such; an unknown platform is stored as 'other'", T, async () => {
  const mk = (platform, label) => devices.enrollDevice({ orgId: org.oid, email: org.alice.email, label, platform });
  const win = await mk("windows", "Desktop app"); const odd = await mk("playstation", "Console");
  const list = await devices.listDevices({ orgId: org.oid, membership: org.alice.membership, email: org.alice.email, scope: "mine" });
  const w = list.find((d) => d.deviceId === (win.device?.deviceId || win.deviceId)); assert.ok(w, "listed"); assert.equal(w.platform, "windows"); assert.equal(w.label, "Desktop app");
  const o = list.find((d) => d.deviceId === (odd.device?.deviceId || odd.deviceId)); assert.equal(o.platform, "other");
});

test("erasing a device's readable history keeps it a working member: history is gone, new messages still flow both ways", T, async () => {
  A = await client(org, org.alice, { label: "Desktop app" }); B = await client(org, org.bob, { label: "Bob" });
  group = (await A.createConversation({ kind: "group", emails: [org.bob.email] })).conversationId; await B.sync();
  await A.send(group, { text: "before erase one" }); await A.send(group, { text: "before erase two" }); await B.sync();
  assert.equal((await B.messages(group)).length, 2); assert.ok((await B.store.keys("msgs:")).length > 0);
  const r = await B.clearCache(); assert.ok(r.erased >= 1); assert.equal((await B.store.keys("msgs:")).length, 0, "the stored history is erased");
  assert.equal((await B.messages(group)).length, 0, "nothing readable is left on the device");
  assert.ok(await B.store.get("device"), "the device identity is kept"); assert.ok((await B.store.keys("g:")).length > 0, "the group state is kept");
  await A.send(group, { text: "after erase" }); await B.sync(); const got = await B.messages(group); assert.deepEqual(got.map((m) => m.text), ["after erase"], "only the new message appears, and it decrypts");
  await B.send(group, { text: "bob can still talk" }); await A.sync(); assert.ok((await A.messages(group)).some((m) => m.text === "bob can still talk"));
});

test("revoking a device (the 'revoke' policy and the manual button): the server refuses it afterwards, and wiping removes every secret and cache", T, async () => {
  const deviceId = B.device.deviceId; await devices.revokeDevice({ orgId: org.oid, membership: org.bob.membership, actorEmail: org.bob.email, deviceId });
  const err = await code(B.sync()); assert.ok(err && (err.code === "DEVICE_REVOKED" || err.status === 403), "the revoked device is refused");
  await B.wipeLocal(); assert.equal((await B.store.keys("")).length, 0, "nothing is left in the store"); assert.equal(B.device, null);
  const { db } = await getOrgCollections(); assert.equal((await db.collection("chat_devices").findOne({ deviceId })).status, "revoked");
  await A.send(group, { text: "a message after bob's device was revoked" }); // the group keeps working; the revoked device is removed on the next reconcile
});

test("CHAT-010 local drafts: kept per conversation on the device only, empty text removes the draft, and erasing history or forgetting the conversation removes it too", T, async () => {
  const C = await client(org, org.alice, { label: "Draft device" }); const g = (await C.createConversation({ kind: "group", emails: [org.bob.email] })).conversationId;
  assert.equal(await C.getDraft(g), ""); await C.setDraft(g, "half-written thought"); assert.equal(await C.getDraft(g), "half-written thought");
  const { db } = await getOrgCollections(); assert.equal(JSON.stringify(await db.collection("chat_messages").find({ conversationId: g }).toArray()).includes("half-written"), false, "a draft is never sent to the server");
  await C.setDraft(g, "   "); assert.equal(await C.getDraft(g), "", "blank text removes the draft");
  await C.setDraft(g, "again"); await C.clearCache(); assert.equal(await C.getDraft(g), "", "erasing history erases drafts");
  await C.setDraft(g, "once more"); await C.forget(g); assert.equal(await C.getDraft(g), "", "forgetting the conversation erases its draft");
});

test("CHAT-016 notifications through the router: the in-app alert is generic, e-mail is off until the person opts in, and when on it carries no sender, title or text", T, async () => {
  const { db } = await getOrgCollections(); const R = await import("../src/lib/notify/router.js");
  const o2 = await makeChatOrg("ntf", { people: ["alice", "bob"] }); await setOrgFeature({ orgId: o2.oid, name: "FEATURE_SECURE_CHAT", enabled: true });
  const A2 = await client(o2, o2.alice, { label: "A" }); const B2 = await client(o2, o2.bob, { label: "B" });
  const g = (await A2.createConversation({ kind: "group", emails: [o2.bob.email] })).conversationId; await B2.sync();
  await db.collection("notifications").deleteMany({ orgId: o2.orgId }); await A2.send(g, { text: "TOP-SECRET-PLAN" });
  const inApp = await db.collection("notifications").find({ orgId: o2.orgId, targetEmail: o2.bob.email }).toArray(); assert.equal(inApp.length >= 1, true, "the in-app alert is raised");
  assert.equal(JSON.stringify(inApp).includes("TOP-SECRET-PLAN"), false); const prefs = await R.getPrefs({ orgId: o2.oid, email: o2.bob.email }); assert.ok(prefs.catalog.some((e) => e.key === "chat.message"), "chat.message is a channel-configurable event");
  const sent = []; const sender = async (m) => { sent.push(m); return { ok: true }; };
  await R.notifyEvent({ orgId: o2.oid, event: "chat.message", targetEmail: o2.bob.email, title: "ignored detail", body: "ignored detail", dedupeKey: "t-off", protectedContent: true, sender }); assert.equal(sent.length, 0, "e-mail is opt-in: nothing is sent by default");
  await R.setPrefs({ orgId: o2.oid, email: o2.bob.email, changes: { "chat.message": { email: true } } });
  await R.notifyEvent({ orgId: o2.oid, event: "chat.message", targetEmail: o2.bob.email, title: "Alice says TOP-SECRET-PLAN", body: "TOP-SECRET-PLAN", dedupeKey: "t-on", protectedContent: true, sender }); assert.equal(sent.length, 1, "once opted in, one e-mail is sent");
  assert.equal(JSON.stringify(sent[0]).includes("TOP-SECRET-PLAN") || JSON.stringify(sent[0]).includes("Alice"), false, "the e-mail carries no sender, title or text");
});

test("CHAT-015 embed control: the author can turn previews of their own message off and on for everyone; another member cannot; it changes no content and ignores the edit policy", T, async () => {
  const o3 = await makeChatOrg("emb", { people: ["alice", "bob"] }); await setOrgFeature({ orgId: o3.oid, name: "FEATURE_SECURE_CHAT", enabled: true });
  const A3 = await client(o3, o3.alice, { label: "A" }); const B3 = await client(o3, o3.bob, { label: "B" });
  const g = (await A3.createConversation({ kind: "group", emails: [o3.bob.email] })).conversationId; await B3.sync();
  const sent = await A3.send(g, { text: "see picture" }); await B3.sync();
  await A3.setEmbed(g, sent.serverId, true); await B3.sync(); const bobView = (await B3.messages(g)).find((m) => m.serverId === sent.serverId); assert.equal(bobView.embedDisabled, true, "everyone sees the author's choice");
  assert.equal(bobView.text, "see picture", "the content is untouched");
  const forged = await code(B3.setEmbed(g, sent.serverId, false)); assert.ok(forged && forged.status === 403, "another member cannot change it"); await A3.sync(); assert.equal((await A3.messages(g)).find((m) => m.serverId === sent.serverId).embedDisabled, true);
  await conv.setChatSettings({ orgId: o3.oid, membership: o3.owner.membership, actorEmail: o3.owner.email, patch: { allowEditing: false } }); await A3.setEmbed(g, sent.serverId, false); await B3.sync(); assert.equal((await B3.messages(g)).find((m) => m.serverId === sent.serverId).embedDisabled, false, "turning previews back on works even when editing is disabled by policy");
});

test("CHAT-004 external guest, end to end: blocked while the policy is off, needs a stated purpose and acceptance, then messages flow both ways between two organizations", T, async () => {
  const contacts = await import("../src/lib/chat/contacts.js");
  const host = await makeChatOrg("exth", { people: ["alice"] }); const guest = await makeChatOrg("extg", { people: ["zed"] });
  for (const o of [host, guest]) await setOrgFeature({ orgId: o.oid, name: "FEATURE_SECURE_CHAT", enabled: true });
  const ask = (purpose) => contacts.requestContact({ orgId: host.oid, email: host.alice.email, toEmail: guest.zed.email, purpose });
  assert.equal((await code(ask("Project review"))).code, "EXTERNAL_DISABLED", "off by default");
  await conv.setChatSettings({ orgId: host.oid, membership: host.owner.membership, actorEmail: host.owner.email, patch: { allowExternal: true } });
  assert.equal((await code(ask(""))).code, "PURPOSE_REQUIRED", "a purpose is mandatory");
  const sent = await ask("Review the Q3 plan together"); assert.equal(sent.status, "sent");
  const accepted = await contacts.acceptRequest({ email: guest.zed.email, requestId: sent.requestId }); assert.ok(accepted);
  const Al = await client(host, host.alice, { label: "Alice" }); const Zed = await client(guest, guest.zed, { label: "Zed" });
  const g = (await Al.createConversation({ kind: "group", emails: [guest.zed.email], external: true })).conversationId;
  await Zed.sync(); await Al.sync(); await Zed.sync();
  await Al.send(g, { text: "welcome zed" }); await Zed.sync(); const seen = (await Zed.messages(g)).map((m) => m.text);
  assert.ok(seen.includes("welcome zed"), "the guest, in another organization, reads messages sent after joining");
  await Zed.send(g, { text: "thanks alice" }); await Al.sync(); assert.ok((await Al.messages(g)).some((m) => m.text === "thanks alice"), "and the host reads the guest's reply");
  assert.equal((await code(conv.listMessages({ orgId: host.oid, email: guest.zed.email, deviceId: Zed.device.deviceId, conversationId: "0123456789abcdef01234567" }))).status, 404);
});
