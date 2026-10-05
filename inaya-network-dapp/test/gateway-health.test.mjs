// test/gateway-health.test.mjs -- an offline gateway alerts administrators once a day; a gateway that never connected, or reported recently, does not.
// Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=300000 test/gateway-health.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { setup, teardown, makeChatOrg, c as cols } from "./_chat-fixtures.mjs";
import { getOrgCollections } from "../src/lib/orgs.js";
import * as G from "../src/lib/gateway/gateway.js";
import { alertOfflineGateways } from "../src/lib/gateway/health.js";

const T = { timeout: 300000 };
let org, db, gid;
before(async () => {
  await setup(); db = (await getOrgCollections()).db; org = await makeChatOrg("gwh", { people: [] });
  const gw = { _id: new ObjectId(), orgId: org.orgId, label: "Branch office", mode: "customer_gateway", status: "active", publicKey: "x", publicKeyFingerprint: "fp-" + new ObjectId().toHexString(), registeredAt: new Date().toISOString(), lastSeenAt: null, version: "0.1.0", platform: "t", capabilities: [], health: null, configVersion: 0, commands: [], revokedAt: null };
  await db.collection("gateways").insertOne(gw); gid = gw._id;
});
after(async () => { await db.collection("gateways").deleteMany({ orgId: org.orgId }); await db.collection("notifications").deleteMany({ orgId: org.orgId }); await teardown(); });

test("never connected: not offline, no alert; recently seen: no alert; quiet for 45 minutes: administrators are told once per day", T, async () => {
  const count = () => db.collection("notifications").countDocuments({ orgId: org.orgId, type: "gateway.offline" });
  assert.equal(G.statusOf((await db.collection("gateways").findOne({ _id: gid }))), "NEVER_CONNECTED"); await alertOfflineGateways(); assert.equal(await count(), 0, "a gateway that never connected is not 'offline'");
  await db.collection("gateways").updateOne({ _id: gid }, { $set: { lastSeenAt: new Date().toISOString() } }); await alertOfflineGateways(); assert.equal(await count(), 0, "recently seen");
  await db.collection("gateways").updateOne({ _id: gid }, { $set: { lastSeenAt: new Date(Date.now() - 45 * 60_000).toISOString() } }); const r = await alertOfflineGateways(); assert.ok(r.alerted >= 1); const n1 = await count(); assert.ok(n1 >= 1);
  const note = await db.collection("notifications").findOne({ orgId: org.orgId, type: "gateway.offline" }); assert.match(note.title, /Branch office/);
  await alertOfflineGateways(); assert.equal(await count(), n1, "not repeated the same day");
  await db.collection("gateways").updateOne({ _id: gid }, { $set: { status: "revoked", revokedAt: new Date().toISOString() } }); const before = await count(); await alertOfflineGateways(); assert.equal(await count(), before, "a revoked gateway is not alerted about");
});
