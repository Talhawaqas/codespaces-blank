// test/keys.test.mjs -- customer-managed keys (KEY-001): local and KMS providers (KMS against a stand-in that implements the AWS JSON protocol and checks EncryptionContext), envelope
// re-wrapping of the S3-layer data key, tenant and environment binding, rotation, disable, failure telemetry, owner-only changes, no secrets in the audit.
// Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=300000 test/keys.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { setup, teardown, makeChatOrg, c as cols } from "./_chat-fixtures.mjs";
import { getOrgCollections } from "../src/lib/orgs.js";
import { ensureOwnerS3Passphrase, getOwnerS3Passphrase } from "../src/lib/s3-compat/credentials.js";
import { unwrapPassphrase } from "../src/lib/s3-compat/crypto.js";
import * as KS from "../src/lib/keys/service.js";
import { local, contextFor, KeyError } from "../src/lib/keys/providers.js";

const T = { timeout: 300000 };
const code = (p) => p.then(() => null, (e) => e);
let org, other, owner, admin, db, srv, ep, calls = 0; const stubKeys = new Map([["alias/customer-a", { key: randomBytes(32), state: "Enabled" }], ["alias/customer-b", { key: randomBytes(32), state: "Enabled" }], ["alias/denied", { key: randomBytes(32), state: "Enabled", deny: true }]]);

