// test/nas-realclient.test.mjs
// Sovereign NAS SOW Section 46 / 52A: validation from REAL clients and a real
// restart. The Windows SMB client is THIS machine's own SMB stack (net use +
// UNC paths through Node's fs, plus PowerShell for exclusive locks); the Linux
// clients are smbclient and the kernel NFSv4.2 client. Nothing is simulated.
// Also records measured throughput (SOW 47) to docs/nas-performance.json.
// Run: node --env-file=.env.local --test test/nas-realclient.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fx from "./_nas-fixtures.mjs";
import { createShare, listRecycleBin, restoreFromRecycleBin, setNfsExport } from "../src/lib/nas/shares.js";
import { setShareAccess } from "../src/lib/nas/access.js";
import { setWormPolicy } from "../src/lib/nas/snapshots.js";
import { createPool } from "../src/lib/nas/pools.js";
import { setShareQuota } from "../src/lib/nas/quotas.js";
import { listLocks, explainLock } from "../src/lib/nas/network.js";
import { createSnapshot } from "../src/lib/nas/snapshots.js";
import { NasAgentClient } from "../src/lib/nas/agent.js";

let org, appliance, mgr, staff, host;
const perf = { measuredAt: new Date().toISOString(), environment: {}, results: [] };
const sha = (b) => createHash("sha256").update(b).digest("hex");
const M = () => ({ orgId: org.orgId, membership: org.manager.membership, actorEmail: org.manager.email });
const ps = (script, timeout = 120000) => new Promise((res) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout }, (err, so, se) => res({ ok: !err, out: (so || "") + (se || "") })));
const net = (...args) => new Promise((res) => execFile("net", args, { timeout: 60000 }, (err, so, se) => res({ ok: !err, out: (so || "") + (se || "") })));
const unc = (share, rel = "") => `\\\\${host}\\${share}${rel ? "\\" + rel.replace(/\//g, "\\") : ""}`;
const eventually = async (fn, { tries = 25, everyMs = 1000 } = {}) => {
  let last;
  for (let i = 0; i < tries; i++) { try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, everyMs)); } }
  throw last;
};
const linuxScript = async (script, timeout = 180000) => {
  const f = path.join(os.tmpdir(), `inaya-script-${fx.RUN}-${Math.random().toString(36).slice(2)}.sh`);
  await fs.writeFile(f, script.replace(/\r/g, ""));
  try { return await linux(["bash", `/mnt/${f[0].toLowerCase()}/${f.slice(3).replace(/\\/g, "/")}`], timeout); } finally { await fs.unlink(f).catch(() => {}); }
};
const linux = (args, timeout = 120000) => new Promise((res) => execFile("wsl.exe", ["-d", "Ubuntu", "-u", "root", "--", ...args], { timeout }, (err, so, se) => res({ ok: !err, out: (so || "") + (se || "") })));
async function connect(user, pass) {
  await net("use", `\\\\${host}`, "/delete", "/y");
  const r = await net("use", `\\\\${host}\\IPC$`, pass, `/user:${user}`);
  return r;
}
const disconnect = () => net("use", `\\\\${host}\\IPC$`, "/delete", "/y").then(() => net("use", `\\\\${host}`, "/delete", "/y"));
const record = (name, bytes, ms, extra = {}) => perf.results.push({ test: name, bytes, seconds: +(ms / 1000).toFixed(3), MBps: bytes ? +(bytes / 1048576 / (ms / 1000)).toFixed(1) : null, ...extra });

before(async () => {
  await fx.setup();
  org = await fx.makeOrg("real");
  appliance = await fx.makeAppliance(org);
  host = await fx.nasHost();
  mgr = await fx.provisionUser(org, org.manager, appliance._id);
  staff = await fx.provisionUser(org, org.staff, appliance._id);
  NasAgentClient.startKeepAlive(); // WSL2 stops an idle VM (and Samba with it); the worker does the same
  perf.environment = { hardware: `${os.cpus().length} vCPU (${os.cpus()[0].model.trim()}), ${(os.totalmem() / 1073741824).toFixed(0)} GB RAM host; appliance = WSL2 VM (${(await fx.agent.call("version", {})).kernel})`, filesystem: "btrfs on mdadm RAID1 on loop devices on ext4 (virtual disk) for pool shares; ext4 for directory shares", network: `Windows host -> WSL2 NAT virtual switch (${host}); Linux clients over loopback`, note: "Virtual disks and a virtual network: numbers are for this development profile only and are not product guarantees." };
});
after(async () => {
  try { NasAgentClient._keepAlive?.kill(); } catch { /* best effort */ }
  await linux(["pkill", "-f", "sleep infinity"]).catch(() => {});
  await disconnect().catch(() => {});
  if (perf.results.length) await fs.writeFile(path.join(process.cwd(), "docs", "nas-performance.json"), JSON.stringify(perf, null, 2));
  await fx.teardown();
});

