// test/nas-security.test.mjs
// Sovereign NAS SOW Sections 37, 38 and 52A Test F: the security boundary.
// Real appliance, real MongoDB, and the REAL HTTP route handlers (called with
// genuine session cookies minted for test users) so authentication, org scoping,
// rate limiting and replay protection are tested at the API, not just in
// library functions.
// Run: node --env-file=.env.local --test test/nas-security.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { NextRequest } from "next/server.js";
import * as fx from "./_nas-fixtures.mjs";
import { installMemoryProviders } from "./_docauto-fixtures.mjs";
import { createSession, SESSION_COOKIE } from "../src/lib/orgs.js";
import { createShare, deleteShare, setNfsExport } from "../src/lib/nas/shares.js";
import { setShareAccess } from "../src/lib/nas/access.js";
import { createSnapshot, deleteSnapshot, restoreSnapshot, setWormPolicy } from "../src/lib/nas/snapshots.js";
import { runBackup, restoreFromBackup, backupShareToInaya, setBackupPolicy } from "../src/lib/nas/backup.js";
import { createCloudTarget } from "../src/lib/nas/cloudTargets.js";
import { setRemoteAccess } from "../src/lib/nas/network.js";
import { applyUpdate } from "../src/lib/nas/updates.js";
import { createPool } from "../src/lib/nas/pools.js";
import { scanShare, setBaseline } from "../src/lib/nas/ransomware.js";
import { getAppliance } from "../src/lib/nas/appliances.js";
import { verifyNasEvidence, recordNasEvidence } from "../src/lib/nas/evidence.js";
import { verifyChainIntegrity } from "../src/lib/auditChain.js";
import { listNasUsers, provisionNasUser } from "../src/lib/nas/users.js";

