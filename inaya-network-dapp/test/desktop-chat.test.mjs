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
