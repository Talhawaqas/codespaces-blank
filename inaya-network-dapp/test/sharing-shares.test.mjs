// test/sharing-shares.test.mjs -- Secure Sharing 2.0 against the real database: link creation with policies, the access-session
// flow, ciphertext served through Inaya, limits under concurrency, revocation, delegation, listing, isolation.
// Run: node --env-file=.env.local --test --test-force-exit --test-timeout=300000 test/sharing-shares.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setup, teardown, makeChatOrg, c as cols } from "./_chat-fixtures.mjs";
import { ObjectId } from "mongodb";
import * as S from "../src/lib/sharing/shares.js";
import { createDocumentShare, resolveShareAccess, getDocumentAccessLevel } from "../src/lib/document-permissions.js";
import { getOrgCollections } from "../src/lib/orgs.js";

const T = { timeout: 300000 };
let org, other, doc, db;
const FUT = (ms = 3600_000) => new Date(Date.now() + ms).toISOString();
const CID_A = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const CID_B = "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
const CIPHER = { [CID_A]: JSON.stringify({ shard: "CIPHERTEXT-ALPHA" }), [CID_B]: JSON.stringify({ shard: "CIPHERTEXT-BETA" }) };
const mk = async (options = {}, expiresAt = FUT()) => S.createLinkShare({ orgId: org.oid, documentId: String(doc._id), actorEmail: org.alice.email, expiresAt, options });
const open = (token, extra = {}) => S.openShare({ token, ip: "203.0.113.7", deviceId: "dev-1", ...extra });
const read = (token, sessionToken, part = "alpha", ip = "203.0.113.7") => S.readShareContent({ token, sessionToken, part, ip });
const code = async (p) => p.then(() => "no error", (e) => e);

before(async () => {
  await setup(); db = (await getOrgCollections()).db;
  org = await makeChatOrg("share"); other = await makeChatOrg("share-other", { people: ["eve"] });
  const now = new Date().toISOString();
  const ins = await cols.orgDocuments.insertOne({ orgId: org.orgId, departmentId: new ObjectId(), projectId: new ObjectId(), filename: "plan.pdf", fileHash: `0xshare-${randomBytes(4).toString("hex")}`, sizeBytes: 4321, cidAlpha: CID_A, cidBeta: CID_B, uploadedByEmail: org.alice.email, txHash: "0xfake", status: "DRAFT", accessLevel: "PRIVATE", createdAt: now, deletedAt: null });
  doc = await cols.orgDocuments.findOne({ _id: ins.insertedId });
  S.setShardFetcher(async (cid) => { if (!CIPHER[cid]) throw new Error("unknown cid"); return CIPHER[cid]; });
});
after(async () => {
  const orgIds = [org.orgId, other.orgId];
  for (const n of ["orgDocuments", "documentShares", "documentPermissions", "documentActivity"]) await cols[n].deleteMany({ $or: [{ orgId: { $in: orgIds } }, { organizationId: { $in: orgIds } }] }).catch(() => {});
  for (const n of ["file_share_access_events", "drm_sessions", "share_email_codes"]) await db.collection(n).deleteMany({}).catch(() => {});
  await teardown();
});

test("creating a link: the token is shown once, only its hash is stored, the password is hashed, the view hides every secret", T, async () => {
  const r = await mk({ password: "correct horse battery", ipAllow: ["203.0.113.0/24"], label: "Q3 deck", watermark: true, notifyOnAccess: true });
  assert.ok(r.token.length >= 40);
  const row = await cols.documentShares.findOne({ _id: new ObjectId(r.shareId) });
  assert.equal(row.v, 2); assert.equal(row.tokenHash.includes(r.token), false);
  assert.match(row.passwordHash, /^scrypt\$/); assert.equal(JSON.stringify(row).includes("correct horse"), false);
  const dump = JSON.stringify(r.share); assert.equal(dump.includes(row.tokenHash), false); assert.equal(dump.includes(row.passwordHash), false);
  assert.equal(r.share.passwordProtected, true); assert.equal(r.share.status, "active");
  await assert.rejects(() => mk({ password: "x" }), (e) => e.status === 400);
  await assert.rejects(() => mk({ ipAllow: ["nonsense"] }), (e) => e.status === 400);
});