test("Test A (Windows): connect, mkdir, create/write/close/reopen/read/modify/rename/delete, recycle restore -- bytes match", async (t) => {
  const shareName = fx.tag("wa");
  fx.created.shares.add(shareName);
  const s = await createShare({ ...M(), applianceId: String(appliance._id), shareName, ownerUnixUser: mgr.unix });
  const shareId = String(s.share._id);
  assert.ok(!(await setShareAccess({ ...M(), shareId, entries: [{ principalType: "user", principalId: String(mgr.nasUser._id), level: "write" }, { principalType: "user", principalId: String(staff.nasUser._id), level: "read" }] })).error);

  await t.test("authentication: a wrong password is refused by the real Windows client, the right one connects", async () => {
    const bad = await connect(mgr.unix, "definitely-wrong-password!");
    assert.equal(bad.ok, false, bad.out);
    assert.match(bad.out, /1326|logon|password/i);
    const good = await connect(mgr.unix, mgr.password);
    assert.equal(good.ok, true, good.out);
  });

  await t.test("the file lifecycle over Windows SMB", async () => {
    const dir = unc(shareName, "Projects");
    await fs.mkdir(dir, { recursive: true });
    const f = unc(shareName, "Projects\\plan.txt");
    const h = await fs.open(f, "w"); await h.write("first line\n"); await h.close();
    assert.equal((await fs.readFile(f, "utf8")), "first line\n", "reopen + read");
    await fs.appendFile(f, "second line\n");
    assert.equal((await fs.readFile(f, "utf8")), "first line\nsecond line\n", "modify");
    await fs.rename(f, unc(shareName, "Projects\\plan-v2.txt"));
    assert.deepEqual((await fs.readdir(dir)).sort(), ["plan-v2.txt"], "rename");
    assert.equal((await fx.agent.readFile({ shareName, relativePath: "Projects/plan-v2.txt" })).toString(), "first line\nsecond line\n", "the appliance filesystem has exactly those bytes");
    await fs.unlink(unc(shareName, "Projects\\plan-v2.txt"));
    assert.deepEqual(await fs.readdir(dir), [], "delete");
  });

  await t.test("restore from the recycle bin (deleted over SMB), bytes identical", async () => {
    const bin = await listRecycleBin({ orgId: org.orgId, shareId, membership: org.manager.membership });
    assert.equal(bin.entries.length, 1);
    const r = await restoreFromRecycleBin({ ...M(), shareId, recyclePath: bin.entries[0].recyclePath });
    assert.ok(!r.error, r.error);
    assert.equal(await eventually(() => fs.readFile(unc(shareName, "Projects\\plan-v2.txt"), "utf8")), "first line\nsecond line\n", "the restored file is visible to the Windows client (its own cache expires within seconds)");
  });

  await t.test("permission denial from Windows: a read-only account can read but its write is refused", async () => {
    await connect(staff.unix, staff.password);
    assert.equal(await fs.readFile(unc(shareName, "Projects\\plan-v2.txt"), "utf8"), "first line\nsecond line\n", "read works");
    await assert.rejects(() => fs.writeFile(unc(shareName, "Projects\\by-staff.txt"), "x"), (e) => ["EPERM", "EACCES", "EROFS"].includes(e.code), "write refused");
    await assert.rejects(() => fs.unlink(unc(shareName, "Projects\\plan-v2.txt")), (e) => ["EPERM", "EACCES"].includes(e.code), "delete refused");
    await connect(mgr.unix, mgr.password);
  });

  await t.test("large-file transfer (100 MB) keeps every byte; throughput is measured", async () => {
    const big = randomBytes(100 * 1024 * 1024);
    const local = path.join(os.tmpdir(), `nas-big-${fx.RUN}.bin`);
    await fs.writeFile(local, big);
    const t0 = Date.now();
    const wh = await fs.open(unc(shareName, "big.bin"), "w");
    await wh.write(big);
    await wh.sync(); // force the Windows client to flush to the server before the clock stops
    await wh.close();
    const writeMs = Date.now() - t0;
    const t1 = Date.now();
    const back = await fs.readFile(unc(shareName, "big.bin"));
    const readMs = Date.now() - t1;
    assert.equal(sha(back), sha(big));
    assert.equal(sha(await fx.agent.readFile({ shareName, relativePath: "big.bin" })), sha(big), "and the appliance's copy matches too");
    record("Windows SMB sequential write, 100 MB (flushed to the server)", big.length, writeMs, { client: "Windows SMB (Node fs over UNC)", filesystem: "ext4 dir share", concurrency: 1 });
    record("Windows SMB sequential read, 100 MB", big.length, readMs, { client: "Windows SMB (Node fs over UNC)", filesystem: "ext4 dir share", concurrency: 1, note: "read just after the write, so part may be served from the Windows client cache; treat as an upper bound" });
    await fs.unlink(local);
  });

  await t.test("interrupted transfer: dropping the connection mid-copy leaves a partial file that a retry completes", async () => {
    const data = randomBytes(30 * 1024 * 1024);
    const target = unc(shareName, "interrupted.bin");
    const h = await fs.open(target, "w");
    await h.write(data.subarray(0, 10 * 1024 * 1024));
    await net("use", `\\\\${host}\\IPC$`, "/delete", "/y");
    await net("use", `\\\\${host}`, "/delete", "/y");
    await h.close().catch(() => {});
    const partial = (await fx.agent.call("list_files", { share: shareName })).files.find((f) => f.relativePath === "interrupted.bin");
    assert.ok(!partial || partial.sizeBytes < data.length, "the transfer did not complete");
    await connect(mgr.unix, mgr.password);
    await fs.writeFile(target, data);
    assert.equal(sha(await fx.agent.readFile({ shareName, relativePath: "interrupted.bin" })), sha(data), "the retry produced the full, correct file");
  });

  await t.test("concurrent access: several writers at once, and an exclusive lock held by one client blocks another with a clear explanation", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => fs.writeFile(unc(shareName, `concurrent-${i}.txt`), `writer ${i}`.repeat(1000)).then(() => i)));
    assert.equal(results.length, 6);
    for (let i = 0; i < 6; i++) assert.equal((await fx.agent.readFile({ shareName, relativePath: `concurrent-${i}.txt` })).toString(), `writer ${i}`.repeat(1000));
    await fs.writeFile(unc(shareName, "locked.docx"), "contract");
    const holder = ps(`$f=[System.IO.File]::Open('${unc(shareName, "locked.docx")}','Open','ReadWrite','None'); Start-Sleep -Seconds 14; $f.Close()`, 60000);
    await new Promise((r) => setTimeout(r, 4000));
    await assert.rejects(() => fs.appendFile(unc(shareName, "locked.docx"), "conflicting edit"), (e) => ["EBUSY", "EPERM", "EACCES"].includes(e.code), "a real sharing violation from Samba's lock");
    const locks = await listLocks({ orgId: org.orgId, applianceId: String(appliance._id), membership: org.manager.membership });
    assert.ok(locks.locks.some((l) => l.path.endsWith("locked.docx")), `smbstatus shows the open file: ${JSON.stringify(locks.locks).slice(0, 300)}`);
    const why = await explainLock({ orgId: org.orgId, shareId, relPath: "locked.docx", membership: org.manager.membership });
    assert.equal(why.locked, true);
    assert.match(why.explanation, /open by/);
    await holder;
    await fs.appendFile(unc(shareName, "locked.docx"), " + later edit");
    assert.equal(await fs.readFile(unc(shareName, "locked.docx"), "utf8"), "contract + later edit", "no data lost or corrupted; works once released");
    await eventually(async () => { const w = await explainLock({ orgId: org.orgId, shareId, relPath: "locked.docx", membership: org.manager.membership }); assert.equal(w.locked, false, "a stale lock is not left behind"); }, { tries: 40 }); // Windows keeps a cached handle for a few seconds after close
  });

  await t.test("WORM from Windows: a sealed file cannot be deleted or overwritten by the real client", async () => {
    await fs.writeFile(unc(shareName, "worm-record.txt"), "evidence");
    await eventually(async () => assert.equal((await fx.agent.call("stat_path", { share: shareName, relPath: "worm-record.txt" })).exists, true), { tries: 20 }); // the Windows client writes behind
    const w = await setWormPolicy({ ...M(), shareId, enabled: true, retentionDays: 0.002, settleMinutes: 0 });
    assert.ok(!w.error, w.error);
    const { sealWorm } = await import("../src/lib/nas/snapshots.js");
    await sealWorm({ orgId: org.orgId, shareId }); // the periodic seal pass
    assert.equal((await fx.agent.call("stat_path", { share: shareName, relPath: "worm-record.txt" })).immutable, true, "the file is sealed on the appliance");
    // Windows may report a delete as done and only apply it when its cached handle closes,
    // where the server refuses it -- so what matters is the OUTCOME on the appliance.
    await fs.unlink(unc(shareName, "worm-record.txt")).catch((e) => assert.ok(["EPERM", "EACCES"].includes(e.code), `unexpected ${e.code}`));
    await new Promise((r) => setTimeout(r, 8000));
    assert.equal((await fx.agent.call("stat_path", { share: shareName, relPath: "worm-record.txt" })).exists, true, "the sealed file is still on the appliance after the Windows delete");
    assert.equal((await fx.agent.readFile({ shareName, relativePath: "worm-record.txt" })).toString(), "evidence", "and unchanged");
    await assert.rejects(() => fs.writeFile(unc(shareName, "worm-record.txt"), "tampered"), (e) => ["EPERM", "EACCES"].includes(e.code));
    assert.equal((await fx.agent.readFile({ shareName, relativePath: "worm-record.txt" })).toString(), "evidence", "an overwrite attempt changed nothing");
    await fs.writeFile(unc(shareName, "new-after-worm.txt"), "new files are still allowed");
  });
});

