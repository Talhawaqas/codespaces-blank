// test/governance.test.mjs -- governance policies (versioned, immutable once published), the DLP engine and upload governance, against the real database.
// Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=300000 test/governance.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { setup, teardown, makeChatOrg, c as cols } from "./_chat-fixtures.mjs";
import { getOrgCollections } from "../src/lib/orgs.js";
import * as P from "../src/lib/governance/policies.js";
import * as D from "../src/lib/governance/dlp.js";
import * as U from "../src/lib/governance/uploads.js";
import { EICAR_TEST_STRING } from "../src/lib/support/scanner.js";

const T = { timeout: 300000 };
let org, db, owner, admin2, member;

function zip(entries) {
  const locals = []; const central = []; let off = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data); const comp = e.deflate ? deflateRawSync(data) : data; const name = Buffer.from(e.name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(e.encrypted ? 1 : 0, 6); lh.writeUInt16LE(e.deflate ? 8 : 0, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(e.encrypted ? 1 : 0, 8); ch.writeUInt16LE(e.deflate ? 8 : 0, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, name, comp); central.push(ch, name); off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central); const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
const publish = async (type, config, extra = {}) => { const p = await P.createPolicy({ orgId: org.oid, actorEmail: owner.email, membership: owner.membership, type, name: `t-${type}`, config, ...extra }); return P.publishPolicy({ orgId: org.oid, policyId: p.policyId, actorEmail: owner.email, membership: owner.membership }); };

before(async () => {
  await setup(); db = (await getOrgCollections()).db;
  org = await makeChatOrg("gov", { people: ["admin2", "member"] });
  owner = org.owner; admin2 = org.admin2; member = org.member;
  await cols.orgMembers.updateOne({ orgId: org.orgId, email: admin2.email }, { $set: { role: "admin" } });
  admin2.membership = await cols.orgMembers.findOne({ orgId: org.orgId, email: admin2.email });
});
after(async () => { try { await db.collection("governance_policies").deleteMany({ orgId: org.orgId }); await db.collection("dlp_events").deleteMany({ orgId: org.orgId }); await db.collection("dlp_approvals").deleteMany({ orgId: org.orgId }); } catch { /* best effort */ } await teardown(); });

test("policies: validated, drafts are editable, published versions are immutable, new versions supersede, retire", T, async () => {
  const base = { orgId: org.oid, actorEmail: owner.email, membership: owner.membership };
  await assert.rejects(P.createPolicy({ ...base, type: "external_sharing", config: {} }), (e) => e.status === 400);
  await assert.rejects(P.createPolicy({ ...base, type: "nope", config: {} }), (e) => e.status === 400);
  await assert.rejects(P.createPolicy({ ...base, membership: member.membership, type: "external_sharing", config: { allowed: false } }), (e) => e.status === 403);
  const d = await P.createPolicy({ ...base, type: "external_sharing", name: "No external", config: { allowed: false } });
  assert.equal(d.status, "draft"); assert.equal(d.version, 1);
  const edited = await P.updateDraft({ ...base, policyId: d.policyId, config: { allowed: true, maxExpiryHours: 24 } }); assert.equal(edited.config.maxExpiryHours, 24);
  const pub = await P.publishPolicy({ ...base, policyId: d.policyId }); assert.equal(pub.status, "published");
  await assert.rejects(P.updateDraft({ ...base, policyId: d.policyId, config: { allowed: false } }), (e) => e.status === 409); // immutable
  await assert.rejects(P.deleteDraft({ ...base, policyId: d.policyId }), (e) => e.status === 409);
  const v2 = await P.newVersion({ ...base, policyKey: d.policyKey }); assert.equal(v2.version, 2); assert.equal(v2.status, "draft");
  await assert.rejects(P.newVersion({ ...base, policyKey: d.policyKey }), (e) => e.status === 409); // one in progress
  await P.updateDraft({ ...base, policyId: v2.policyId, config: { allowed: false } }); await P.publishPolicy({ ...base, policyId: v2.policyId });
  const rows = await P.listPolicies({ orgId: org.oid, membership: owner.membership, type: "external_sharing" });
  assert.deepEqual(rows.map((r) => [r.version, r.status]), [[2, "published"], [1, "retired"]]);
  assert.equal((await P.effectivePolicies({ orgId: org.oid, type: "external_sharing" }))[0].config.allowed, false);
  await P.retirePolicy({ ...base, policyId: v2.policyId, reason: "test" }); assert.equal((await P.effectivePolicies({ orgId: org.oid, type: "external_sharing" })).length, 0);
  const trail = await cols.orgActivity.find({ orgId: org.orgId, recordType: "GOV_POLICY" }).toArray(); assert.ok(["CREATED", "PUBLISHED", "NEW_VERSION", "RETIRED"].every((a) => trail.some((t) => t.action === a)));
});

test("approval: a second admin must approve; the submitter cannot; rejection returns it to draft", T, async () => {
  const base = { orgId: org.oid, actorEmail: owner.email, membership: owner.membership };
  const d = await P.createPolicy({ ...base, type: "public_links", config: { allowed: false }, approvalRequired: true });
  const sub = await P.publishPolicy({ ...base, policyId: d.policyId }); assert.equal(sub.status, "pending_approval");
  assert.equal((await P.effectivePolicies({ orgId: org.oid, type: "public_links" })).length, 0, "not in force until approved");
  await assert.rejects(P.decideApproval({ ...base, policyId: d.policyId, approve: true }), (e) => e.status === 403);
  const rej = await P.decideApproval({ orgId: org.oid, policyId: d.policyId, actorEmail: admin2.email, membership: admin2.membership, approve: false, note: "too broad" }); assert.equal(rej.status, "draft");
  await P.publishPolicy({ ...base, policyId: d.policyId });
  const ok = await P.decideApproval({ orgId: org.oid, policyId: d.policyId, actorEmail: admin2.email, membership: admin2.membership, approve: true }); assert.equal(ok.status, "published"); assert.equal(ok.approvedBy, admin2.email);
});

test("scope, effective dates and precedence decide which policies apply", T, async () => {
  const future = new Date(Date.now() + 86400_000).toISOString(); const past = new Date(Date.now() - 86400_000).toISOString();
  await publish("download_limits", { maxPerShare: 5 }, { scope: { roles: ["owner"] }, precedence: 10 });
  await publish("download_limits", { maxPerShare: 2 }, { scope: { departmentIds: ["d-1"] }, precedence: 5 });
  await publish("download_limits", { maxPerShare: 9 }, { effectiveAt: future });
  await publish("download_limits", { maxPerShare: 8 }, { expiresAt: past, effectiveAt: new Date(Date.now() - 2 * 86400_000).toISOString() });
  const f = async (ctx) => (await P.effectivePolicies({ orgId: org.oid, type: "download_limits", ctx })).map((p) => p.config.maxPerShare);
  assert.deepEqual(await f({ role: "owner", departmentId: "d-1" }), [2, 5]);
  assert.deepEqual(await f({ role: "member", departmentId: "d-2" }), []);
  assert.deepEqual(await f({ role: "owner", departmentId: "d-9" }), [5]);
});

test("DLP matching: every field the SOW lists, as a pure function", T, async () => {
  const m = (when, ctx, o) => D.matchWhen(when, ctx, o).matched;
  assert.ok(m({ actions: ["download"], ipNotIn: ["10.0.0.0/8"] }, { action: "download", ip: "203.0.113.5" }));
  assert.ok(!m({ ipNotIn: ["10.0.0.0/8"] }, { ip: "10.1.2.3" })); assert.ok(m({ ipIn: ["2001:db8::/32"] }, { ip: "2001:db8::1" }));
  assert.ok(m({ fileTypes: ["pdf"] }, { filename: "a.PDF" })); assert.ok(!m({ fileTypes: ["pdf"] }, { filename: "a.png" }));
  assert.ok(m({ pathPrefix: ["finance/"] }, { path: "finance/q3.xlsx" })); assert.ok(m({ userDomains: ["example.com"] }, { email: "a@sub.example.com" }));
  assert.ok(m({ notDestinationDomains: ["corp.com"] }, { destinationDomain: "gmail.com" })); assert.ok(!m({ notDestinationDomains: ["corp.com"] }, { destinationDomain: "mail.corp.com" }));
  assert.ok(m({ device: { trusted: false } }, { device: { id: "d1", trusted: false } })); assert.ok(m({ device: { unknown: true } }, { device: {} }));
  assert.ok(m({ minClassification: "CONFIDENTIAL" }, { classification: "RESTRICTED" }, { levelOrder: { PUBLIC: 0, CONFIDENTIAL: 2, RESTRICTED: 4 } }));
  assert.ok(!m({ minClassification: "CONFIDENTIAL" }, { classification: "PUBLIC" }, { levelOrder: { PUBLIC: 0, CONFIDENTIAL: 2 } }));
  assert.ok(m({ link: { noPassword: true } }, { link: { passwordProtected: false } })); assert.ok(!m({ link: { noPassword: true } }, { link: { passwordProtected: true } }));
  assert.ok(m({ downloadCountAtLeast: 3 }, { downloadCount: 3 })); assert.ok(m({ sizeAtLeast: 100 }, { size: 101 })); assert.ok(m({ legalHold: true }, { legalHold: true }));
  const wk = new Date("2026-10-05T03:00:00Z"); // Monday 03:00 UTC
  assert.ok(m({ time: { days: [1], fromHour: 22, toHour: 6 } }, { now: wk })); assert.ok(!m({ time: { fromHour: 9, toHour: 17 } }, { now: wk }));
});

test("DLP enforcement: decisions, structured events, masked IPs, approval flow, no bypass of an explicit ALLOW order", T, async () => {
  await publish("dlp", { rules: [
    { id: "r-ok", name: "HQ network is fine", action: "ALLOW", when: { actions: ["download"], ipIn: ["198.51.100.0/24"] } },
    { id: "r-deny", name: "No downloads off network", action: "DENY", when: { actions: ["download"], classification: ["CONFIDENTIAL"] }, message: "Confidential files stay on the corporate network." },
    { id: "r-log", name: "Watch exports", action: "LOG_ONLY", when: { actions: ["export"] } },
    { id: "r-appr", name: "External share needs sign-off", action: "REQUIRE_APPROVAL", when: { actions: ["external_share"] } },
    { id: "r-auth", name: "Admin API needs step-up", action: "REQUIRE_STRONGER_AUTH", when: { actions: ["api_access"], roles: ["member"] } },
    { id: "r-q", name: "Quarantine exe", action: "QUARANTINE", when: { actions: ["upload"], fileTypes: ["exe"] } },
  ] }, { precedence: 1 });
  const E = (ctx) => D.enforceDlp({ orgId: org.oid, ctx: { email: member.email, role: "member", ...ctx } });
  const onNet = await E({ action: "download", classification: "CONFIDENTIAL", ip: "198.51.100.9", resourceId: "doc1" }); assert.equal(onNet.allowed, true); assert.equal(onNet.ruleId, "r-ok");
  const off = await E({ action: "download", classification: "CONFIDENTIAL", ip: "203.0.113.77", resourceId: "doc1" });
  assert.equal(off.allowed, false); assert.equal(off.code, "DLP_DENIED"); assert.equal(off.reason, "Confidential files stay on the corporate network.");
  assert.equal((await E({ action: "download", classification: "PUBLIC", ip: "203.0.113.77" })).allowed, true);
  const logged = await E({ action: "export" }); assert.equal(logged.allowed, true); assert.equal(logged.decision, "LOG_ONLY");
  assert.equal((await E({ action: "api_access" })).code, "STRONGER_AUTH_REQUIRED"); assert.equal((await E({ action: "api_access", strongAuth: true })).allowed, true);
  assert.equal((await E({ action: "upload", filename: "x.exe" })).code, "DLP_QUARANTINE");
  const ev = await db.collection("dlp_events").find({ orgId: org.orgId, decision: "DENY" }).toArray(); assert.equal(ev.length, 1);
  assert.equal(ev[0].context.ip, "203.0.113.0/24", "the stored IP is masked"); assert.equal(ev[0].ruleId, "r-deny"); assert.ok(ev[0].policyKey && ev[0].policyVersion === 1);
  await assert.rejects(D.assertDlp({ orgId: org.oid, ctx: { email: member.email, role: "member", action: "download", classification: "CONFIDENTIAL", ip: "203.0.113.77" } }), (e) => e.name === "DlpBlocked" && e.status === 403);

  const a1 = await E({ action: "external_share", resourceId: "doc7", filename: "plan.pdf" }); assert.equal(a1.code, "APPROVAL_REQUIRED");
  const a2 = await E({ action: "external_share", resourceId: "doc7" }); assert.equal(a2.approvalId, a1.approvalId, "one pending request per action and file");
  assert.equal((await D.listApprovals({ orgId: org.oid, membership: owner.membership })).approvals.length, 1);
  await assert.rejects(D.decideDlpApproval({ orgId: org.oid, approvalId: a1.approvalId, membership: member.membership, approverEmail: member.email, approve: true }), (e) => e.status === 403);
  const ownReq = await D.enforceDlp({ orgId: org.oid, ctx: { email: owner.email, role: "owner", action: "external_share", resourceId: "doc8" } });
  await assert.rejects(D.decideDlpApproval({ orgId: org.oid, approvalId: ownReq.approvalId, membership: owner.membership, approverEmail: owner.email, approve: true }), (e) => e.status === 403); // not your own
  await D.decideDlpApproval({ orgId: org.oid, approvalId: a1.approvalId, membership: owner.membership, approverEmail: owner.email, approve: true });
  const pass = await E({ action: "external_share", resourceId: "doc7" }); assert.equal(pass.allowed, true); assert.equal(pass.viaApproval, true);
  assert.equal((await E({ action: "external_share", resourceId: "doc7" })).allowed, false, "an approval lets exactly one request through");
  const list = await D.listDlpEvents({ orgId: org.oid, membership: owner.membership, decision: "DENY" }); assert.equal(list.events.length, 2); // the refused request and the assertDlp call above
  await assert.rejects(D.listDlpEvents({ orgId: org.oid, membership: member.membership }), (e) => e.status === 403);
});

test("upload governance: type, size, sniffing, hash list, archives, antivirus, volume", T, async () => {
  await publish("upload_types", { denyExtensions: ["scr", "bat"], maxBytes: 3 * 1024 * 1024, enforceMime: true, inspectArchives: true, maxArchiveDepth: 2, maxArchiveEntries: 50, maxArchiveRatio: 50, blockEncryptedArchives: true, requireScan: "static", blockedSha256: [createHash("sha256").update("banned content").digest("hex")] }, { precedence: 2 });
  await publish("upload_types", { maxFilesPerHour: 6 }, { scope: { emails: ["volume@example.com"] } });
  const G = (filename, bytes, extra = {}) => U.governUpload({ orgId: org.oid, actorEmail: member.email, role: "member", filename, bytes, size: bytes?.length, runDlp: false, ...extra });
  assert.equal((await G("report.pdf", Buffer.from("%PDF-1.4 hello"))).allowed, true);
  assert.equal((await G("run.bat", Buffer.from("echo"))).code, "EXTENSION_BLOCKED");
  assert.equal((await G("big.txt", Buffer.alloc(4 * 1024 * 1024, 65))).code, "TOO_LARGE");
  assert.equal((await G("../../etc/passwd", Buffer.from("x"))).code, "BAD_FILENAME");
  assert.equal((await G("invoice.pdf", Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0]), Buffer.alloc(64)]))).code, "TYPE_MISMATCH");
  assert.equal((await G("fake.png", Buffer.from("not a png at all"))).code, "TYPE_MISMATCH");
  assert.equal((await G("note.txt", Buffer.from("banned content"))).code, "BLOCKED_HASH");
  const virus = await G("notes.txt", Buffer.from(EICAR_TEST_STRING)); assert.equal(virus.decision, "QUARANTINE"); assert.equal(virus.code, "MALWARE");
  const bomb = zip([{ name: "zeros.bin", data: Buffer.alloc(40 * 1024 * 1024), deflate: true }]); assert.ok(bomb.length < 100_000);
  assert.equal((await G("bomb.zip", bomb)).code, "ARCHIVE_BOMB");
  const inner = zip([{ name: "a.txt", data: "hi" }]); const mid = zip([{ name: "inner.zip", data: inner }]); const outer = zip([{ name: "mid.zip", data: mid }]);
  assert.equal((await G("nested.zip", outer)).code, "ARCHIVE_TOO_DEEP");
  assert.equal((await G("ok.zip", zip([{ name: "a.txt", data: "hello" }, { name: "b.txt", data: "world" }]))).allowed, true);
  assert.equal((await G("enc.zip", zip([{ name: "s.txt", data: "x", encrypted: true }]))).code, "ARCHIVE_ENCRYPTED");
  assert.equal((await G("slip.zip", zip([{ name: "../evil.txt", data: "x" }]))).code, "ARCHIVE_UNSAFE_PATH");
  assert.equal((await G("many.zip", zip(Array.from({ length: 60 }, (_, i) => ({ name: `f${i}.txt`, data: "x" }))))).code, "ARCHIVE_TOO_MANY_FILES");
  const meta = await G("sealed.bin", null, { size: 1000 }); assert.equal(meta.allowed, true); assert.equal(meta.contentInspected, false, "encrypted uploads are not claimed to be scanned");
  assert.equal((await G("sealed.scr", null, { size: 10 })).code, "EXTENSION_BLOCKED");
  const ev = await db.collection("dlp_events").find({ orgId: org.orgId, kind: "upload" }).toArray(); assert.ok(ev.length >= 8); assert.ok(ev.every((e) => e.enforced && !JSON.stringify(e).includes("hello")));
  let rateHit = null; for (let i = 0; i < 8 && !rateHit; i++) { const r = await G(`v${i}.txt`, Buffer.from("x"), { actorEmail: "volume@example.com" }); if (!r.allowed) rateHit = r; } assert.equal(rateHit?.code, "RATE_LIMITED");
  await assert.rejects(U.assertUpload({ orgId: org.oid, actorEmail: member.email, filename: "x.bat", bytes: Buffer.from("x"), runDlp: false }), (e) => e.name === "UploadBlocked" && e.status === 403);
});

test("upload governance also runs the org's DLP rules for the upload action", T, async () => {
  const r = await U.governUpload({ orgId: org.oid, actorEmail: member.email, role: "member", filename: "setup.exe", bytes: null, size: 100, source: "file_request" });
  assert.equal(r.allowed, false); assert.equal(r.decision, "QUARANTINE"); assert.equal(r.code, "DLP_QUARANTINE");
});