test("opening: ciphertext flows through Inaya, no storage pointer is ever returned", T, async () => {
  const { token } = await mk({});
  const o = await open(token);
  assert.equal(o.filename, "plan.pdf"); assert.deepEqual(o.parts, ["alpha", "beta"]);
  assert.equal(JSON.stringify(o).includes(CID_A), false); assert.equal(JSON.stringify(o).includes(CID_B), false);
  const a = await read(token, o.sessionToken, "alpha"); const b = await read(token, o.sessionToken, "beta");
  assert.equal(JSON.parse(a.content).shard, "CIPHERTEXT-ALPHA"); assert.equal(JSON.parse(b.content).shard, "CIPHERTEXT-BETA");
  assert.equal(JSON.stringify([a, b]).includes(CID_A), false);
});

test("password: required, wrong refused, 8 wrong attempts lock the link, the right one works after the lock expires", T, async () => {
  const { token, shareId } = await mk({ password: "swordfish-123" });
  const need = await code(open(token)); assert.equal(need.status, 401); assert.equal(need.needs, "password");
  for (let i = 0; i < 7; i++) { const e = await code(open(token, { password: "wrong-" + i })); assert.equal(e.status, 401); }
  const row = await cols.documentShares.findOne({ _id: new ObjectId(shareId) }); assert.equal(row.passwordFailures, 7);
  const eighth = await code(open(token, { password: "wrong-8" })); assert.equal(eighth.status, 401);
  const locked = await code(open(token, { password: "swordfish-123" })); assert.equal(locked.status, 429, "even the right password is refused while locked");
  await cols.documentShares.updateOne({ _id: new ObjectId(shareId) }, { $set: { lockedUntil: new Date(Date.now() - 1000).toISOString() } });
  const ok = await open(token, { password: "swordfish-123" }); assert.ok(ok.sessionToken);
  assert.equal((await cols.documentShares.findOne({ _id: new ObjectId(shareId) })).passwordFailures, 0, "a success resets the counter");
});

test("expiry: an expired link is refused and an already-open session stops working the moment the link expires", T, async () => {
  const { token, shareId } = await mk({});
  const o = await open(token);
  assert.ok((await read(token, o.sessionToken)).content);
  await cols.documentShares.updateOne({ _id: new ObjectId(shareId) }, { $set: { expiresAt: new Date(Date.now() - 1000).toISOString() } });
  assert.equal((await code(open(token))).status, 410);
  assert.equal((await code(read(token, o.sessionToken))).status, 410, "no expiry bypass through an old session");
});

test("revocation: immediate for new visitors and for sessions already open; revoking twice is harmless", T, async () => {
  const { token, shareId } = await mk({});
  const o = await open(token);
  const r = await S.revokeShare({ orgId: org.oid, shareId, actorEmail: org.alice.email, membership: org.alice.membership });
  assert.equal(r.revoked, true);
  assert.equal((await code(open(token))).status, 410);
  const e = await code(read(token, o.sessionToken)); assert.ok([401, 410].includes(e.status));
  assert.equal((await S.revokeShare({ orgId: org.oid, shareId, actorEmail: org.alice.email, membership: org.alice.membership })).alreadyRevoked, true);
  await assert.rejects(() => S.updateShare({ orgId: org.oid, shareId, actorEmail: org.alice.email, membership: org.alice.membership, patch: { label: "x" } }), (e2) => e2.status === 409);
});