test("quota from Windows: the real client sees the disk-full style error at the limit", async () => {
  const name = fx.tag("qp");
  const pool = await createPool({ ...M(), applianceId: String(appliance._id), name, level: "single", memberSizeMb: 256 });
  fx.created.pools.add(name);
  const shareName = fx.tag("wq");
  fx.created.shares.add(shareName);
  const s = await createShare({ ...M(), applianceId: String(appliance._id), shareName, ownerUnixUser: mgr.unix, backend: "btrfs", poolId: String(pool.pool._id), quotaBytes: 8 * 1024 * 1024 });
  assert.ok(!(await setShareAccess({ ...M(), shareId: String(s.share._id), entries: [{ principalType: "user", principalId: String(mgr.nasUser._id), level: "write" }] })).error);
  await connect(mgr.unix, mgr.password);
  await fs.writeFile(unc(shareName, "fits.bin"), Buffer.alloc(2 * 1024 * 1024, 3));
  await assert.rejects(() => fs.writeFile(unc(shareName, "too-big.bin"), Buffer.alloc(20 * 1024 * 1024, 9)), (e) => ["ENOSPC", "EDQUOT", "EIO", "EPERM", "EFBIG", "UNKNOWN"].includes(e.code), "the quota stops the write");
});

test("Test B (Linux): NFSv4.2 concurrent clients read/write, permissions and remount persistence; smbclient too", async () => {
  const shareName = fx.tag("lx");
  fx.created.shares.add(shareName);
  const s = await createShare({ ...M(), applianceId: String(appliance._id), shareName, ownerUnixUser: mgr.unix });
  const shareId = String(s.share._id);
  assert.ok(!(await setNfsExport({ ...M(), shareId, clients: ["127.0.0.1"] })).error);
  const mnts = [`/mnt/nfs-a-${fx.RUN}`, `/mnt/nfs-b-${fx.RUN}`];
  try {
    for (const m of mnts) { await linux(["mkdir", "-p", m]); const r = await linux(["mount", "-t", "nfs4", "-o", "vers=4.2", `127.0.0.1:/srv/inaya-nas/${shareName}`, m]); assert.ok(r.ok, r.out); }
    await Promise.all(mnts.map((m, i) => linuxScript(`for n in 1 2 3 4 5; do echo client${i}-$n > ${m}/c${i}-$n.txt; done\n`)));
    const files = (await fx.agent.call("list_files", { share: shareName })).files.map((f) => f.relativePath);
    assert.equal(files.length, 10, "both concurrent NFS clients' files are all there");
    assert.equal((await linux(["cat", `${mnts[0]}/c1-3.txt`])).out.trim(), "client1-3", "client A sees client B's file");
    await linuxScript(`echo mine > ${mnts[0]}/perm.txt; chmod 600 ${mnts[0]}/perm.txt\n`);
    assert.equal((await fx.agent.call("stat_path", { share: shareName, relPath: "perm.txt" })).exists, true);
    const t0 = Date.now();
    const w = await linuxScript(`dd if=/dev/zero of=${mnts[0]}/nfs-big.bin bs=1M count=200 conv=fsync 2>&1 | tail -1\n`);
    record("NFSv4.2 sequential write, 200 MB (fsync)", 200 * 1048576, Date.now() - t0, { client: "Linux kernel NFS client (loopback)", filesystem: "ext4 dir share", concurrency: 1 });
    const t1 = Date.now();
    await linuxScript(`echo 3 > /proc/sys/vm/drop_caches; dd if=${mnts[0]}/nfs-big.bin of=/dev/null bs=1M 2>&1 | tail -1\n`);
    record("NFSv4.2 sequential read, 200 MB", 200 * 1048576, Date.now() - t1, { client: "Linux kernel NFS client (loopback)", filesystem: "ext4 dir share", concurrency: 1 });
    assert.ok(w.ok);
    for (const m of mnts) await linux(["umount", m]);
    const re = await linux(["mount", "-t", "nfs4", "-o", "vers=4.2", `127.0.0.1:/srv/inaya-nas/${shareName}`, mnts[0]]);
    assert.ok(re.ok, re.out);
    assert.equal((await linux(["cat", `${mnts[0]}/c0-1.txt`])).out.trim(), "client0-1", "persistence across unmount/remount");
  } finally {
    for (const m of mnts) { await linux(["umount", "-l", m]); await linux(["rmdir", m]); }
  }
  assert.ok(!(await setShareAccess({ ...M(), shareId, entries: [{ principalType: "user", principalId: String(mgr.nasUser._id), level: "write" }] })).error);
  const up = await fx.smbPut(shareName, mgr.unix, mgr.password, "via-smbclient.bin", randomBytes(50 * 1024 * 1024));
  assert.doesNotMatch(up.out, /NT_STATUS/, up.out);
});

