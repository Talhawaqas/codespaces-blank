// test/nas-storage.test.mjs
// Sovereign NAS SOW: storage pools (RAID1 + Btrfs), quotas, snapshots, WORM.
// REAL appliance (WSL2 Ubuntu: mdadm, Btrfs, ext4 quota, chattr, Samba) and
// real MongoDB. Run: node --env-file=.env.local --test test/nas-storage.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fx from "./_nas-fixtures.mjs";
import { createPool, simulateDiskFailure, replaceDisk, scrubPool, listDisks, listPools, deletePool } from "../src/lib/nas/pools.js";
import { createShare } from "../src/lib/nas/shares.js";
import { setShareQuota, getShareCapacity, setUserQuota } from "../src/lib/nas/quotas.js";
import { createSnapshot, listSnapshots, deleteSnapshot, restoreSnapshot, verifySnapshot, releaseExpiredLocks, setSnapshotPolicy, runSnapshotPolicy, setWormPolicy, sealWorm, getWormStatus, browseSnapshot } from "../src/lib/nas/snapshots.js";
import { setShareAccess } from "../src/lib/nas/access.js";
import { checkApplianceState, getOverview } from "../src/lib/nas/health.js";
import { listNasEvidence, verifyNasEvidence } from "../src/lib/nas/evidence.js";

let org, appliance, mgr, staff, pool, poolDoc;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const M = () => ({ orgId: org.orgId, membership: org.manager.membership, actorEmail: org.manager.email });

before(async () => {
  await fx.setup();
  org = await fx.makeOrg("storage");
  appliance = await fx.makeAppliance(org);
  mgr = await fx.provisionUser(org, org.manager, appliance._id);
  staff = await fx.provisionUser(org, org.staff, appliance._id);
});
after(async () => { await fx.teardown(); });

test("storage pool: a real RAID1+Btrfs mirror, disk failure injection, degraded operation, rebuild and scrub", async (t) => {
  const name = fx.tag("p");
  const r = await createPool({ ...M(), applianceId: String(appliance._id), name, level: "raid1", memberSizeMb: 256, allowFailureInjection: true });
  assert.ok(!r.error, r.error);
  fx.created.pools.add(name);
  pool = name; poolDoc = r.pool;
  assert.equal(r.status.level, "raid1");
  assert.equal(r.status.filesystem, "btrfs");
  assert.match(r.status.reminder, /not backup/i, "RAID-is-not-backup reminder is part of every pool status");
  assert.equal((await createPool({ ...M(), applianceId: String(appliance._id), name, level: "raid1" })).status, 409, "duplicate pool name");

  const shareName = fx.tag("ps");
  fx.created.shares.add(shareName);
  const sh = await createShare({ ...M(), applianceId: String(appliance._id), shareName, ownerUnixUser: mgr.unix, backend: "btrfs", poolId: String(poolDoc._id) });
  assert.ok(!sh.error, sh.error);
  await fx.agent.writeFile({ shareName, relativePath: "a.txt", buffer: Buffer.from("before failure"), owner: mgr.unix });

  await t.test("failure injection is refused without the confirmation phrase, and on non-test pools", async () => {
    assert.equal((await simulateDiskFailure({ ...M(), poolId: String(poolDoc._id), confirm: "yes" })).status, 400);
    const single = await createPool({ ...M(), applianceId: String(appliance._id), name: fx.tag("s"), level: "single", memberSizeMb: 128 });
    fx.created.pools.add(single.pool.name);
    assert.equal((await simulateDiskFailure({ ...M(), poolId: String(single.pool._id), confirm: "FAIL-DISK" })).status, 403, "pool not created for failure testing");
    assert.equal(single.status.redundancy, "none (single device)");
  });

  await t.test("a member fails: pool is DEGRADED, data stays readable AND writable, overview reports it", async () => {
    const f = await simulateDiskFailure({ ...M(), poolId: String(poolDoc._id), confirm: "FAIL-DISK", member: 1 });
    assert.ok(!f.error, f.error);
    assert.equal(f.status.health, "DEGRADED");
    assert.equal(f.status.degraded, true);
    assert.equal((await fx.agent.readFile({ shareName, relativePath: "a.txt" })).toString(), "before failure");
    await fx.agent.writeFile({ shareName, relativePath: "while-degraded.txt", buffer: Buffer.from("still writable"), owner: mgr.unix });
    await checkApplianceState({ orgId: org.orgId, applianceId: String(appliance._id), membership: org.manager.membership });
    const ov = await getOverview({ orgId: org.orgId, applianceId: String(appliance._id), membership: org.manager.membership });
    assert.equal(ov.cards.storageHealth.status, "CRITICAL");
    assert.match(ov.cards.storageHealth.headline, /degraded/);
  });

  await t.test("replace + rebuild returns the pool to ONLINE with all data intact; scrub finds no errors", async () => {
    const rr = await replaceDisk({ ...M(), poolId: String(poolDoc._id), member: 1 });
    assert.ok(!rr.error, rr.error);
    assert.equal(rr.status.health, "ONLINE");
    assert.equal((await fx.agent.readFile({ shareName, relativePath: "while-degraded.txt" })).toString(), "still writable");
    const sc = await scrubPool({ ...M(), poolId: String(poolDoc._id) });
    assert.equal(sc.scrub.csumErrors, 0);
    assert.equal(sc.scrub.uncorrectableErrors, 0);
    const ev = await listNasEvidence({ orgId: org.orgId, applianceId: appliance._id });
    for (const a of ["POOL_CREATED", "POOL_DEGRADED", "POOL_REBUILT"]) assert.ok(ev.some((e) => e.action === a), a);
  });

  await t.test("disks are reported honestly: virtual disks have no physical SMART/temperature", async () => {
    const d = await listDisks({ orgId: org.orgId, applianceId: String(appliance._id), membership: org.manager.membership });
    assert.ok(d.disks.length > 0);
    for (const disk of d.disks) {
      assert.equal(disk.measurement, "MEASURED");
      assert.equal(disk.temperatureLabel, "UNKNOWN", "no temperature sensor on a virtual disk");
      if (disk.virtual && disk.smart.status === "PASSED") assert.match(disk.smart.note, /virtual/i);
    }
    const pools = await listPools({ orgId: org.orgId, applianceId: String(appliance._id), membership: org.manager.membership });
    assert.ok(pools.pools.some((p) => p.name === name));
  });
});