test("use limits hold under concurrency: maxUses=2 admits exactly two of five simultaneous visitors; one-time admits exactly one", T, async () => {
  const two = await mk({ maxUses: 2 });
  const rs = await Promise.allSettled([1, 2, 3, 4, 5].map((i) => open(two.token, { deviceId: "d" + i })));
  assert.equal(rs.filter((r) => r.status === "fulfilled").length, 2);
  assert.ok(rs.filter((r) => r.status === "rejected").every((r) => r.reason.status === 410));
  assert.equal((await cols.documentShares.findOne({ _id: new ObjectId(two.shareId) })).useCount, 2, "the counter never overshoots");
  const one = await mk({ oneTime: true });
  const rs1 = await Promise.allSettled([1, 2, 3].map(() => open(one.token)));
  assert.equal(rs1.filter((r) => r.status === "fulfilled").length, 1);
});

test("download limit: reserved on a session's first fetch, exact under concurrency; view-only links never count downloads", T, async () => {
  const { token, shareId } = await mk({ permission: "download", maxDownloads: 2 });
  const sessions = await Promise.all([1, 2, 3, 4].map((i) => open(token, { deviceId: "x" + i })));
  const results = await Promise.allSettled(sessions.map((s) => read(token, s.sessionToken, "alpha")));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2, "only two sessions get to download");
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => r.reason.status === 410));
  const winner = sessions[results.findIndex((r) => r.status === "fulfilled")];
  assert.ok((await read(token, winner.sessionToken, "beta")).content, "a session that holds a reservation can fetch its second part");
  assert.equal((await cols.documentShares.findOne({ _id: new ObjectId(shareId) })).downloadCount, 2);
  const view = await mk({ permission: "view" });
  const vs = await open(view.token); await read(view.token, vs.sessionToken, "alpha"); await read(view.token, vs.sessionToken, "beta");
  assert.equal((await cols.documentShares.findOne({ _id: new ObjectId(view.shareId) })).downloadCount, 0);
});

test("IP range and device binding: a generic refusal that does not say which rule failed", T, async () => {
  const ipLink = await mk({ ipAllow: ["198.51.100.0/24"] });
  const denied = await code(open(ipLink.token, { ip: "203.0.113.7" })); assert.equal(denied.status, 403);
  const o = await open(ipLink.token, { ip: "198.51.100.20" });
  const moved = await code(read(ipLink.token, o.sessionToken, "alpha", "203.0.113.9")); assert.equal(moved.status, 403, "a session cannot be replayed from another network");
  const dev = await mk({ deviceBinding: "first-use" });
  assert.ok((await open(dev.token, { deviceId: "laptop" })).sessionToken);
  const other2 = await code(open(dev.token, { deviceId: "phone" })); assert.equal(other2.status, 403); assert.equal(other2.message, denied.message);
  assert.ok((await open(dev.token, { deviceId: "laptop" })).sessionToken, "the bound device keeps working");
  const nodev = await mk({ deviceBinding: "first-use" });
  assert.equal((await code(S.openShare({ token: nodev.token, ip: "1.1.1.1" }))).status, 403);
});

test("domain restriction: email, then an emailed one-time code; wrong domain, wrong code and replays are refused", T, async () => {
  const sent = []; S.setShareEmailSender(async (m) => { sent.push(m); });
  const { token } = await mk({ domainAllow: ["acme.com"] });
  assert.equal((await code(open(token))).needs, "email");
  assert.equal((await code(open(token, { email: "eve@evil.com" }))).status, 403);
  const needCode = await code(open(token, { email: "bob@acme.com" })); assert.equal(needCode.needs, "code");
  assert.deepEqual(await S.requestShareCode({ token, email: "eve@evil.com", ip: "1.1.1.1" }), { sent: true }, "the answer is the same for an ineligible address");
  assert.equal(sent.length, 0, "...and nothing is sent to it");
  await S.requestShareCode({ token, email: "bob@acme.com", ip: "1.1.1.1" });
  assert.equal(sent.length, 1); const real = /(\d{6})/.exec(sent[0].text)[1];
  assert.equal((await code(open(token, { email: "bob@acme.com", code: real === "000000" ? "000001" : "000000" }))).needs, "code");
  const ok = await open(token, { email: "bob@acme.com", code: real }); assert.ok(ok.sessionToken);
  assert.equal((await code(open(token, { email: "bob@acme.com", code: real }))).needs, "code", "a code is single use");
  S.setShareEmailSender(async () => { throw new Error("no provider"); });
  await S.requestShareCode({ token, email: "bob@acme.com", ip: "1.1.1.1" }).then((r) => assert.equal(r.sent, false), () => {});
});

