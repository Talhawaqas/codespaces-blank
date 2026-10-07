// test/pqc-device-keys.test.mjs -- PQC device key registry (Internxt-inspired SOW, Workstream A, PQC-A03/A04).
// Real database. Device identity is reused from the existing org_devices registry -- a PQC key must reference
// an already-checked-in device, same as the ADR/reuse-matrix say.
// Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=300000 test/pqc-device-keys.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setup, teardown, makeChatOrg, c as cols } from "./_chat-fixtures.mjs";
import { getOrgCollections } from "../src/lib/orgs.js";
import { setOrgFeature } from "../src/lib/featureFlags.js";
import { hasAdminRole } from "../src/lib/orgGates.js";
import * as D from "../src/lib/devices/devices.js";
import * as K from "../src/lib/pqc/deviceKeys.js";

const T = { timeout: 300000 };
let org, db, owner, alice, bob;
const code = (p) => p.then(() => null, (e) => e);
const did = () => randomBytes(12).toString("hex");
const fakePublicKey = () => randomBytes(1216).toString("base64"); // real ML-KEM-768 hybrid public key length

async function checkedInDevice(email) {
  const id = did();
  await D.heartbeat({ orgId: org.oid, email, ip: "203.0.113.1", report: { deviceId: id, platform: "web" } });
  return id;
}

before(async () => {
  await setup();
  db = (await getOrgCollections()).db;
  org = await makeChatOrg("pqck", { people: ["alice", "bob"] });
  owner = org.owner; alice = org.alice; bob = org.bob;
  await setOrgFeature({ orgId: org.oid, name: "FEATURE_PQC", enabled: true });
  await setOrgFeature({ orgId: org.oid, name: "FEATURE_DEVICE_CONTROL", enabled: true });
});
after(async () => {
  for (const n of ["pqc_device_keys", "org_devices", "org_activity"]) await db.collection(n).deleteMany({ orgId: org.orgId }).catch(() => {});
  await teardown();
});

test("registerDeviceKey: succeeds for the device's own owner, after the device has checked in", T, async () => {
  const deviceId = await checkedInDevice(alice.email);
  const pub = fakePublicKey();
  const k = await K.registerDeviceKey({ orgId: org.oid, email: alice.email, deviceId, publicKey: pub });
  assert.equal(k.deviceId, deviceId);
  assert.equal(k.email, alice.email);
  assert.equal(k.status, "active");
  assert.equal(k.algorithm, "HYBRID-MLKEM768-X25519-HKDF-SHA256");
  assert.ok(k.keyId);
  assert.equal(k.publicKey, pub);
});

test("registerDeviceKey: rejects a device that has never checked in", T, async () => {
  const err = await code(K.registerDeviceKey({ orgId: org.oid, email: alice.email, deviceId: did(), publicKey: fakePublicKey() }));
  assert.equal(err.status, 404);
});

test("registerDeviceKey: rejects registering a key for someone ELSE's device", T, async () => {
  const deviceId = await checkedInDevice(bob.email);
  const err = await code(K.registerDeviceKey({ orgId: org.oid, email: alice.email, deviceId, publicKey: fakePublicKey() }));
  assert.equal(err.status, 403);
});

test("registerDeviceKey: rejects a blocked device", T, async () => {
  const deviceId = await checkedInDevice(bob.email);
  await D.deviceAction({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, deviceId, action: "block" });
  const err = await code(K.registerDeviceKey({ orgId: org.oid, email: bob.email, deviceId, publicKey: fakePublicKey() }));
  assert.equal(err.code, "DEVICE_BLOCKED");
});

test("registerDeviceKey: rejects malformed input (deviceId, algorithm, publicKey) rather than guessing", T, async () => {
  const deviceId = await checkedInDevice(alice.email);
  assert.equal((await code(K.registerDeviceKey({ orgId: org.oid, email: alice.email, deviceId: "short", publicKey: fakePublicKey() }))).status, 400);
  assert.equal((await code(K.registerDeviceKey({ orgId: org.oid, email: alice.email, deviceId, algorithm: "SOMETHING-ELSE", publicKey: fakePublicKey() }))).status, 400);
  assert.equal((await code(K.registerDeviceKey({ orgId: org.oid, email: alice.email, deviceId, publicKey: "not base64!!" }))).status, 400);
  assert.equal((await code(K.registerDeviceKey({ orgId: org.oid, email: alice.email, deviceId, publicKey: "" }))).status, 400);
});

test("listDeviceKeys: a member sees only their own keys by default; deviceAdmin can see the whole org", T, async () => {
  const d1 = await checkedInDevice(alice.email); await K.registerDeviceKey({ orgId: org.oid, email: alice.email, deviceId: d1, publicKey: fakePublicKey() });
  const d2 = await checkedInDevice(bob.email); await K.registerDeviceKey({ orgId: org.oid, email: bob.email, deviceId: d2, publicKey: fakePublicKey() });

  const aliceOwn = await K.listDeviceKeys({ orgId: org.oid, membership: alice.membership, email: alice.email, hasAdminRole });
  assert.equal(aliceOwn.scope, "mine");
  assert.ok(aliceOwn.keys.every((k) => k.email === alice.email));

  const aliceTryOrg = await K.listDeviceKeys({ orgId: org.oid, membership: alice.membership, email: alice.email, scope: "org", hasAdminRole });
  assert.equal(aliceTryOrg.scope, "mine", "a non-admin asking for org scope is silently narrowed to mine, not rejected -- matches devices.js's own listDevices behavior");

  const ownerOrg = await K.listDeviceKeys({ orgId: org.oid, membership: owner.membership, email: owner.email, scope: "org", hasAdminRole });
  assert.equal(ownerOrg.scope, "org");
  assert.ok(ownerOrg.keys.some((k) => k.email === alice.email) && ownerOrg.keys.some((k) => k.email === bob.email));
});