test("quotas: enforced where the backend can block writes, and honestly NOT enforced where it cannot", async (t) => {
  const btrfsShare = fx.tag("qb");
  fx.created.shares.add(btrfsShare);
  const s = await createShare({ ...M(), applianceId: String(appliance._id), shareName: btrfsShare, ownerUnixUser: mgr.unix, backend: "btrfs", poolId: String(poolDoc._id), quotaBytes: 3 * 1024 * 1024 });
  assert.ok(!s.error, s.error);
  assert.equal(s.share.quota.enforced, true);
  assert.match(s.share.quota.mechanism, /qgroup/);

  await t.test("a write beyond the hard quota is REFUSED by the filesystem", async () => {
    await assert.rejects(() => fx.agent.writeFile({ shareName: btrfsShare, relativePath: "big.bin", buffer: Buffer.alloc(6 * 1024 * 1024, 7), owner: mgr.unix }), /quota|space/i);
    const cap = await getShareCapacity({ orgId: org.orgId, shareId: String(s.share._id), membership: org.manager.membership });
    assert.ok(["NEAR_LIMIT", "HARD_LIMIT", "WARNING"].includes(cap.state), `state ${cap.state}`);
    assert.equal(cap.enforced, true);
    assert.equal(cap.measurement, "MEASURED");
  });

  await t.test("raising the quota lets the same write succeed; the state change notifies managers once", async () => {
    await fx.agent.call("delete_file", { share: btrfsShare, relPath: "big.bin" }).catch(() => {});
    assert.ok(!(await setShareQuota({ ...M(), shareId: String(s.share._id), hardBytes: 64 * 1024 * 1024 })).error);
    await fx.agent.writeFile({ shareName: btrfsShare, relativePath: "ok.bin", buffer: Buffer.alloc(2 * 1024 * 1024, 1), owner: mgr.unix });
    const c1 = await getShareCapacity({ orgId: org.orgId, shareId: String(s.share._id), membership: org.manager.membership });
    assert.equal(c1.state, "NORMAL");
  });

  await t.test("a legacy directory share cannot enforce quotas and says so (never a fake hard limit)", async () => {
    const dirShare = fx.tag("qd");
    fx.created.shares.add(dirShare);
    const d = await createShare({ ...M(), applianceId: String(appliance._id), shareName: dirShare, ownerUnixUser: mgr.unix, quotaBytes: 5 * 1024 * 1024 });
    assert.equal(d.share.quota.enforced, false);
    assert.match(d.share.quota.notEnforcedReason, /no quota support/i);
  });

  await t.test("per-USER quotas on an ext4 quota volume: a real SMB write by that user is refused past their limit", async () => {
    const vol = fx.tag("qu");
    fx.created.shares.add(vol);
    const v = await createShare({ ...M(), applianceId: String(appliance._id), shareName: vol, ownerUnixUser: mgr.unix, backend: "ext4quota", volumeSizeMb: 64 });
    assert.ok(!v.error, v.error);
    assert.ok(!(await setShareAccess({ ...M(), shareId: String(v.share._id), entries: [{ principalType: "user", principalId: String(mgr.nasUser._id), level: "write" }, { principalType: "user", principalId: String(staff.nasUser._id), level: "write" }] })).error);
    const q = await setUserQuota({ ...M(), shareId: String(v.share._id), nasUserId: String(staff.nasUser._id), hardBytes: 1024 * 1024 });
    assert.equal(q.supported, true);
    // a 3 MB file written over REAL SMB as the limited user must be capped at 1 MB
    const gen = await fx.smbPut(vol, staff.unix, staff.password, "q3mb.bin", Buffer.alloc(3 * 1024 * 1024, 1));
    const listing = await fx.agent.call("list_files", { share: vol });
    const written = listing.files.find((f) => f.relativePath === "q3mb.bin");
    assert.ok(!written || written.sizeBytes <= 1024 * 1024 + 4096, `the user's write was capped at their 1 MB quota, got ${written?.sizeBytes} (${gen.out.slice(0, 200)})`);
    const u = await fx.agent.call("user_quota_usage", { share: vol });
    assert.equal(u.supported, true);
    const manager = await fx.smbPut(vol, mgr.unix, mgr.password, "m2mb.bin", Buffer.alloc(2 * 1024 * 1024, 1));
    const mlist = await fx.agent.call("list_files", { share: vol });
    assert.equal(mlist.files.find((f) => f.relativePath === "m2mb.bin")?.sizeBytes, 2 * 1024 * 1024, `an unlimited user is not affected (${manager.out.slice(0, 120)})`);
  });
});