let A, B, appA, appB, mgrA, staffA, mgrB, tokens = {};
const run = (args, timeout = 60000) => new Promise((res) => execFile("wsl.exe", ["-d", "Ubuntu", "-u", "root", "--", ...args], { timeout }, (err, so, se) => res({ ok: !err, out: (so || "") + (se || "") })));
const M = (o) => ({ orgId: o.orgId, membership: o.manager.membership, actorEmail: o.manager.email });
const req = (path, { method = "GET", token, body, headers = {} } = {}) => new NextRequest(`http://localhost${path}`, { method, headers: { ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}), "content-type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
async function newShare(org, app, mgr, prefix, files = {}) {
  const shareName = fx.tag(prefix);
  fx.created.shares.add(shareName);
  const s = await createShare({ ...M(org), applianceId: String(app._id), shareName, ownerUnixUser: mgr.unix });
  assert.ok(!s.error, s.error);
  for (const [rel, c] of Object.entries(files)) await fx.agent.writeFile({ shareName, relativePath: rel, buffer: Buffer.from(c), owner: mgr.unix });
  return { shareName, shareId: String(s.share._id), share: s.share };
}

before(async () => {
  await fx.setup();
  installMemoryProviders();
  A = await fx.makeOrg("seca");
  B = await fx.makeOrg("secb");
  appA = await fx.makeAppliance(A, "A NAS");
  appB = await fx.makeAppliance(B, "B NAS");
  mgrA = await fx.provisionUser(A, A.manager, appA._id);
  staffA = await fx.provisionUser(A, A.staff, appA._id);
  mgrB = await fx.provisionUser(B, B.manager, appB._id);
  for (const [k, who] of [["mgrA", A.manager], ["staffA", A.staff], ["outsiderA", A.outsider], ["mgrB", B.manager]]) tokens[k] = (await createSession(who.email)).sessionToken;
});
after(async () => { await fx.teardown(); });

test("API layer: unauthenticated, wrong-org and under-privileged callers are refused; secrets never leak", async () => {
  const { GET: listApp } = await import("../src/app/api/orgs/nas/appliances/route.js");
  const { GET: overview } = await import("../src/app/api/orgs/nas/appliances/[applianceId]/overview/route.js");
  const { POST: createSnap } = await import("../src/app/api/orgs/nas/shares/[shareId]/snapshots/route.js");
  const { GET: listTargets } = await import("../src/app/api/orgs/nas/cloud-targets/route.js");
  const share = await newShare(A, appA, mgrA, "api");
  const p = (id) => ({ params: Promise.resolve(id) });

  assert.equal((await overview(req(`/x?orgId=${A.orgId}`), p({ applianceId: String(appA._id) }))).status, 401, "no session -> 401");
  assert.equal((await overview(req(`/x?orgId=${A.orgId}`, { token: "not-a-real-token" }), p({ applianceId: String(appA._id) }))).status, 401, "garbage token -> 401");
  assert.equal((await overview(req(`/x?orgId=${A.orgId}`, { token: tokens.mgrB }), p({ applianceId: String(appA._id) }))).status, 403, "another org's manager is not a member");
  assert.equal((await overview(req(`/x?orgId=${B.orgId}`, { token: tokens.mgrB }), p({ applianceId: String(appA._id) }))).status, 404, "B's manager cannot read A's appliance even by guessing the id");
  assert.equal((await overview(req(`/x`, { token: tokens.mgrA }), p({ applianceId: String(appA._id) }))).status, 400, "orgId required");
  assert.equal((await overview(req(`/x?orgId=${A.orgId}`, { token: tokens.outsiderA }), p({ applianceId: String(appA._id) }))).status, 403, "a member with no NAS role is refused");
  const ok = await overview(req(`/x?orgId=${A.orgId}`, { token: tokens.staffA }), p({ applianceId: String(appA._id) }));
  assert.equal(ok.status, 200, "NAS staff may read");
  const denied = await createSnap(req(`/x`, { method: "POST", token: tokens.staffA, body: { orgId: A.orgId, name: "nope" } }), p({ shareId: share.shareId }));
  assert.equal(denied.status, 403, "NAS staff may not change anything");
  const badJson = await createSnap(new NextRequest("http://localhost/x", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${tokens.mgrA}` }, body: "{not json" }), p({ shareId: share.shareId }));
  assert.equal(badJson.status, 400);
  const big = await createSnap(req(`/x`, { method: "POST", token: tokens.mgrA, body: { orgId: A.orgId, name: "x".repeat(300000) } }), p({ shareId: share.shareId }));
  assert.equal(big.status, 413, "oversized bodies are rejected");

  const apps = await (await listApp(req(`/x?orgId=${A.orgId}`, { token: tokens.mgrA }))).json();
  assert.ok(apps.appliances.every((a) => a.adminCredential === undefined));
  const targets = JSON.stringify(await (await listTargets(req(`/x?orgId=${A.orgId}`, { token: tokens.mgrA }))).json());
  assert.doesNotMatch(targets, /secretCredential|secretAccessKey/);
  const users = JSON.stringify((await listNasUsers({ orgId: A.orgId, membership: A.manager.membership })).nasUsers);
  assert.doesNotMatch(users, /credential/);
  assert.equal((await getAppliance({ orgId: A.orgId, applianceId: String(appA._id), membership: A.manager.membership })).appliance.adminCredential, undefined);
});

test("replay protection: a repeated Idempotency-Key returns the recorded response and never repeats the action", async () => {
  const { POST: createSnap } = await import("../src/app/api/orgs/nas/shares/[shareId]/snapshots/route.js");
  const share = await newShare(A, appA, mgrA, "replay", { "a.txt": "a" });
  const p = { params: Promise.resolve({ shareId: share.shareId }) };
  const body = { orgId: A.orgId, name: "replayed-snap" };
  const key = "replay-key-" + fx.RUN;
  const first = await createSnap(req(`/api/orgs/nas/shares/${share.shareId}/snapshots`, { method: "POST", token: tokens.mgrA, body, headers: { "idempotency-key": key } }), p);
  assert.equal(first.status, 201);
  const second = await createSnap(req(`/api/orgs/nas/shares/${share.shareId}/snapshots`, { method: "POST", token: tokens.mgrA, body, headers: { "idempotency-key": key } }), p);
  assert.equal(second.status, 201, "replayed response, not a 409 conflict from creating the snapshot twice");
  assert.equal((await second.json()).replayed, true);
  assert.equal(await fx.collections.nasSnapshots.countDocuments({ shareId: share.share._id }), 1, "exactly one snapshot");
  const other = await createSnap(req(`/api/orgs/nas/shares/${share.shareId}/snapshots`, { method: "POST", token: tokens.mgrA, body: { orgId: A.orgId, name: "different" }, headers: { "idempotency-key": key } }), { params: Promise.resolve({ shareId: share.shareId }) });
  assert.equal(other.status, 201, "same key, same path: still the recorded response");
  const { POST: other2 } = await import("../src/app/api/orgs/nas/shares/[shareId]/backup/route.js");
  const cross = await other2(req(`/api/orgs/nas/shares/${share.shareId}/backup`, { method: "POST", token: tokens.mgrA, body: { orgId: A.orgId }, headers: { "idempotency-key": key } }), p);
  assert.equal(cross.status, 409, "the key cannot be reused for a different request");
  const short = await createSnap(req(`/x`, { method: "POST", token: tokens.mgrA, body, headers: { "idempotency-key": "short" } }), p);
  assert.equal(short.status, 400);
});

test("API rate limiting: a burst of writes from one user is throttled with 429", async () => {
  const { PUT: setPolicy } = await import("../src/app/api/orgs/nas/shares/[shareId]/snapshot-policy/route.js");
  const share = await newShare(A, appA, mgrA, "rate");
  const p = { params: Promise.resolve({ shareId: share.shareId }) };
  const statuses = [];
  for (let i = 0; i < 100; i++) statuses.push((await setPolicy(req(`/x`, { method: "PUT", token: tokens.staffA, body: { orgId: A.orgId, intervalMinutes: 60 } }), p)).status);
  assert.ok(statuses.includes(429), "the 91st write in the window is rate limited");
  assert.ok(statuses.filter((s) => s === 403).length >= 1, "and before that, staff writes were simply forbidden");
});

test("permission boundary: every consequential library function refuses NAS staff and outsiders (fail closed)", async () => {
  const s = await newShare(A, appA, mgrA, "gate", { "a.txt": "a" });
  const snap = await createSnapshot({ ...M(A), shareId: s.shareId, name: "g1", immutable: true, retentionDays: 1 });
  const run1 = await runBackup({ orgId: A.orgId, shareId: s.shareId, verify: "sample", actorEmail: "sys" });
  const staff = { orgId: A.orgId, membership: A.staff.membership, actorEmail: A.staff.email };
  const out = { orgId: A.orgId, membership: A.outsider.membership, actorEmail: A.outsider.email };
  for (const [who, ctx] of [["staff", staff], ["outsider", out]]) {
    const calls = {
      createShare: () => createShare({ ...ctx, applianceId: String(appA._id), shareName: fx.tag("z"), ownerUnixUser: mgrA.unix }),
      deleteShare: () => deleteShare({ ...ctx, shareId: s.shareId }),
      setAccess: () => setShareAccess({ ...ctx, shareId: s.shareId, entries: [] }),
      createSnapshot: () => createSnapshot({ ...ctx, shareId: s.shareId }),
      deleteSnapshot: () => deleteSnapshot({ ...ctx, snapshotId: String(snap.snapshot._id) }),
      restoreSnapshot: () => restoreSnapshot({ ...ctx, snapshotId: String(snap.snapshot._id) }),
      setWorm: () => setWormPolicy({ ...ctx, shareId: s.shareId }),
      backup: () => backupShareToInaya({ ...ctx, shareId: s.shareId }),
      restoreBackup: () => restoreFromBackup({ ...ctx, shareId: s.shareId, runId: String(run1.runId) }),
      backupPolicy: () => setBackupPolicy({ ...ctx, shareId: s.shareId }),
      cloudTarget: () => createCloudTarget({ ...ctx, kind: "s3-compatible", label: "x", endpoint: "https://s3.filebase.com", bucket: "bucket-x", accessKeyId: "k", secretAccessKey: "s" }),
      remoteAccess: () => setRemoteAccess({ ...ctx, applianceId: String(appA._id), mode: "LOCAL_ONLY" }),
      update: () => applyUpdate({ ...ctx, applianceId: String(appA._id) }),
      pool: () => createPool({ ...ctx, applianceId: String(appA._id), name: "zz" }),
      nfs: () => setNfsExport({ ...ctx, shareId: s.shareId, clients: ["127.0.0.1"] }),
      provision: () => provisionNasUser({ ...ctx, applianceId: String(appA._id), memberEmail: A.owner.email }),
    };
    for (const [name, fn] of Object.entries(calls)) assert.equal((await fn()).status, 403, `${who} must not be able to ${name}`);
  }
  assert.ok(await fx.agent.call("stat_path", { share: s.shareName, relPath: "a.txt" }), "nothing was changed by the refused calls");
});

test("tenant isolation: organization B cannot touch, read, restore or replicate anything of organization A", async () => {
  const s = await newShare(A, appA, mgrA, "iso", { "secret.txt": "A's data" });
  const snap = await createSnapshot({ ...M(A), shareId: s.shareId, name: "iso-snap", immutable: true, retentionDays: 1 });
  const run1 = await runBackup({ orgId: A.orgId, shareId: s.shareId, verify: "sample", actorEmail: "sys" });
  const mB = M(B);
  assert.equal((await createSnapshot({ ...mB, shareId: s.shareId })).status, 404, "snapshot of A's share");
  assert.equal((await deleteSnapshot({ ...mB, snapshotId: String(snap.snapshot._id) })).status, 404);
  assert.equal((await restoreSnapshot({ ...mB, snapshotId: String(snap.snapshot._id) })).status, 404);
  assert.equal((await restoreFromBackup({ ...mB, shareId: s.shareId, runId: String(run1.runId) })).status, 404, "unauthorized restore of A's backup");
  assert.equal((await backupShareToInaya({ ...mB, shareId: s.shareId })).status, 404);
  assert.equal((await setShareAccess({ ...mB, shareId: s.shareId, entries: [] })).status, 404);
  assert.equal((await deleteShare({ ...mB, shareId: s.shareId })).status, 404);
  assert.equal((await setWormPolicy({ ...mB, shareId: s.shareId })).status, 404);
  assert.equal((await scanShare({ orgId: B.orgId, shareId: s.shareId })).status, 404);
  const own = await newShare(B, appB, mgrB, "isob", { "b.txt": "B" });
  const own2 = await runBackup({ orgId: B.orgId, shareId: own.shareId, verify: "sample", actorEmail: "sys" });
  assert.equal((await restoreFromBackup({ ...M(A), shareId: s.shareId, runId: String(own2.runId) })).status, 404, "a run id of B used on A's share");
  const alt = await restoreFromBackup({ ...M(A), shareId: s.shareId, runId: String(run1.runId), target: "alternate", alternateShareId: own.shareId });
  assert.equal(alt.status, 404, "restoring INTO another organization's share is impossible");
  assert.equal((await fx.agent.readFile({ shareName: s.shareName, relativePath: "secret.txt" })).toString(), "A's data");
  const ev = await fx.collections.nasEvidence.countDocuments({ orgId: (await fx.collections.orgs.findOne({ name: `nas-${fx.RUN}-secb` }))._id, subjectId: s.share._id });
  assert.equal(ev, 0, "B has no evidence rows about A's share");
});

test("path traversal, symlink escape and malicious names never reach outside a share (agent, SMB and control plane)", async (t) => {
  const s = await newShare(A, appA, mgrA, "trav", { "ok.txt": "fine" });
  const outside = `/root/outside-${fx.RUN}.txt`;
  await run(["sh", "-c", `echo TOPSECRET > ${outside}`]);
  await t.test("every path-taking agent operation rejects traversal", async () => {
    const bad = ["../../etc/passwd", "a/../../etc/passwd", "/../etc/passwd", "x/..", "..", "a\0b", "a\nb", "a\tb"];
    for (const rel of bad) {
      for (const op of ["get_file", "delete_file", "put_file", "stat_path", "acl_get", "acl_apply", "recycle_restore", "recycle_purge"]) {
        const params = { share: s.shareName, relPath: rel, recyclePath: rel, srcPath: "/mnt/c/Users/x/inaya-nas-00000000.bin", dstPath: "/mnt/c/Users/x/inaya-nas-00000000.bin", entries: [{ type: "user", name: mgrA.unix, perms: "r--" }] };
        await assert.rejects(() => fx.agent.call(op, params), /Path traversal|Control characters|Invalid relative path|Transfer path|not an approved/i, `${op} accepted ${JSON.stringify(rel)}`);
      }
    }
    await assert.rejects(() => fx.agent.readFile({ shareName: s.shareName, relativePath: "../../etc/passwd" }), /Path traversal/);
    await assert.rejects(() => fx.agent.call("get_file", { share: s.shareName, relPath: "ok.txt", dstPath: "/etc/cron.d/evil" }), /approved Inaya temp file/, "output paths are restricted too");
  });
  await t.test("a symlink planted inside the share cannot be followed out of it", async () => {
    await fx.agent.call("make_symlink", { share: s.shareName, relPath: "escape", target: "/root" });
    await fx.agent.call("make_symlink", { share: s.shareName, relPath: "leak.txt", target: outside });
    assert.equal((await fx.agent.call("stat_path", { share: s.shareName, relPath: "leak.txt" })).escapesShare, true);
    await assert.rejects(() => fx.agent.readFile({ shareName: s.shareName, relativePath: "leak.txt" }), /escapes its share|Path traversal|symlink/i);
    await assert.rejects(() => fx.agent.readFile({ shareName: s.shareName, relativePath: `escape/outside-${fx.RUN}.txt` }), /escapes its share|symlink/i);
    await assert.rejects(() => fx.agent.writeFile({ shareName: s.shareName, relativePath: `escape/planted-${fx.RUN}.txt`, buffer: Buffer.from("x") }), /escapes its share|symlink/i);
    assert.equal((await run(["test", "-e", `/root/planted-${fx.RUN}.txt`])).ok, false, "nothing was written outside the share");
    await assert.rejects(() => fx.agent.call("delete_file", { share: s.shareName, relPath: `escape/outside-${fx.RUN}.txt` }), /escapes its share|symlink/i);
    assert.equal((await run(["cat", outside])).out.trim(), "TOPSECRET", "the file outside the share is intact");
    const man = await fx.agent.call("manifest", { share: s.shareName, includeLines: true });
    assert.ok(!man.lines.some((l) => l.startsWith("leak.txt")), "symlinks are never followed into backups");
  });
  await t.test("a real SMB client cannot follow the symlink or use .. either", async () => {
    assert.ok(!(await setShareAccess({ ...M(A), shareId: s.shareId, entries: [{ principalType: "user", principalId: String(mgrA.nasUser._id), level: "write" }] })).error);
    const viaLink = await fx.smb(s.shareName, mgrA.unix, mgrA.password, `get leak.txt /root/got-leak-${fx.RUN}.txt`);
    assert.equal((await run(["test", "-e", `/root/got-leak-${fx.RUN}.txt`])).ok, false, `SMB followed a symlink out of the share: ${viaLink.out}`);
    const dots = await fx.smb(s.shareName, mgrA.unix, mgrA.password, `get ../../etc/passwd /root/got-passwd-${fx.RUN}.txt`);
    assert.equal((await run(["test", "-e", `/root/got-passwd-${fx.RUN}.txt`])).ok, false, dots.out);
  });
  await t.test("malicious names are data, never commands: shell metacharacters, quotes, unicode, spaces", async () => {
    for (const bad of ["x; rm -rf /", "$(id)", "a b", "`id`", "-rf", "x\ny", "../x", "share/../x", "", "a".repeat(80), "ünï"]) {
      const r = await createShare({ ...M(A), applianceId: String(appA._id), shareName: bad, ownerUnixUser: mgrA.unix });
      assert.equal(r.status, 400, `share name ${JSON.stringify(bad)}`);
    }
    assert.equal((await createShare({ ...M(A), applianceId: String(appA._id), shareName: fx.tag("okn"), ownerUnixUser: "root; id" })).status, 502, "a bad owner name is rejected by the appliance validator");
    const weird = "sp ace'quote\"dq$(echo pwned)`bt`;semi&amp|pipe#é.txt";
    await fx.agent.writeFile({ shareName: s.shareName, relativePath: `weird/${weird}`, buffer: Buffer.from("ok"), owner: mgrA.unix });
    assert.equal((await fx.agent.readFile({ shareName: s.shareName, relativePath: `weird/${weird}` })).toString(), "ok", "round-trips as plain data");
    const files = await fx.agent.call("list_files", { share: s.shareName });
    assert.ok(files.files.some((f) => f.relativePath === `weird/${weird}`));
    assert.equal((await run(["test", "-e", "/root/pwned"])).ok, false);
    await run(["sh", "-c", `printf x > "/srv/inaya-nas/${s.shareName}/$(printf 'nl\\nevil.txt')"`]);
    const man = await fx.agent.call("manifest", { share: s.shareName, includeLines: true });
    assert.equal(man.lines.every((l) => l.split("\t").length === 3), true, "a newline in a file name cannot forge a manifest line");
    assert.ok(man.skippedUnsafeNames >= 1, "such files are counted, not silently dropped");
  });
  await run(["rm", "-f", outside]);
});

test("stored secrets are protected: cloud credentials encrypted at rest, appliance credentials never returned", async () => {
  const t = await createCloudTarget({ ...M(A), kind: "s3-compatible", label: "enc", endpoint: "https://s3.filebase.com", bucket: "bucket-enc", accessKeyId: "AKIAEXAMPLE", secretAccessKey: "PLAINTEXT-SECRET-VALUE-123" });
  const raw = await fx.collections.nasCloudTargets.findOne({ _id: t.target._id });
  assert.doesNotMatch(JSON.stringify(raw), /PLAINTEXT-SECRET-VALUE-123/, "the secret is not stored in plaintext");
  assert.ok(raw.secretCredential.length > 40);
  const { decryptNasSecret } = await import("../src/lib/nas/credentials.js");
  assert.equal(decryptNasSecret(raw.secretCredential), "PLAINTEXT-SECRET-VALUE-123");
  const tampered = raw.secretCredential.slice(0, -4) + "AAAA";
  assert.throws(() => decryptNasSecret(tampered), undefined, "a modified ciphertext fails closed");
  assert.equal(t.target.secretCredential, undefined);
});

test("forged or altered evidence is detected: rows, audit-chain entries and the chain itself", async () => {
  const s = await newShare(A, appA, mgrA, "forge");
  await createSnapshot({ ...M(A), shareId: s.shareId, name: "f1" });
  assert.equal((await verifyNasEvidence({ orgId: A.orgId, applianceId: appA._id })).verified, true);
  const forged = await recordNasEvidence({ orgId: A.orgId, applianceId: appA._id, subjectId: s.share._id, action: "BACKUP_VERIFIED", actorEmail: "attacker", integrityHash: "f".repeat(64), graph: false });
  await fx.collections.nasEvidence.deleteOne({ _id: (await fx.collections.nasEvidence.findOne({ rowHash: forged.rowHash }))._id });
  const inserted = await fx.collections.nasEvidence.insertOne({ orgId: (await fx.collections.orgs.findOne({ name: `nas-${fx.RUN}-seca` }))._id, applianceId: appA._id, subjectType: "NAS_SHARE", subjectId: s.share._id, action: "BACKUP_VERIFIED", result: "OK", actor: { email: "attacker", type: "human" }, previousState: null, newState: null, integrityHash: "e".repeat(64), policy: null, approval: null, data: {}, createdAt: new Date().toISOString(), rowHash: "d".repeat(64) });
  const bad = await verifyNasEvidence({ orgId: A.orgId, applianceId: appA._id });
  assert.equal(bad.verified, false, "an evidence row inserted straight into the database is not believed");
  assert.ok(bad.problems.some((p) => p.problem === "ROW_ALTERED" || p.problem === "NO_AUDIT_ENTRY"));
  await fx.collections.nasEvidence.deleteOne({ _id: inserted.insertedId });
  assert.equal((await verifyNasEvidence({ orgId: A.orgId, applianceId: appA._id })).verified, true);
  const entry = await fx.collections.auditChainEntries.find({ orgId: (await fx.collections.orgs.findOne({ name: `nas-${fx.RUN}-seca` }))._id, action: "SNAPSHOT_CREATED" }).limit(1).next();
  await fx.collections.auditChainEntries.updateOne({ _id: entry._id }, { $set: { actorEmail: "someone-else@example.com" } });
  const chain = await verifyChainIntegrity(A.orgId);
  assert.equal(chain.valid, false, "a tampered audit-chain entry breaks the chain");
  assert.equal((await verifyNasEvidence({ orgId: A.orgId, applianceId: appA._id })).verified, false);
  await fx.collections.auditChainEntries.updateOne({ _id: entry._id }, { $set: { actorEmail: entry.actorEmail } });
  assert.equal((await verifyChainIntegrity(A.orgId)).valid, true, "restoring it restores verification");
});

test("mass deletion is a detected signal; snapshot-deletion attempts feed threat classification", async () => {
  const files = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`m/f${i}.txt`, `document ${i} `.repeat(100)]));
  const s = await newShare(A, appA, mgrA, "mass", files);
  await setBaseline({ ...M(A), shareId: s.shareId });
  for (let i = 0; i < 13; i++) await fx.agent.call("delete_file", { share: s.shareName, relPath: `m/f${i}.txt` });
  const r = await scanShare({ orgId: A.orgId, shareId: s.shareId, respond: false });
  assert.ok(["MEDIUM", "HIGH", "CRITICAL"].includes(r.level), `mass deletion classified as ${r.level}`);
  assert.ok(r.reasons.some((x) => /deleted/.test(x)));
  const snap = await createSnapshot({ ...M(A), shareId: s.shareId, name: "guard", immutable: true, retentionDays: 1 });
  await deleteSnapshot({ ...M(A), snapshotId: String(snap.snapshot._id) });
  await deleteSnapshot({ ...M(A), snapshotId: String(snap.snapshot._id) });
  const r2 = await scanShare({ orgId: A.orgId, shareId: s.shareId, respond: false });
  assert.ok(r2.signals.snapshotDeleteAttempts >= 2, "attempts to delete a protected snapshot are counted as a signal");
});

test("a corrupted disk block is DETECTED by Btrfs checksums (scrub) and reported, never served silently", async () => {
  const name = fx.tag("cor");
  const pool = await createPool({ ...M(A), applianceId: String(appA._id), name, level: "single", memberSizeMb: 128 });
  fx.created.pools.add(name);
  const sh = fx.tag("corsh");
  fx.created.shares.add(sh);
  const cs = await createShare({ ...M(A), applianceId: String(appA._id), shareName: sh, ownerUnixUser: mgrA.unix, backend: "btrfs", poolId: String(pool.pool._id) });
  assert.ok(!cs.error, cs.error);
  const marker = "INAYA-CORRUPTION-MARKER-" + fx.RUN + "-";
  await fx.agent.writeFile({ shareName: sh, relativePath: "victim.bin", buffer: Buffer.from(marker.repeat(4000)), owner: mgrA.unix });
  await run(["sync"]);
  const py = "import sys;img=open(sys.argv[1],'r+b');d=img.read();m=sys.argv[2].encode();i=d.find(m);print(i);img.seek(i+8);img.write(b'X'*40);img.flush()";
  const hit = await run(["python3", "-c", py, `/var/lib/inaya-nas/pools/${name}/disk0.img`, marker]);
  assert.ok(Number(hit.out.trim()) > 0, `marker found in the disk image: ${hit.out}`);
  await run(["sh", "-c", "echo 3 > /proc/sys/vm/drop_caches"]);
  const scrub = await fx.agent.call("pool_scrub", { pool: name }, { timeout: 300000 });
  assert.ok(scrub.csumErrors >= 1 || scrub.uncorrectableErrors >= 1, `scrub must notice: ${JSON.stringify(scrub)}`);
  await assert.rejects(() => fx.agent.readFile({ shareName: sh, relativePath: "victim.bin" }), undefined, "reading the corrupted file fails instead of returning bad bytes");
});