test("delegation: a delegated manager can revoke; a stranger and another organization cannot; admins always can", T, async () => {
  const { shareId } = await mk({ managerEmails: [org.bob.email] });
  await assert.rejects(() => S.revokeShare({ orgId: org.oid, shareId, actorEmail: org.carol.email, membership: org.carol.membership }), (e) => e.status === 403);
  await assert.rejects(() => S.revokeShare({ orgId: other.oid, shareId, actorEmail: other.eve.email, membership: other.eve.membership }), (e) => e.status === 404, "another organization cannot even see it");
  await assert.rejects(() => S.updateShare({ orgId: org.oid, shareId, actorEmail: org.bob.email, membership: org.bob.membership, patch: { managerEmails: [org.carol.email] } }), (e) => e.status === 403, "a delegate cannot widen the delegation");
  const r = await S.revokeShare({ orgId: org.oid, shareId, actorEmail: org.bob.email, membership: org.bob.membership }); assert.equal(r.revoked, true);
  const second = await mk({}); const adminRevoke = await S.revokeShare({ orgId: org.oid, shareId: second.shareId, actorEmail: org.owner.email, membership: org.owner.membership });
  assert.equal(adminRevoke.revoked, true);
});

test("update: extend within the cap, refuse beyond it, set and clear a password", T, async () => {
  const { token, shareId } = await mk({});
  const args = { orgId: org.oid, shareId, actorEmail: org.alice.email, membership: org.alice.membership };
  const ext = await S.updateShare({ ...args, patch: { expiresAt: FUT(5 * 86400_000), label: "renamed", notifyOnAccess: true } });
  assert.equal(ext.label, "renamed"); assert.equal(ext.notifyOnAccess, true);
  await assert.rejects(() => S.updateShare({ ...args, patch: { expiresAt: FUT(400 * 86400_000) } }), (e) => e.status === 400);
  await assert.rejects(() => S.updateShare({ ...args, patch: { expiresAt: new Date(Date.now() - 1000).toISOString() } }), (e) => e.status === 400);
  await assert.rejects(() => S.updateShare({ ...args, patch: {} }), (e) => e.status === 400);
  const pw = await S.updateShare({ ...args, patch: { password: "a-new-password" } }); assert.equal(pw.passwordProtected, true);
  assert.equal((await code(open(token))).needs, "password");
  const clear = await S.updateShare({ ...args, patch: { password: "" } }); assert.equal(clear.passwordProtected, false);
  assert.ok((await open(token)).sessionToken);
});

test("legacy links are untouched: the old flow still resolves, and the new flow tells the caller it is a legacy link", T, async () => {
  const legacy = await createDocumentShare({ orgId: org.oid, documentId: String(doc._id), createdByEmail: org.alice.email, expiresAt: FUT(), maxUses: 1 });
  const e = await code(open(legacy.token)); assert.equal(e.status, 409); assert.equal(e.legacy, true);
  const r = await resolveShareAccess(legacy.token); assert.equal(r.filename, "plan.pdf"); assert.equal(r.cidAlpha, CID_A, "the old behaviour is exactly as before");
  assert.equal((await resolveShareAccess(legacy.token)).status, 410, "...including its use limit");
});

