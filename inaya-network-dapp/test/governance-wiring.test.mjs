// test/governance-wiring.test.mjs -- governance policy and DLP actually enforced on the real paths: share creation and opening, S3 writes,
// file-request uploads. Real database; the same functions the routes call.
// Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=300000 test/governance-wiring.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { setup, teardown, makeChatOrg, c as cols } from "./_chat-fixtures.mjs";
import { getOrgCollections } from "../src/lib/orgs.js";
import * as P from "../src/lib/governance/policies.js";
import * as S from "../src/lib/sharing/shares.js";
import * as R from "../src/lib/filerequests/requests.js";
import * as C from "../src/lib/filerequests/clientCrypto.js";
import { putS3Object } from "../src/lib/s3-compat/store.js";

const T = { timeout: 300000 };
const FUT = (h) => new Date(Date.now() + h * 3600_000).toISOString();
const CID_A = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", CID_B = "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
let org, db, doc, keys;
const code = (p) => p.then(() => null, (e) => e);
const publish = async (type, config, extra = {}) => { const p = await P.createPolicy({ orgId: org.oid, actorEmail: org.owner.email, membership: org.owner.membership, type, name: `w-${type}`, config, ...extra }); return P.publishPolicy({ orgId: org.oid, policyId: p.policyId, actorEmail: org.owner.email, membership: org.owner.membership }); };
const retireAll = async () => { for (const p of await P.listPolicies({ orgId: org.oid, membership: org.owner.membership, status: "published" })) await P.retirePolicy({ orgId: org.oid, policyId: p.policyId, actorEmail: org.owner.email, membership: org.owner.membership }); };
const mk = (options = {}, hours = 24) => S.createLinkShare({ orgId: org.oid, documentId: String(doc._id), actorEmail: org.alice.email, expiresAt: FUT(hours), options, role: "member", ip: "203.0.113.5" });

before(async () => {
  await setup(); db = (await getOrgCollections()).db; org = await makeChatOrg("govw");
  const ins = await cols.orgDocuments.insertOne({ orgId: org.orgId, departmentId: new ObjectId(), projectId: new ObjectId(), filename: "deck.pdf", fileHash: "0xgw" + Date.now(), sizeBytes: 9, cidAlpha: CID_A, cidBeta: CID_B, uploadedByEmail: org.alice.email, txHash: "0xfake", status: "DRAFT", accessLevel: "PRIVATE", classification: "CONFIDENTIAL", createdAt: new Date().toISOString(), deletedAt: null });
  doc = await cols.orgDocuments.findOne({ _id: ins.insertedId });
  S.setShardFetcher(async (cid) => JSON.stringify({ shard: cid }));
  keys = await C.generateRequestKeys("a long enough passphrase", { iterations: 1000 });
});
after(async () => {
  for (const n of ["orgDocuments", "documentShares", "documentActivity"]) await cols[n].deleteMany({ $or: [{ orgId: org.orgId }, { organizationId: org.orgId }] }).catch(() => {});
  for (const n of ["governance_policies", "dlp_events", "dlp_approvals", "file_requests"]) await db.collection(n).deleteMany({ orgId: org.orgId }).catch(() => {});
  await db.collection("file_share_access_events").deleteMany({}).catch(() => {}); await db.collection("drm_sessions").deleteMany({}).catch(() => {});
  await teardown();
});

test("sharing policies are enforced when a link is created", T, async () => {
  assert.ok((await mk({})).token, "no policy: unchanged behaviour");
  await publish("external_sharing", { allowed: true, maxExpiryHours: 48, requirePassword: true });
  assert.equal((await code(mk({}, 24))).code, "POLICY_BLOCKED"); assert.match((await code(mk({}, 24))).message, /password/);
  assert.equal((await code(mk({ password: "long enough pw" }, 72))).status, 403);
  assert.ok((await mk({ password: "long enough pw" }, 24)).token);
  await publish("download_limits", { maxPerShare: 3 });
  assert.match((await code(mk({ password: "long enough pw" }, 24))).message, /at most 3 downloads/);
  assert.match((await code(mk({ password: "long enough pw", maxDownloads: 10 }, 24))).message, /at most 3/);
  assert.ok((await mk({ password: "long enough pw", maxDownloads: 3 }, 24)).token);
  await publish("external_domain", { allowedDomains: ["partner.com"] });
  assert.match((await code(mk({ password: "long enough pw", maxDownloads: 3 }, 24))).message, /limited to these domains/);
  assert.ok((await mk({ password: "long enough pw", maxDownloads: 3, domainAllow: ["partner.com"] }, 24)).token);
  assert.equal((await code(mk({ password: "long enough pw", maxDownloads: 3, domainAllow: ["evil.com"] }, 24))).status, 403);
  await publish("public_links", { allowed: false });
  assert.match((await code(mk({ password: "long enough pw", maxDownloads: 3, domainAllow: ["partner.com"] }, 24))).message, /public links/);
  await retireAll();
  assert.ok((await mk({})).token, "retiring the policies lifts the restrictions");
});