test("activeKeyForDevice: resolves the active key a sender would wrap a content key to; null for a device with none", T, async () => {
  const deviceId = await checkedInDevice(alice.email);
  assert.equal(await K.activeKeyForDevice({ orgId: org.oid, deviceId }), null);
  const pub = fakePublicKey();
  await K.registerDeviceKey({ orgId: org.oid, email: alice.email, deviceId, publicKey: pub });
  const active = await K.activeKeyForDevice({ orgId: org.oid, deviceId });
  assert.equal(active.publicKey, pub);
  assert.equal(active.status, "active");
});

test("revokeDeviceKey: the owner can revoke their own key; a stranger cannot", T, async () => {
  const deviceId = await checkedInDevice(alice.email);
  const k = await K.registerDeviceKey({ orgId: org.oid, email: alice.email, deviceId, publicKey: fakePublicKey() });

  const err = await code(K.revokeDeviceKey({ orgId: org.oid, membership: bob.membership, actorEmail: bob.email, deviceId, keyId: k.keyId, hasAdminRole }));
  assert.equal(err.status, 403);

  const revoked = await K.revokeDeviceKey({ orgId: org.oid, membership: alice.membership, actorEmail: alice.email, deviceId, keyId: k.keyId, reason: "rotating", hasAdminRole });
  assert.equal(revoked.status, "revoked");
  assert.ok(revoked.revokedAt);
  assert.equal(await K.activeKeyForDevice({ orgId: org.oid, deviceId }), null, "a revoked key is never returned as the active key");
});

test("revokeDeviceKey: an admin can revoke someone else's key (device offboarding)", T, async () => {
  const deviceId = await checkedInDevice(bob.email);
  const k = await K.registerDeviceKey({ orgId: org.oid, email: bob.email, deviceId, publicKey: fakePublicKey() });
  const revoked = await K.revokeDeviceKey({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, deviceId, keyId: k.keyId, reason: "offboarding", hasAdminRole });
  assert.equal(revoked.status, "revoked");
});

test("revokeDeviceKey: revoking an already-revoked key is idempotent, not an error", T, async () => {
  const deviceId = await checkedInDevice(alice.email);
  const k = await K.registerDeviceKey({ orgId: org.oid, email: alice.email, deviceId, publicKey: fakePublicKey() });
  await K.revokeDeviceKey({ orgId: org.oid, membership: alice.membership, actorEmail: alice.email, deviceId, keyId: k.keyId, hasAdminRole });
  const second = await K.revokeDeviceKey({ orgId: org.oid, membership: alice.membership, actorEmail: alice.email, deviceId, keyId: k.keyId, hasAdminRole });
  assert.equal(second.status, "revoked");
});

test("revokeAllKeysForDevice: revokes every active key for a device in one call, used alongside a device-level revoke", T, async () => {
  const deviceId = await checkedInDevice(bob.email);
  await K.registerDeviceKey({ orgId: org.oid, email: bob.email, deviceId, publicKey: fakePublicKey() });
  const result = await K.revokeAllKeysForDevice({ orgId: org.oid, deviceId, actorEmail: owner.email, reason: "device revoked" });
  assert.equal(result.revokedCount, 1);
  assert.equal(await K.activeKeyForDevice({ orgId: org.oid, deviceId }), null);
  // idempotent -- a second call finds nothing active left to revoke
  assert.equal((await K.revokeAllKeysForDevice({ orgId: org.oid, deviceId, actorEmail: owner.email })).revokedCount, 0);
});

test("cross-org isolation: a device key never resolves for a different organization's orgId", T, async () => {
  const org2 = await makeChatOrg("pqck2", { people: [] });
  await setOrgFeature({ orgId: org2.oid, name: "FEATURE_PQC", enabled: true });
  await setOrgFeature({ orgId: org2.oid, name: "FEATURE_DEVICE_CONTROL", enabled: true });
  try {
    const deviceId = await checkedInDevice(alice.email);
    await K.registerDeviceKey({ orgId: org.oid, email: alice.email, deviceId, publicKey: fakePublicKey() });
    assert.equal(await K.activeKeyForDevice({ orgId: org2.oid, deviceId }), null, "the same deviceId string under a different orgId resolves to nothing");
  } finally {
    await db.collection("pqc_device_keys").deleteMany({ orgId: org2.orgId }).catch(() => {});
    await db.collection("org_devices").deleteMany({ orgId: org2.orgId }).catch(() => {});
  }
});

test("audit trail: registering and revoking a PQC key writes to the org activity log", T, async () => {
  const deviceId = await checkedInDevice(alice.email);
  const k = await K.registerDeviceKey({ orgId: org.oid, email: alice.email, deviceId, publicKey: fakePublicKey() });
  await K.revokeDeviceKey({ orgId: org.oid, membership: alice.membership, actorEmail: alice.email, deviceId, keyId: k.keyId, hasAdminRole });
  const entries = await db.collection("org_activity").find({ orgId: org.orgId, recordType: "PQC_DEVICE_KEY", "metadata.keyId": k.keyId }).toArray();
  const actions = entries.map((e) => e.action).sort();
  assert.deepEqual(actions, ["PQC_KEY_REGISTERED", "PQC_KEY_REVOKED"]);
});