test("tokens: tampered, truncated and cross-share session tokens are refused", T, async () => {
  const a = await mk({}); const b = await mk({});
  assert.equal((await code(open(a.token + "x"))).status, 404); assert.equal((await code(open(a.token.slice(0, -2)))).status, 404); assert.equal((await code(open(""))).status, 404);
  const oa = await open(a.token);
  const swapped = await code(read(b.token, oa.sessionToken)); assert.equal(swapped.status, 401, "a session belongs to exactly one share");
  assert.equal((await code(read(a.token, "forged"))).status, 401); assert.equal((await code(read(a.token, undefined))).status, 401);
  assert.equal((await code(read(a.token, oa.sessionToken, "gamma"))).status, 400);
});

test("manager list: byMe, document, org (admin only), status filters, pagination; shared-with-me; expiring member grants", T, async () => {
  const mine = await S.listShares({ orgId: org.oid, actorEmail: org.alice.email, membership: org.alice.membership, scope: "byMe", limit: 5 });
  assert.equal(mine.items.length, 5); assert.ok(mine.nextCursor, "paginates");
  const page2 = await S.listShares({ orgId: org.oid, actorEmail: org.alice.email, membership: org.alice.membership, scope: "byMe", limit: 5, before: mine.nextCursor });
  assert.ok(page2.items.length >= 1 && !page2.items.some((i) => mine.items.some((m) => m.shareId === i.shareId)), "no overlap between pages");
  assert.ok(mine.items.every((i) => i.filename === "plan.pdf" && i.canManage));
  assert.equal(JSON.stringify(mine).includes("tokenHash"), false);
  const rev = await S.listShares({ orgId: org.oid, actorEmail: org.alice.email, membership: org.alice.membership, scope: "byMe", status: "revoked", limit: 100 });
  assert.ok(rev.items.length >= 1 && rev.items.every((i) => i.status === "revoked"));
  const exp = await S.listShares({ orgId: org.oid, actorEmail: org.alice.email, membership: org.alice.membership, scope: "byMe", status: "expired", limit: 100 });
  assert.ok(exp.items.every((i) => i.status === "expired"));
  await assert.rejects(() => S.listShares({ orgId: org.oid, actorEmail: org.bob.email, membership: org.bob.membership, scope: "org" }), (e) => e.status === 403);
  const all = await S.listShares({ orgId: org.oid, actorEmail: org.owner.email, membership: org.owner.membership, scope: "org", limit: 100 });
  assert.ok(all.items.length >= mine.items.length);
  const none = await S.listShares({ orgId: other.oid, actorEmail: other.eve.email, membership: other.eve.membership, scope: "org", limit: 100 }).catch((e) => e);
  assert.ok(none.status === 403 || none.items.length === 0, "another organization sees none of these");
  const bobView = await S.listShares({ orgId: org.oid, actorEmail: org.bob.email, membership: org.bob.membership, scope: "byMe" });
  assert.equal(bobView.items.every((i) => i.managerEmails.includes(org.bob.email) || i.createdByEmail === org.bob.email), true, "only shares Bob created or manages");
  // member share with expiry: real access resolver honours it
  const g = await S.createMemberShare({ orgId: org.oid, documentId: String(doc._id), actorEmail: org.alice.email, targetEmail: org.carol.email, permission: "view", expiresAt: FUT(60_000) });
  assert.equal(g.level, "VIEW");
  const level = () => getDocumentAccessLevel({ orgId: org.oid, doc, membership: org.carol.membership, email: org.carol.email });
  assert.equal(await level(), "VIEW");
  const withMe = await S.listShares({ orgId: org.oid, actorEmail: org.carol.email, membership: org.carol.membership, scope: "withMe" });
  assert.ok(withMe.items.some((i) => i.documentId === String(doc._id) && i.level === "VIEW" && i.grantedByEmail === org.alice.email));
  await cols.documentPermissions.updateOne({ orgId: org.orgId, documentId: doc._id, email: org.carol.email }, { $set: { expiresAt: new Date(Date.now() - 1000).toISOString() } });
  assert.notEqual(await level(), "VIEW", "an expired share no longer grants access");
  await assert.rejects(() => S.createMemberShare({ orgId: org.oid, documentId: String(doc._id), actorEmail: org.alice.email, targetEmail: "stranger@example.com", permission: "view" }), (e) => e.status === 404);
  await assert.rejects(() => S.createMemberShare({ orgId: org.oid, documentId: String(doc._id), actorEmail: org.alice.email, targetEmail: org.bob.email, permission: "root" }), (e) => e.status === 400);
});