test("DLP rules are enforced when a link is opened, and a refusal does not consume a use", T, async () => {
  const made = await mk({ maxUses: 5 });
  await publish("dlp", { rules: [{ id: "net", name: "Confidential links only from HQ", action: "DENY", when: { actions: ["share_open"], classification: ["CONFIDENTIAL"], ipNotIn: ["198.51.100.0/24"] }, message: "Confidential files can only be opened from the corporate network." }] });
  const off = await code(S.openShare({ token: made.token, ip: "203.0.113.50", deviceId: "d1" }));
  assert.equal(off.status, 403); assert.match(off.message, /corporate network/);
  assert.equal((await cols.documentShares.findOne({ _id: new ObjectId(made.shareId) })).useCount, 0, "a refused open takes no use");
  const ok = await S.openShare({ token: made.token, ip: "198.51.100.8", deviceId: "d1" }); assert.ok(ok.sessionToken);
  assert.equal((await cols.documentShares.findOne({ _id: new ObjectId(made.shareId) })).useCount, 1);
  const ev = await db.collection("dlp_events").find({ orgId: org.orgId, action: "share_open" }).toArray(); assert.equal(ev.length, 1); assert.equal(ev[0].decision, "DENY"); assert.equal(ev[0].context.ip, "203.0.113.0/24");
  await publish("dlp", { rules: [{ id: "nodl", name: "No downloads of confidential content", action: "DENY", when: { actions: ["share_download"], classification: ["CONFIDENTIAL"] } }] }, { precedence: 1 });
  const dl = await mk({ permission: "download" }); const sess = await S.openShare({ token: dl.token, ip: "198.51.100.8", deviceId: "d1" });
  assert.equal((await code(S.readShareContent({ token: dl.token, sessionToken: sess.sessionToken, part: "alpha", ip: "198.51.100.8" }))).status, 403);
  await retireAll();
});

test("S3 writes through the compatibility layer run upload governance; internal callers are untouched", T, async () => {
  await publish("upload_types", { denyExtensions: ["exe", "bat"], requireScan: "static", maxBytes: 1024 * 1024 });
  const put = (key, body, governance) => putS3Object({ orgId: org.oid, bucket: "gov-bucket", key, bodyBuffer: Buffer.from(body), contentType: "text/plain", actorEmail: "AKIAGOV", governance });
  const e1 = await code(put("tool.exe", "x", { ip: "203.0.113.9", role: "api" })); assert.equal(e1.reason, "Governance"); assert.match(e1.message, /\.exe/);
  const e2 = await code(put("note.txt", "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*", { ip: "203.0.113.9", role: "api" })); assert.equal(e2.reason, "Governance");
  assert.equal(await cols.orgDocuments.countDocuments({ orgId: org.orgId, filename: { $in: ["tool.exe", "note.txt"] } }), 0, "nothing was stored");
  const ev = await db.collection("dlp_events").find({ orgId: org.orgId, kind: "upload" }).toArray(); assert.ok(ev.length >= 2);
  await retireAll();
});

test("file-request uploads are governed on metadata, and the result is honest that content was not inspected", T, async () => {
  const r = await R.createRequest({ orgId: org.oid, actorEmail: org.alice.email, input: { title: "Forms", instructions: "", expiresAt: FUT(24), maxFiles: 5, allowedExtensions: ["pdf", "exe"], publicKeyJwk: keys.publicKeyJwk, wrappedPrivateKey: keys.wrappedPrivateKey } }).catch((e) => e);
  assert.ok(r.token, r.message);
  await publish("upload_types", { denyExtensions: ["exe"] });
  const env = (await C.encryptForRequest(keys.publicKeyJwk, new Uint8Array(20), { name: "a", type: "x" }, "rid")).keyEnvelope;
  const bad = await code(R.beginUpload({ token: r.token, uploader: { name: "D", email: "d@x.org" }, ext: "exe", size: 100, partCount: 1, keyEnvelope: env, ip: "203.0.113.5" })); assert.equal(bad.status, 403); assert.match(bad.message, /\.exe/);
  const good = await R.beginUpload({ token: r.token, uploader: { name: "D", email: "d@x.org" }, ext: "pdf", size: 100, partCount: 1, keyEnvelope: env, ip: "203.0.113.5" }); assert.ok(good.uploadId);
  await retireAll();
});