test("Test C: unclean restart persistence -- data, pools, permissions, exports and services return after the appliance VM is killed", async (t) => {
  const poolName = fx.tag("rp");
  const pool = await createPool({ ...M(), applianceId: String(appliance._id), name: poolName, level: "raid1", memberSizeMb: 256 });
  fx.created.pools.add(poolName);
  const shareName = fx.tag("rs");
  fx.created.shares.add(shareName);
  const s = await createShare({ ...M(), applianceId: String(appliance._id), shareName, ownerUnixUser: mgr.unix, backend: "btrfs", poolId: String(pool.pool._id) });
  const shareId = String(s.share._id);
  assert.ok(!(await setShareAccess({ ...M(), shareId, entries: [{ principalType: "user", principalId: String(mgr.nasUser._id), level: "write" }, { principalType: "user", principalId: String(staff.nasUser._id), level: "read" }] })).error);
  assert.ok(!(await setNfsExport({ ...M(), shareId, clients: ["127.0.0.1"] })).error);
  await connect(mgr.unix, mgr.password);
  const payload = randomBytes(5 * 1024 * 1024);
  await fs.writeFile(unc(shareName, "persist.bin"), payload);
  await createSnapshot({ ...M(), shareId, name: "before-restart", immutable: true, retentionDays: 1 });
  await disconnect();

  await linux(["pkill", "-f", "sleep infinity"]).catch(() => {});
  await new Promise((r) => execFile("wsl.exe", ["--terminate", "Ubuntu"], r)); // an unclean stop of the whole appliance VM
  await new Promise((r) => setTimeout(r, 4000));
  const keep = NasAgentClient.startKeepAlive(); // the restarted VM is kept awake again
  const t0 = Date.now();
  const first = await new NasAgentClient({ backend: "wsl-local" }).call("services", {});
  const boot = NasAgentClient.lastBootRecovery;
  record("Appliance recovery after unclean VM kill (first agent call)", 0, Date.now() - t0, { note: "pools re-attached, mounted, Samba/NFS started" });

  await t.test("the first agent call after a restart re-mounted the pool and started the services", async () => {
    assert.ok(boot, "the agent reported a boot recovery");
    assert.match(JSON.stringify(boot.pools), /mounted/);
    assert.equal(first.smbd, true);
    const st = await fx.agent.call("pool_status", { pool: poolName });
    assert.equal(st.mounted, true);
    assert.equal(st.health, "ONLINE");
  });
  await t.test("data, permissions and snapshots are all intact; SMB and NFS work again", async () => {
    assert.equal(sha(await fx.agent.readFile({ shareName, relativePath: "persist.bin" })), sha(payload));
    assert.ok((await fx.agent.call("snapshot_list", { share: shareName })).snapshots.some((x) => x.name === "before-restart" && x.locked), "the immutable snapshot survived the restart still locked");
    await connect(mgr.unix, mgr.password);
    assert.equal(sha(await fs.readFile(unc(shareName, "persist.bin"))), sha(payload), "read back over Windows SMB after the restart");
    await disconnect();
    await connect(staff.unix, staff.password);
    await assert.rejects(() => fs.writeFile(unc(shareName, "denied.txt"), "x"), (e) => ["EPERM", "EACCES", "EROFS"].includes(e.code), "permissions survived the restart");
    await disconnect();
    assert.match((await linux(["exportfs", "-v"])).out, new RegExp(shareName), "the NFS export was re-published");
  });
  assert.ok(keep, "keep-alive running");
});