test("access log and notification: masked IP only, no secrets, notify-on-access reaches the creator", T, async () => {
  const { token, shareId } = await mk({ notifyOnAccess: true });
  await open(token, { ip: "198.51.100.77", email: "guest@example.org" });
  await code(open(token + "z"));
  const log = await S.listAccessEvents({ orgId: org.oid, shareId, actorEmail: org.alice.email, membership: org.alice.membership });
  const opened = log.events.find((e) => e.type === "OPENED");
  assert.equal(opened.ipMasked, "198.51.100.0", "the last octet is dropped"); assert.equal(opened.email, "guest@example.org");
  assert.equal(JSON.stringify(log).includes("198.51.100.77"), false);
  const note = await db.collection("notifications").findOne({ orgId: org.orgId, type: "share.accessed", targetEmail: org.alice.email });
  assert.ok(note, "the creator was notified"); assert.equal(note.body.includes("plan.pdf"), true);
  await assert.rejects(() => S.listAccessEvents({ orgId: org.oid, shareId, actorEmail: org.carol.email, membership: org.carol.membership }), (e) => e.status === 403);
  assert.equal(S.maskIp("2001:db8:aaaa:bbbb::1"), "2001:db8:aaaa::");
});

test("a watermarked link stamps who and when, without secrets", T, async () => {
  const { token } = await mk({ watermark: true, label: "Board pack" });
  const o = await open(token, { email: "ceo@example.org", ip: "203.0.113.7" });
  assert.match(o.watermark, /^Board pack \| ceo@example\.org \| 203\.0\.113\.0 \| \d{4}-\d\d-\d\d \d\d:\d\d UTC$/);
  const plain = await open((await mk({})).token); assert.equal(plain.watermark, null);
});

test("the legacy endpoint can never be used to bypass a v2 link's rules (no storage pointer, no use taken)", T, async () => {
  const { token, shareId } = await mk({ password: "swordfish-123", ipAllow: ["198.51.100.0/24"], maxUses: 1 });
  const viaLegacy = await resolveShareAccess(token);
  assert.equal(viaLegacy.status, 409); assert.equal(JSON.stringify(viaLegacy).includes(CID_A), false); assert.equal(viaLegacy.cidAlpha, undefined);
  const { consumeDocumentShare } = await import("../src/lib/document-permissions.js");
  const consumed = await consumeDocumentShare(token); assert.equal(consumed.status, 409); assert.equal(consumed.share, undefined);
  assert.equal((await cols.documentShares.findOne({ _id: new ObjectId(shareId) })).useCount, 0, "the legacy path took no use");
  const peek = await S.peekShare(token);
  assert.deepEqual(peek, { v2: true, status: "active", requires: { password: true, email: false }, permission: "download", label: null });
  assert.equal(JSON.stringify(peek).includes("plan.pdf"), false, "the preview says nothing about the document");
  assert.equal(await S.peekShare("not-a-token"), null);
  const legacy = await createDocumentShare({ orgId: org.oid, documentId: String(doc._id), createdByEmail: org.alice.email, expiresAt: FUT() });
  assert.equal(await S.peekShare(legacy.token), null, "legacy links are not v2 links");
});