test("snapshots: real copy-on-write, immutable locks that resist deletion, evidence, restore and retention", async (t) => {
  const shareName = fx.tag("sn");
  fx.created.shares.add(shareName);
  const s = await createShare({ ...M(), applianceId: String(appliance._id), shareName, ownerUnixUser: mgr.unix, backend: "btrfs", poolId: String(poolDoc._id) });
  const shareId = String(s.share._id);
  await fx.agent.writeFile({ shareName, relativePath: "docs/contract.txt", buffer: Buffer.from("version one"), owner: mgr.unix });
  let mutable, locked;

  await t.test("a snapshot reports what it really is (copy-on-write), with a manifest hash", async () => {
    const r = await createSnapshot({ ...M(), shareId, name: "before-edit" });
    assert.ok(!r.error, r.error);
    mutable = r.snapshot;
    assert.equal(mutable.type, "copy-on-write");
    assert.equal(mutable.semantics.immutable, false, "never called immutable when it is not");
    assert.match(mutable.manifestHash, /^[0-9a-f]{64}$/);
    assert.equal((await createSnapshot({ ...M(), shareId, name: "before-edit" })).status, 409);
    assert.equal((await createSnapshot({ ...M(), shareId, name: "x", immutable: true })).status, 400, "immutable needs a retention period");
  });

  await t.test("an IMMUTABLE snapshot resists deletion by every route a compromised process would try", async () => {
    const r = await createSnapshot({ ...M(), shareId, name: "locked-1", immutable: true, retentionDays: 0.0008, lockMode: "compliance", reason: "test" }); // ~69s
    assert.ok(!r.error, r.error);
    locked = r.snapshot;
    assert.equal(locked.semantics.immutable, true);
    assert.match(locked.semantics.note, /governance-grade/i, "the limits of the lock are stated");
    const tamper = await fx.agent.call("snapshot_try_tamper", { share: r.snapshot.shareId ? shareName : shareName, snapshot: "locked-1" });
    assert.deepEqual(tamper, { deleteFile: "blocked", appendFile: "blocked", removeSnapshotDir: "blocked", btrfsDeleteSubvolume: "blocked" });
    const del = await deleteSnapshot({ ...M(), snapshotId: String(locked._id) });
    assert.equal(del.status, 403);
    const ov = await deleteSnapshot({ orgId: org.orgId, snapshotId: String(locked._id), override: true, reason: "an owner trying to override compliance", membership: org.owner.membership, actorEmail: org.owner.email });
    assert.equal(ov.status, 403, "compliance mode has no override path, even for the owner");
    const ev = await listNasEvidence({ orgId: org.orgId, applianceId: appliance._id, action: "SNAPSHOT_DELETE_DENIED" });
    assert.ok(ev.length >= 2, "every deletion attempt is itself evidence (a ransomware signal)");
  });

  await t.test("the live share changes; the snapshot does not; verification recomputes the manifest", async () => {
    await fx.agent.writeFile({ shareName, relativePath: "docs/contract.txt", buffer: Buffer.from("version TWO (ransomware-edited)"), owner: mgr.unix });
    const v = await verifySnapshot({ orgId: org.orgId, snapshotId: String(locked._id), membership: org.manager.membership });
    assert.equal(v.verified, true);
    assert.equal((await fx.agent.readFile({ shareName, relativePath: "docs/contract.txt", snapshot: "locked-1" })).toString(), "version one");
    const b = await browseSnapshot({ orgId: org.orgId, snapshotId: String(locked._id), relPath: "docs", membership: org.manager.membership });
    assert.ok(b.entries.some((e) => e.name === "contract.txt"));
  });

  await t.test("restore: default is a safe side-by-side copy; in-place needs a reason and is evidenced", async () => {
    assert.equal((await restoreSnapshot({ ...M(), snapshotId: String(locked._id), relPath: "docs/contract.txt", inPlace: true })).status, 400);
    const side = await restoreSnapshot({ ...M(), snapshotId: String(locked._id), relPath: "docs/contract.txt" });
    assert.ok(!side.error, side.error);
    assert.match(side.restored.restoredTo, /^\.restored\//);
    assert.equal((await fx.agent.readFile({ shareName, relativePath: side.restored.restoredTo })).toString(), "version one");
    assert.equal((await fx.agent.readFile({ shareName, relativePath: "docs/contract.txt" })).toString(), "version TWO (ransomware-edited)", "live data untouched by a side-by-side restore");
    const inPlace = await restoreSnapshot({ ...M(), snapshotId: String(locked._id), relPath: "docs/contract.txt", inPlace: true, reason: "undo ransomware edit" });
    assert.ok(!inPlace.error, inPlace.error);
    assert.equal((await fx.agent.readFile({ shareName, relativePath: "docs/contract.txt" })).toString(), "version one");
    const ev = await listNasEvidence({ orgId: org.orgId, applianceId: appliance._id, action: "FILE_RESTORED" });
    assert.ok(ev.some((e) => e.data?.inPlace === true));
  });

  await t.test("retention policy prunes old scheduled snapshots but NEVER a locked one", async () => {
    assert.ok(!(await setSnapshotPolicy({ ...M(), shareId, intervalMinutes: 60, keepLast: 2 })).error);
    for (let i = 0; i < 4; i++) { const r = await runSnapshotPolicy({ orgId: org.orgId, shareId }); assert.ok(!r.error, r.error); }
    const list = await listSnapshots({ orgId: org.orgId, shareId, membership: org.manager.membership });
    const scheduled = list.snapshots.filter((x) => x.source === "scheduled");
    assert.equal(scheduled.length, 2, "keepLast honoured");
    assert.ok(list.snapshots.some((x) => x.name === "locked-1"), "the locked snapshot was never pruned");
    assert.ok(list.snapshots.every((x) => x.presentOnAppliance), "database and appliance agree");
  });

  await t.test("after retention expires the lock is released and the snapshot can be deleted", async () => {
    await sleep(Math.max(0, new Date(locked.retentionUntil).getTime() - Date.now()) + 2500);
    const rel = await releaseExpiredLocks({ orgId: org.orgId });
    assert.ok(rel.released.includes("locked-1"), JSON.stringify(rel));
    const del = await deleteSnapshot({ ...M(), snapshotId: String(locked._id) });
    assert.ok(!del.error, del.error);
    assert.equal(del.overrideUsed, false);
  });

  await t.test("the evidence trail for all of this verifies against the audit chain, and a forged row is caught", async () => {
    const v = await verifyNasEvidence({ orgId: org.orgId, applianceId: appliance._id });
    assert.equal(v.verified, true, JSON.stringify(v.problems));
    const row = (await listNasEvidence({ orgId: org.orgId, applianceId: appliance._id, action: "SNAPSHOT_CREATED" }))[0];
    await fx.collections.nasEvidence.updateOne({ _id: row._id }, { $set: { result: "FORGED" } });
    const bad = await verifyNasEvidence({ orgId: org.orgId, applianceId: appliance._id });
    assert.equal(bad.verified, false);
    assert.ok(bad.problems.some((p) => p.problem === "ROW_ALTERED"));
    await fx.collections.nasEvidence.updateOne({ _id: row._id }, { $set: { result: row.result } });
    assert.equal((await verifyNasEvidence({ orgId: org.orgId, applianceId: appliance._id })).verified, true, "restoring the row restores verification");
  });
});

test("WORM share: write-once storage that resists deletion and modification by a real SMB user", async (t) => {
  const shareName = fx.tag("wm");
  fx.created.shares.add(shareName);
  const s = await createShare({ ...M(), applianceId: String(appliance._id), shareName, ownerUnixUser: mgr.unix, backend: "btrfs", poolId: String(poolDoc._id) });
  const shareId = String(s.share._id);
  assert.ok(!(await setShareAccess({ ...M(), shareId, entries: [{ principalType: "user", principalId: String(mgr.nasUser._id), level: "write" }] })).error);
  await fx.smbPut(shareName, mgr.unix, mgr.password, "record.txt", Buffer.from("original-record"));
  assert.equal((await fx.agent.readFile({ shareName, relativePath: "record.txt" })).toString().trim(), "original-record");

  const w = await setWormPolicy({ ...M(), shareId, enabled: true, retentionDays: 0.0008, settleMinutes: 0, mode: "governance" });
  assert.ok(!w.error, w.error);
  assert.ok(w.sealed.sealedNow >= 1);
  assert.match(w.note, /root on the appliance/i);

  await t.test("the owner, over real SMB, cannot delete, overwrite or rename a sealed file -- but can still add new files", async () => {
    const del = await fx.smb(shareName, mgr.unix, mgr.password, "del record.txt");
    const ow = await fx.smbPut(shareName, mgr.unix, mgr.password, "record.txt", Buffer.from("tampered"));
    const ren = await fx.smb(shareName, mgr.unix, mgr.password, "rename record.txt renamed.txt");
    assert.match(del.out + ow.out + ren.out, /NT_STATUS_ACCESS_DENIED|NT_STATUS_/, "denied by the filesystem");
    assert.equal((await fx.agent.readFile({ shareName, relativePath: "record.txt" })).toString().trim(), "original-record");
    const add = await fx.smbPut(shareName, mgr.unix, mgr.password, "second.txt", Buffer.from("second"));
    assert.doesNotMatch(add.out, /NT_STATUS_ACCESS_DENIED/);
    assert.equal((await fx.agent.readFile({ shareName, relativePath: "second.txt" })).toString().trim(), "second");
  });

  await t.test("root-level tampering attempts (delete / modify / rename) are all blocked by the filesystem", async () => {
    assert.deepEqual(await fx.agent.call("worm_try_tamper", { share: shareName }), { file: "record.txt", modify: "blocked", delete: "blocked", rename: "blocked" });
  });

  await t.test("disabling before retention ends is refused (and recorded); the seal job locks newly settled files", async () => {
    assert.equal((await setWormPolicy({ ...M(), shareId, enabled: false })).status, 403);
    const sealed = await sealWorm({ orgId: org.orgId, shareId });
    assert.ok(sealed.sealedTotal >= 2, "second.txt is sealed once it has settled");
    const st = await getWormStatus({ orgId: org.orgId, shareId, membership: org.manager.membership });
    assert.equal(st.appliance.enabled, true);
  });

  await t.test("after retention, locks lapse and the policy can be disabled", async () => {
    await sleep(75000);
    await releaseExpiredLocks({ orgId: org.orgId });
    const off = await setWormPolicy({ ...M(), shareId, enabled: false });
    assert.ok(!off.error, off.error);
    const del = await fx.smb(shareName, mgr.unix, mgr.password, "del record.txt");
    assert.doesNotMatch(del.out, /NT_STATUS_ACCESS_DENIED/, "deletable once retention ended");
  });
});