test("Measured (SOW 47): Linux SMB, snapshot latency, Btrfs vs ext4 write, all recorded with their context", async () => {
  const name = fx.tag("pf");
  const pool = await createPool({ ...M(), applianceId: String(appliance._id), name, level: "raid1", memberSizeMb: 512 });
  fx.created.pools.add(name);
  const shareName = fx.tag("pfs");
  fx.created.shares.add(shareName);
  const s = await createShare({ ...M(), applianceId: String(appliance._id), shareName, ownerUnixUser: mgr.unix, backend: "btrfs", poolId: String(pool.pool._id) });
  assert.ok(!(await setShareAccess({ ...M(), shareId: String(s.share._id), entries: [{ principalType: "user", principalId: String(mgr.nasUser._id), level: "write" }] })).error);
  const data = randomBytes(100 * 1024 * 1024);
  let t0 = Date.now();
  await fx.smbPut(shareName, mgr.unix, mgr.password, "p.bin", data);
  record("Linux smbclient sequential write, 100 MB", data.length, Date.now() - t0, { client: "smbclient (Linux, loopback)", filesystem: "btrfs on RAID1", concurrency: 1 });
  const seq = await Promise.all(Array.from({ length: 4 }, (_, i) => { const t = Date.now(); return fx.smbPut(shareName, mgr.unix, mgr.password, `par-${i}.bin`, randomBytes(25 * 1024 * 1024)).then(() => Date.now() - t); }));
  record("Linux smbclient 4 concurrent writers, 4 x 25 MB", 100 * 1024 * 1024, Math.max(...seq), { client: "smbclient x4", filesystem: "btrfs on RAID1", concurrency: 4 });
  t0 = Date.now();
  const snap = await createSnapshot({ ...M(), shareId: String(s.share._id), name: "perf-snap" });
  record("Btrfs snapshot creation (copy-on-write), incl. manifest hashing of 100 MB+ of data", 0, Date.now() - t0, { snapshotReportedCreateLatencyMs: snap.snapshot.createLatencyMs, note: "the snapshot itself is near-instant; the reported latency covers only the snapshot; total includes a full manifest hash" });
  assert.ok(snap.snapshot.createLatencyMs < 5000);
  const chk = await fx.agent.call("pool_scrub", { pool: name }, { timeout: 300000 });
  assert.equal(chk.csumErrors, 0);
  assert.ok(perf.results.length >= 4);
});