/** A stand-in for AWS KMS (the network boundary): Encrypt and Decrypt over the AWS JSON 1.1 protocol; the EncryptionContext is authenticated, as in the real service. */
function startKms() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => {
        calls++; const target = req.headers["x-amz-target"] || ""; const b = JSON.parse(d || "{}"); const send = (status, o, type) => { res.writeHead(status, { "content-type": "application/x-amz-json-1.1", ...(type ? { "x-amzn-errortype": type } : {}) }); res.end(JSON.stringify(o)); };
        const k = stubKeys.get(b.KeyId); if (!k) return send(400, { __type: "NotFoundException", message: "no such key" }, "NotFoundException"); if (k.deny) return send(400, { __type: "AccessDeniedException", message: "no" }, "AccessDeniedException"); if (k.state !== "Enabled") return send(400, { __type: "DisabledException", message: "disabled" }, "DisabledException");
        const aad = Buffer.from(JSON.stringify([b.KeyId, Object.entries(b.EncryptionContext || {}).sort()]));
        if (target.endsWith("Encrypt")) { const iv = randomBytes(12); const c = createCipheriv("aes-256-gcm", k.key, iv); c.setAAD(aad); const ct = Buffer.concat([c.update(Buffer.from(b.Plaintext, "base64")), c.final()]); return send(200, { CiphertextBlob: Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64"), KeyId: b.KeyId, EncryptionAlgorithm: "SYMMETRIC_DEFAULT" }); }
        if (target.endsWith("Decrypt")) { const raw = Buffer.from(b.CiphertextBlob, "base64"); try { const dc = createDecipheriv("aes-256-gcm", k.key, raw.subarray(0, 12)); dc.setAAD(aad); dc.setAuthTag(raw.subarray(12, 28)); const pt = Buffer.concat([dc.update(raw.subarray(28)), dc.final()]); return send(200, { Plaintext: pt.toString("base64"), KeyId: b.KeyId, EncryptionAlgorithm: "SYMMETRIC_DEFAULT" }); } catch { return send(400, { __type: "InvalidCiphertextException", message: "bad" }, "InvalidCiphertextException"); } }
        send(400, { __type: "UnknownOperationException" }, "UnknownOperationException");
      });
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}
const base = (who = owner) => ({ orgId: org.oid, membership: who.membership, actorEmail: who.email });

before(async () => {
  await setup(); db = (await getOrgCollections()).db; srv = await startKms(); ep = `http://127.0.0.1:${srv.address().port}`; process.env.CMK_ALLOW_INSECURE_ENDPOINT = "1"; process.env.CMK_CACHE_SECONDS = "0";
  process.env.CMK_LOCAL_KEYS = JSON.stringify({ "cust-2026": randomBytes(32).toString("base64"), "cust-2027": randomBytes(32).toString("base64") }); if (!process.env.S3_COMPAT_ENCRYPTION_KEY) process.env.S3_COMPAT_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  org = await makeChatOrg("keys", { people: ["admin"] }); other = await makeChatOrg("keys2", { people: [] }); owner = org.owner; admin = org.admin; await cols.orgMembers.updateOne({ orgId: org.orgId, email: admin.email }, { $set: { role: "admin" } }); admin = { ...admin, membership: await cols.orgMembers.findOne({ orgId: org.orgId, email: admin.email }) };
});
after(async () => { srv.close(); for (const n of ["org_key_config", "org_key_audit", "s3_owner_keys"]) await db.collection(n).deleteMany({ $or: [{ orgId: { $in: [org.orgId, other.orgId] } }, { ownerId: { $in: [org.oid, other.oid] } }] }).catch(() => {}); await teardown(); });

test("default is unchanged: platform-managed, wrapped with the platform key, nothing recorded as customer-managed", T, async () => {
  await ensureOwnerS3Passphrase({ type: "org", orgId: org.oid }); const doc = await db.collection("s3_owner_keys").findOne({ ownerType: "org", ownerId: org.oid }); assert.ok(doc.wrappedPassphrase && !doc.keyEnvelope);
  const pass = await getOwnerS3Passphrase({ type: "org", orgId: org.oid }); assert.equal(pass, unwrapPassphrase(doc.wrappedPassphrase)); globalThis.__pass = pass;
  const st = await KS.status({ orgId: org.oid, membership: owner.membership }); assert.equal(st.config.provider, "platform"); assert.equal(st.dataKey.protectedBy, "platform"); assert.match(st.warning, /permanently unreadable/);
});

test("only the owner changes key management; a customer key needs an explicit acknowledgement; bad providers, key references and endpoints are refused before anything changes", T, async () => {
  const cfg = (o) => KS.configure({ ...base(), provider: "local", keyRef: "cust-2026", acknowledgeDestruction: true, ...o });
  assert.equal((await code(KS.configure({ ...base(admin), provider: "local", keyRef: "cust-2026", acknowledgeDestruction: true })))?.status, 403, "an admin is not the owner");
  assert.equal((await code(cfg({ acknowledgeDestruction: false })))?.code, "ACK_REQUIRED"); assert.equal((await code(cfg({ provider: "vault" })))?.code, "UNKNOWN_PROVIDER"); assert.equal((await code(cfg({ keyRef: "" })))?.code, "BAD_KEY_REF");
  assert.equal((await code(cfg({ provider: "kms", keyRef: "alias/customer-a", endpoint: "http://evil.example" })))?.code, "BAD_ENDPOINT", "plain http is refused except the local test stand-in");
  assert.equal((await code(cfg({ keyRef: "not-in-this-deployment" })))?.code, "PROBE_FAILED", "a key that cannot be used is caught by the probe"); assert.equal((await code(cfg({ provider: "kms", keyRef: "alias/missing", endpoint: ep })))?.code, "PROBE_FAILED");
  const doc = await db.collection("s3_owner_keys").findOne({ ownerType: "org", ownerId: org.oid }); assert.ok(doc.wrappedPassphrase && !doc.keyEnvelope, "nothing changed"); assert.equal((await getOwnerS3Passphrase({ type: "org", orgId: org.oid })), globalThis.__pass);
  assert.equal((await KS.status({ orgId: org.oid, membership: owner.membership })).config.provider, "platform");
  assert.equal((await code(KS.status({ orgId: org.oid, membership: (await cols.orgMembers.findOne({ orgId: org.orgId, email: org.alice?.email || "none" })) || { role: "member" } })))?.status, 403, "a plain member cannot read it");
});

test("local provider: the data key is re-wrapped under the customer's key and the platform copy is removed; the same passphrase still works; the platform alone can no longer open it", T, async () => {
  await KS.configure({ ...base(), provider: "local", keyRef: "cust-2026", acknowledgeDestruction: true });
  const doc = await db.collection("s3_owner_keys").findOne({ ownerType: "org", ownerId: org.oid }); assert.ok(doc.keyEnvelope && !doc.wrappedPassphrase, "platform-wrapped copy removed"); assert.equal(doc.keyEnvelope.provider, "local"); assert.equal(doc.keyEnvelope.keyRef, "cust-2026"); assert.equal(JSON.stringify(doc).includes(globalThis.__pass), false);
  assert.equal(await getOwnerS3Passphrase({ type: "org", orgId: org.oid }), globalThis.__pass, "existing objects stay readable: the data key did not change");
  assert.throws(() => unwrapPassphrase(doc.keyEnvelope.ciphertext), "the platform key cannot open the customer-wrapped blob");
  const st = await KS.status({ orgId: org.oid, membership: owner.membership }); assert.equal(st.dataKey.protectedBy, "local"); assert.equal(st.config.version, 1); assert.equal(st.config.state, "active");
});

test("tenant and environment binding: a wrapped key cannot be unwrapped for another organization, purpose or environment", T, async () => {
  const doc = await db.collection("s3_owner_keys").findOne({ ownerType: "org", ownerId: org.oid }); const env = doc.keyEnvelope;
  assert.equal((await code(local.unwrap({ envelope: env, context: contextFor({ orgId: other.oid, purpose: KS.PURPOSE, env: env.environment }) })))?.code, "UNWRAP_FAILED", "another organization");
  assert.equal((await code(local.unwrap({ envelope: env, context: contextFor({ orgId: org.oid, purpose: "something-else", env: env.environment }) })))?.code, "UNWRAP_FAILED", "another purpose");
  assert.equal((await code(local.unwrap({ envelope: env, context: contextFor({ orgId: org.oid, purpose: KS.PURPOSE, env: "staging-elsewhere" }) })))?.code, "UNWRAP_FAILED", "another environment");
  const prev = process.env.INAYA_ENV; process.env.INAYA_ENV = "some-other-environment"; try { assert.equal((await code(getOwnerS3Passphrase({ type: "org", orgId: org.oid })))?.code, "ENV_MISMATCH", "this deployment is a different environment"); } finally { if (prev === undefined) delete process.env.INAYA_ENV; else process.env.INAYA_ENV = prev; }
  const tampered = { ...env, ciphertext: Buffer.concat([Buffer.from(env.ciphertext, "base64").subarray(0, 40), randomBytes(8)]).toString("base64") }; assert.ok(await code(local.unwrap({ envelope: tampered, context: contextFor({ orgId: org.oid, purpose: KS.PURPOSE, env: env.environment }) })), "altered data is refused");
});

test("rotation: a new key version re-wraps the data key without re-encrypting files; the old version is retired and kept in history", T, async () => {
  await KS.rotate({ ...base(), keyRef: "cust-2027" }); const doc = await db.collection("s3_owner_keys").findOne({ ownerType: "org", ownerId: org.oid }); assert.equal(doc.keyEnvelope.keyRef, "cust-2027"); assert.equal(doc.keyEnvelope.keyVersion, 2);
  assert.equal(await getOwnerS3Passphrase({ type: "org", orgId: org.oid }), globalThis.__pass, "same data key, so no file needed re-encrypting");
  const st = await KS.status({ orgId: org.oid, membership: owner.membership }); assert.equal(st.config.version, 2); const h = st.config.history; assert.equal(h.find((x) => x.version === 1).state, "retired"); assert.equal(h.find((x) => x.version === 2).state, "active"); assert.ok(h.find((x) => x.version === 1).to);
  assert.equal((await code(KS.rotate({ ...base(), keyRef: "not-present" })))?.code, "PROBE_FAILED", "a rotation to an unusable key changes nothing"); assert.equal((await db.collection("s3_owner_keys").findOne({ ownerType: "org", ownerId: org.oid })).keyEnvelope.keyRef, "cust-2027");
});

test("AWS KMS provider: probe, re-wrap, EncryptionContext binding, access-denied and disabled keys surface as clear codes, the cache is bounded", T, async () => {
  const cfg = (o) => KS.configure({ ...base(), provider: "kms", keyRef: "alias/customer-a", region: "eu-west-1", endpoint: ep, acknowledgeDestruction: true, ...o });
  assert.equal((await code(cfg({ keyRef: "alias/denied" })))?.code, "PROBE_FAILED"); const before = calls; await cfg({}); assert.ok(calls > before, "the real provider was called");
  const doc = await db.collection("s3_owner_keys").findOne({ ownerType: "org", ownerId: org.oid }); assert.equal(doc.keyEnvelope.provider, "kms"); assert.equal(doc.keyEnvelope.keyRef, "alias/customer-a"); assert.equal(await getOwnerS3Passphrase({ type: "org", orgId: org.oid }), globalThis.__pass);
  const stale = { ...doc.keyEnvelope, keyRef: "alias/customer-b" }; const { kms } = await import("../src/lib/keys/providers.js"); assert.equal((await code(kms.unwrap({ envelope: stale, context: contextFor({ orgId: org.oid, purpose: KS.PURPOSE, env: doc.keyEnvelope.environment }), options: { endpoint: ep } })))?.code, "UNWRAP_FAILED", "the wrong key cannot unwrap");
  assert.equal((await code(kms.unwrap({ envelope: doc.keyEnvelope, context: contextFor({ orgId: other.oid, purpose: KS.PURPOSE, env: doc.keyEnvelope.environment }), options: { endpoint: ep } })))?.code, "UNWRAP_FAILED", "KMS EncryptionContext binds the tenant");
  stubKeys.get("alias/customer-a").state = "Disabled"; assert.equal((await code(getOwnerS3Passphrase({ type: "org", orgId: org.oid })))?.code, "KEY_DISABLED", "the customer disabled their key"); stubKeys.get("alias/customer-a").deny = true; assert.equal((await code(getOwnerS3Passphrase({ type: "org", orgId: org.oid })))?.code, "ACCESS_DENIED", "the customer revoked the deployment's access"); stubKeys.get("alias/customer-a").deny = false; stubKeys.get("alias/customer-a").state = "Enabled";
  assert.equal(await getOwnerS3Passphrase({ type: "org", orgId: org.oid }), globalThis.__pass, "re-enabling the customer's key restores access: nothing was lost");
  process.env.CMK_CACHE_SECONDS = "60"; KS.clearCache(); const c0 = calls; await getOwnerS3Passphrase({ type: "org", orgId: org.oid }); const c1 = calls; await getOwnerS3Passphrase({ type: "org", orgId: org.oid }); assert.equal(calls, c1, "the second read is served from the short-lived cache"); assert.ok(c1 > c0); process.env.CMK_CACHE_SECONDS = "0"; KS.clearCache();
});

test("disable is an Inaya-side kill switch; failures are counted as telemetry; the audit holds no key material", T, async () => {
  await KS.setState({ ...base(), state: "disabled" }); assert.equal((await code(getOwnerS3Passphrase({ type: "org", orgId: org.oid })))?.code, "KEY_DISABLED"); assert.equal((await code(KS.setState({ ...base(admin), state: "active" })))?.status, 403);
  await KS.setState({ ...base(), state: "active" }); assert.equal(await getOwnerS3Passphrase({ type: "org", orgId: org.oid }), globalThis.__pass);
  const st = await KS.status({ orgId: org.oid, membership: owner.membership }); assert.ok(st.telemetry.failures >= 3, `failures counted (${st.telemetry.failures})`); assert.ok(st.telemetry.lastFailure.code); assert.ok(st.telemetry.operations > st.telemetry.failures);
  const rows = JSON.stringify(await db.collection("org_key_audit").find({ orgId: org.orgId }).toArray()); assert.equal(rows.includes(globalThis.__pass), false, "no data key"); const doc = await db.collection("s3_owner_keys").findOne({ ownerType: "org", ownerId: org.oid }); assert.equal(rows.includes(doc.keyEnvelope.ciphertext), false, "no ciphertext");
  assert.ok((await KS.listAudit({ orgId: org.oid, membership: owner.membership })).events.some((e) => e.op === "disable"));
  assert.ok((await cols.orgActivity.countDocuments({ orgId: org.orgId, recordType: "KEY_MANAGEMENT", action: "PROVIDER_SET" })) >= 3, "configuration changes are in the organization's audit chain");
});

test("returning to the platform key re-wraps back; a new organization configured before its first credential gets a customer envelope from the start", T, async () => {
  await KS.configure({ ...base(), provider: "platform" }); const doc = await db.collection("s3_owner_keys").findOne({ ownerType: "org", ownerId: org.oid }); assert.ok(doc.wrappedPassphrase && !doc.keyEnvelope); assert.equal(await getOwnerS3Passphrase({ type: "org", orgId: org.oid }), globalThis.__pass);
  const o2 = { ...other.owner, membership: other.owner.membership }; await KS.configure({ orgId: other.oid, membership: o2.membership, actorEmail: o2.email, provider: "local", keyRef: "cust-2026", acknowledgeDestruction: true });
  await ensureOwnerS3Passphrase({ type: "org", orgId: other.oid }); const d2 = await db.collection("s3_owner_keys").findOne({ ownerType: "org", ownerId: other.oid }); assert.ok(d2.keyEnvelope && !d2.wrappedPassphrase, "wrapped by the customer's provider from the start"); const p2 = await getOwnerS3Passphrase({ type: "org", orgId: other.oid }); assert.ok(p2.length > 40 && p2 !== globalThis.__pass, "each organization has its own data key");
  assert.equal((await code(KS.rotate({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email })))?.code, "NOT_APPLICABLE", "platform rotation is an operator procedure");
});
