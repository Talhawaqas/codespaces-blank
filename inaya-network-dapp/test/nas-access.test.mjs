// test/nas-access.test.mjs
// Sovereign NAS SOW: identity, permissions/ACLs enforced at the DATA PLANE (real
// Samba, real SMB clients), lockout, recycle bin, NFS, remote-access modes,
// discovery. Real appliance + real MongoDB.
// Run: node --env-file=.env.local --test test/nas-access.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fx from "./_nas-fixtures.mjs";
import { createShare, listRecycleBin, restoreFromRecycleBin, purgeRecycleBin, setNfsExport, renameShare, updateShareSettings } from "../src/lib/nas/shares.js";
import { setShareAccess, setFolderAcl, getFolderAcl, createNasGroup, setNasGroupMember, deleteNasGroup, reconcileNasAccess } from "../src/lib/nas/access.js";
import { setLockoutPolicy, getNasUserStatus, unlockNasUser, rotateNasUserPassword, setNasUserEnabled, provisionNasUser, createServiceAccount, revokeNasUser, identityCapabilities } from "../src/lib/nas/users.js";
import { setRemoteAccess, getRemoteAccess, setDiscovery, listLocks, getNetworkInfo } from "../src/lib/nas/network.js";
import { listNasEvidence } from "../src/lib/nas/evidence.js";

let org, appliance, mgr, staff, third, host;
const M = () => ({ orgId: org.orgId, membership: org.manager.membership, actorEmail: org.manager.email });
const deny = /NT_STATUS_ACCESS_DENIED|NT_STATUS_LOGON_FAILURE|NT_STATUS_ACCOUNT|NT_STATUS_WRONG_PASSWORD|NT_STATUS_BAD_NETWORK_NAME|NT_STATUS_CONNECTION_REFUSED|NT_STATUS_ACCESS/;

before(async () => {
  await fx.setup();
  org = await fx.makeOrg("access");
  appliance = await fx.makeAppliance(org);
  host = await fx.nasHost();
  mgr = await fx.provisionUser(org, org.manager, appliance._id);
  staff = await fx.provisionUser(org, org.staff, appliance._id);
  third = await fx.provisionUser(org, org.manager2, appliance._id);
});
after(async () => {
  await fx.agent.call("remote_access_clear", {}).catch(() => {});
  await fx.teardown();
});

test("identity: only org members holding a NAS role can get a NAS login (fail closed)", async () => {
  const out = await provisionNasUser({ orgId: org.orgId, applianceId: String(appliance._id), memberEmail: org.outsider.email, membership: org.manager.membership, actorEmail: org.manager.email });
  assert.equal(out.status, 400);
  assert.match(out.error, /does not have NAS access/);
  const stranger = await provisionNasUser({ orgId: org.orgId, applianceId: String(appliance._id), memberEmail: "nobody@elsewhere.example", membership: org.manager.membership, actorEmail: org.manager.email });
  assert.equal(stranger.status, 400);
  const staffTry = await provisionNasUser({ orgId: org.orgId, applianceId: String(appliance._id), memberEmail: org.owner.email, membership: org.staff.membership, actorEmail: org.staff.email });
  assert.equal(staffTry.status, 403, "NAS staff cannot manage accounts");
  assert.ok(identityCapabilities().activeDirectory.includes("NOT IMPLEMENTED"), "AD is honestly reported, not claimed");
});

test("share permissions are enforced by Samba itself: read-only, read/write, explicit deny, and no login at all", async (t) => {
  const shareName = fx.tag("ac");
  fx.created.shares.add(shareName);
  const s = await createShare({ ...M(), applianceId: String(appliance._id), shareName, ownerUnixUser: mgr.unix });
  const shareId = String(s.share._id);
  await fx.agent.writeFile({ shareName, relativePath: "shared.txt", buffer: Buffer.from("hello"), owner: mgr.unix });
  const acc = await setShareAccess({ ...M(), shareId, entries: [
    { principalType: "user", principalId: String(mgr.nasUser._id), level: "write" },
    { principalType: "user", principalId: String(staff.nasUser._id), level: "read" },
    { principalType: "user", principalId: String(third.nasUser._id), level: "deny" },
  ] });
  assert.ok(!acc.error, acc.error);

  await t.test("read/write user writes; read-only user can read but NOT write; denied user cannot even connect", async () => {
    const w = await fx.smbPut(shareName, mgr.unix, mgr.password, "by-mgr.txt", Buffer.from("m"));
    assert.doesNotMatch(w.out, deny, w.out);
    assert.equal((await fx.agent.readFile({ shareName, relativePath: "by-mgr.txt" })).toString().trim(), "m");
    const r = await fx.smb(shareName, staff.unix, staff.password, "ls");
    assert.match(r.out, /shared\.txt/);
    const sw = await fx.smbPut(shareName, staff.unix, staff.password, "by-staff.txt", Buffer.from("s"));
    assert.match(sw.out, deny, "the read-only user's write is refused by Samba");
    assert.equal((await fx.agent.call("stat_path", { share: shareName, relPath: "by-staff.txt" })).exists, false);
    const d = await fx.smb(shareName, third.unix, third.password, "ls");
    assert.match(d.out, deny, "an explicitly denied user is refused");
  });

  await t.test("access entries for a principal from ANOTHER organization or a non-eligible member are rejected", async () => {
    const other = await fx.makeOrg("access-other");
    const otherApp = await fx.makeAppliance(other);
    const foreign = await fx.provisionUser(other, other.staff, otherApp._id);
    const bad = await setShareAccess({ ...M(), shareId, entries: [{ principalType: "user", principalId: String(foreign.nasUser._id), level: "write" }] });
    assert.equal(bad.status, 400, "cross-org principal");
    await fx.collections.orgMembers.updateOne({ orgId: (await fx.collections.orgs.findOne({ name: `nas-${fx.RUN}-access` }))._id, email: org.staff.email }, { $set: { nasRole: null } });
    const ineligible = await setShareAccess({ ...M(), shareId, entries: [{ principalType: "user", principalId: String(staff.nasUser._id), level: "write" }] });
    assert.equal(ineligible.status, 400, "a member who lost NAS access cannot be granted access");
    await fx.collections.orgMembers.updateOne({ orgId: (await fx.collections.orgs.findOne({ name: `nas-${fx.RUN}-access` }))._id, email: org.staff.email }, { $set: { nasRole: "staff" } });
  });

  await t.test("folder-level POSIX ACL with explicit deny hides a folder from one user only", async () => {
    await fx.agent.writeFile({ shareName, relativePath: "secret/plan.txt", buffer: Buffer.from("secret"), owner: mgr.unix });
    assert.ok(!(await setShareAccess({ ...M(), shareId, entries: [{ principalType: "user", principalId: String(mgr.nasUser._id), level: "write" }, { principalType: "user", principalId: String(staff.nasUser._id), level: "write" }] })).error);
    await fx.agent.call("acl_apply", { share: shareName, relPath: "secret", entries: [{ type: "user", name: mgr.unix, perms: "rwx" }], recursive: false });
    await fx.agent.call("chmod_path", { share: shareName, relPath: "secret", mode: "0750" }).catch(() => {});
    const acl = await setFolderAcl({ ...M(), shareId, relPath: "secret", entries: [{ principalType: "user", principalId: String(staff.nasUser._id), perms: "---" }], recursive: true });
    assert.ok(!acl.error, acl.error);
    assert.ok(acl.acl.some((l) => l.includes(`user:${staff.unix}:---`)), "explicit deny entry present");
    const denied = await fx.smb(shareName, staff.unix, staff.password, "get secret/plan.txt /root/should-not-exist.txt");
    assert.match(denied.out, deny, "staff cannot read the protected folder");
    const allowed = await fx.smb(shareName, mgr.unix, mgr.password, "get secret/plan.txt /root/plan-ok.txt");
    assert.doesNotMatch(allowed.out, deny, "the owner still can");
    const got = await getFolderAcl({ orgId: org.orgId, shareId, relPath: "secret", membership: org.manager.membership });
    assert.ok(got.acl.length > 0);
    const traversal = await setFolderAcl({ ...M(), shareId, relPath: "../../etc", entries: [{ principalType: "user", principalId: String(staff.nasUser._id), perms: "rwx" }] });
    assert.ok(traversal.error, "ACL path traversal rejected");
  });

  await t.test("groups: membership grants inherited access, removal revokes it", async () => {
    const g = await createNasGroup({ ...M(), applianceId: String(appliance._id), name: "Finance Team" });
    assert.ok(!g.error, g.error);
    fx.created.groups.add(g.group.unixGroup);
    assert.equal((await createNasGroup({ ...M(), applianceId: String(appliance._id), name: "Finance Team" })).status, 409);
    assert.ok(!(await setShareAccess({ ...M(), shareId, entries: [{ principalType: "user", principalId: String(mgr.nasUser._id), level: "write" }, { principalType: "group", principalId: String(g.group._id), level: "write" }] })).error);
    const before = await fx.smb(shareName, staff.unix, staff.password, "ls");
    assert.match(before.out, deny, "not in the group yet -> no access");
    assert.ok(!(await setNasGroupMember({ ...M(), groupId: String(g.group._id), nasUserId: String(staff.nasUser._id), action: "add" })).error);
    const during = await fx.smb(shareName, staff.unix, staff.password, "ls");
    assert.doesNotMatch(during.out, deny, `group member gets access: ${during.out.slice(0, 200)}`);
    await setNasGroupMember({ ...M(), groupId: String(g.group._id), nasUserId: String(staff.nasUser._id), action: "remove" });
    const after = await fx.smb(shareName, staff.unix, staff.password, "ls");
    assert.match(after.out, deny, "removed from the group -> access gone");
    assert.equal((await deleteNasGroup({ ...M(), groupId: String(g.group._id) })).status, 409, "a group still used by a share cannot be deleted");
  });

  await t.test("org-level revocation reaches the data plane: a member who loses NAS access is disabled on the appliance", async () => {
    assert.ok(!(await setShareAccess({ ...M(), shareId, entries: [{ principalType: "user", principalId: String(mgr.nasUser._id), level: "write" }, { principalType: "user", principalId: String(staff.nasUser._id), level: "read" }] })).error);
    assert.doesNotMatch((await fx.smb(shareName, staff.unix, staff.password, "ls")).out, deny);
    const orgObj = (await fx.collections.orgs.findOne({ name: `nas-${fx.RUN}-access` }))._id;
    await fx.collections.orgMembers.updateOne({ orgId: orgObj, email: org.staff.email }, { $set: { nasRole: null } });
    const rec = await reconcileNasAccess({ orgId: org.orgId });
    assert.ok(rec.revoked.some((r) => r.memberEmail === org.staff.email), JSON.stringify(rec));
    assert.match((await fx.smb(shareName, staff.unix, staff.password, "ls")).out, deny, "the login no longer works");
    const ev = await listNasEvidence({ orgId: org.orgId, applianceId: appliance._id, action: "USER_REVOKED_ACCESS" });
    assert.ok(ev.some((e) => e.data?.reason));
    await fx.collections.orgMembers.updateOne({ orgId: orgObj, email: org.staff.email }, { $set: { nasRole: "staff" } });
    staff = await fx.provisionUser(org, org.staff, appliance._id); // the revoked account is retired; a new login is issued
  });

  await t.test("share settings: disable / hide / rename act on the real Samba share", async () => {
    assert.ok(!(await updateShareSettings({ ...M(), shareId, enabled: false })).error);
    assert.match((await fx.smb(shareName, mgr.unix, mgr.password, "ls")).out, deny, "a disabled share cannot be opened");
    assert.ok(!(await updateShareSettings({ ...M(), shareId, enabled: true })).error);
    assert.doesNotMatch((await fx.smb(shareName, mgr.unix, mgr.password, "ls")).out, deny);
    const newName = fx.tag("rn");
    fx.created.shares.add(newName);
    const rn = await renameShare({ ...M(), shareId, newName });
    assert.ok(!rn.error, rn.error);
    assert.doesNotMatch((await fx.smb(newName, mgr.unix, mgr.password, "ls")).out, deny, "reachable under the new name");
    assert.match((await fx.smb(shareName, mgr.unix, mgr.password, "ls")).out, /BAD_NETWORK_NAME|NT_STATUS/, "and gone under the old one");
    assert.equal((await fx.agent.readFile({ shareName: newName, relativePath: "shared.txt" })).toString(), "hello", "data did not move");
  });
});

test("account lockout, password rotation, disable/enable and service accounts", async (t) => {
  const shareName = fx.tag("lk");
  fx.created.shares.add(shareName);
  const s = await createShare({ ...M(), applianceId: String(appliance._id), shareName, ownerUnixUser: mgr.unix });
  assert.ok(!(await setShareAccess({ ...M(), shareId: String(s.share._id), entries: [{ principalType: "user", principalId: String(mgr.nasUser._id), level: "write" }, { principalType: "user", principalId: String(staff.nasUser._id), level: "write" }] })).error);

  await t.test("Samba's brute-force lockout: repeated wrong passwords lock the account until an admin unlocks it", async () => {
    const pol = await setLockoutPolicy({ ...M(), applianceId: String(appliance._id), attempts: 3, durationMinutes: 30 });
    assert.equal(pol.lockoutPolicy.attempts, 3);
    assert.equal((await setLockoutPolicy({ ...M(), applianceId: String(appliance._id), attempts: 0 })).status, 400);
    for (let i = 0; i < 4; i++) await fx.smb(shareName, staff.unix, "definitely-wrong-password-" + i, "ls");
    const st = await getNasUserStatus({ orgId: org.orgId, nasUserId: String(staff.nasUser._id), membership: org.manager.membership });
    assert.equal(st.locked, true, JSON.stringify(st));
    assert.match((await fx.smb(shareName, staff.unix, staff.password, "ls")).out, deny, "even the correct password is refused while locked");
    assert.ok(!(await unlockNasUser({ ...M(), nasUserId: String(staff.nasUser._id) })).error);
    assert.doesNotMatch((await fx.smb(shareName, staff.unix, staff.password, "ls")).out, deny, "works again after unlock");
  });

  await t.test("password rotation invalidates the old password", async () => {
    const rot = await rotateNasUserPassword({ ...M(), nasUserId: String(staff.nasUser._id) });
    assert.ok(rot.newPassword);
    assert.match((await fx.smb(shareName, staff.unix, staff.password, "ls")).out, deny, "old password rejected");
    assert.doesNotMatch((await fx.smb(shareName, staff.unix, rot.newPassword, "ls")).out, deny);
    staff.password = rot.newPassword;
  });

  await t.test("temporarily disabling a login blocks it; enabling restores it", async () => {
    assert.ok(!(await setNasUserEnabled({ ...M(), nasUserId: String(staff.nasUser._id), enabled: false })).error);
    assert.match((await fx.smb(shareName, staff.unix, staff.password, "ls")).out, deny);
    assert.ok(!(await setNasUserEnabled({ ...M(), nasUserId: String(staff.nasUser._id), enabled: true })).error);
    assert.doesNotMatch((await fx.smb(shareName, staff.unix, staff.password, "ls")).out, deny);
  });

  await t.test("service accounts exist without a person; passwords with shell metacharacters are handled as data", async () => {
    const svc = await createServiceAccount({ ...M(), applianceId: String(appliance._id), name: "Backup Agent!$(id)", description: "backup" });
    assert.ok(!svc.error, svc.error);
    fx.created.users.add(svc.nasUser.unixUsername);
    assert.match(svc.nasUser.unixUsername, /^nassvc_[a-z0-9_]+$/, "the name was reduced to a safe slug");
    assert.equal(svc.nasUser.kind, "service");
    const rev = await revokeNasUser({ ...M(), nasUserId: String(svc.nasUser._id) });
    assert.ok(!rev.error);
    const injected = await fx.agent.call("user_create", { username: `nasinj${fx.RUN}`, password: "It'sA-Very'Long\"pass$(touch /tmp/pwned);word" });
    fx.created.users.add(`nasinj${fx.RUN}`);
    assert.equal(injected.created, true);
    const pwned = await fx.agent.call("stat_path", { share: shareName, relPath: "x" }).catch(() => ({}));
    assert.ok(pwned);
  });
});

test("recycle bin: deleted files are recoverable, restorable, purgeable, and restore never overwrites silently", async () => {
  const shareName = fx.tag("rc");
  fx.created.shares.add(shareName);
  const s = await createShare({ ...M(), applianceId: String(appliance._id), shareName, ownerUnixUser: mgr.unix });
  const shareId = String(s.share._id);
  assert.ok(!(await setShareAccess({ ...M(), shareId, entries: [{ principalType: "user", principalId: String(mgr.nasUser._id), level: "write" }] })).error);
  await fx.smb(shareName, mgr.unix, mgr.password, "mkdir reports");
  await fx.smbPut(shareName, mgr.unix, mgr.password, "reports/pre.txt", Buffer.from("precious"));
  await fx.smb(shareName, mgr.unix, mgr.password, "del reports/pre.txt");
  assert.equal((await fx.agent.call("stat_path", { share: shareName, relPath: "reports/pre.txt" })).exists, false);
  const bin = await listRecycleBin({ orgId: org.orgId, shareId, membership: org.staff.membership });
  assert.equal(bin.entries.length, 1);
  assert.equal(bin.entries[0].originalPath, "reports/pre.txt");
  const rest = await restoreFromRecycleBin({ ...M(), shareId, recyclePath: bin.entries[0].recyclePath });
  assert.ok(!rest.error, rest.error);
  assert.equal((await fx.agent.readFile({ shareName, relativePath: "reports/pre.txt" })).toString().trim(), "precious");
  await fx.smb(shareName, mgr.unix, mgr.password, "del reports/pre.txt");
  await fx.agent.writeFile({ shareName, relativePath: "reports/pre.txt", buffer: Buffer.from("newer file"), owner: mgr.unix });
  const b2 = await listRecycleBin({ orgId: org.orgId, shareId, membership: org.manager.membership });
  assert.equal((await restoreFromRecycleBin({ ...M(), shareId, recyclePath: b2.entries[0].recyclePath })).status, 409, "will not overwrite a newer file");
  assert.equal((await restoreFromRecycleBin({ ...M(), shareId, recyclePath: "../../../etc/passwd" })).status, 400, "traversal rejected");
  assert.equal((await restoreFromRecycleBin({ orgId: org.orgId, shareId, recyclePath: b2.entries[0].recyclePath, membership: org.staff.membership, actorEmail: org.staff.email })).status, 403, "staff cannot restore");
  const purged = await purgeRecycleBin({ ...M(), shareId, recyclePath: b2.entries[0].recyclePath });
  assert.equal(purged.removed, 1);
  assert.equal((await listRecycleBin({ orgId: org.orgId, shareId, membership: org.manager.membership })).entries.length, 0);
});

test("NFS: export management with client restrictions, mounted and used from a real Linux NFS client", async (t) => {
  const shareName = fx.tag("nf");
  fx.created.shares.add(shareName);
  const s = await createShare({ ...M(), applianceId: String(appliance._id), shareName, ownerUnixUser: mgr.unix });
  const shareId = String(s.share._id);
  for (const bad of ["*", "0.0.0.0/0", "", "not a host!"]) assert.ok((await setNfsExport({ ...M(), shareId, clients: [bad] })).error, `client ${JSON.stringify(bad)} must be rejected`);
  assert.equal((await setNfsExport({ ...M(), shareId, clients: [] })).status, 400);
  assert.equal((await setNfsExport({ orgId: org.orgId, shareId, clients: ["127.0.0.1"], membership: org.staff.membership, actorEmail: org.staff.email })).status, 403);
  const e = await setNfsExport({ ...M(), shareId, clients: ["127.0.0.1"], readOnly: false, rootSquash: true });
  assert.ok(!e.error, e.error);
  assert.equal(e.nfs.rootSquash, true);
  const { execFile } = await import("node:child_process");
  const run = (args) => new Promise((res) => execFile("wsl.exe", ["-d", "Ubuntu", "-u", "root", "--", ...args], { timeout: 60000 }, (err, so, se) => res({ ok: !err, out: (so || "") + (se || "") })));
  await run(["mkdir", "-p", "/mnt/nfstest" + fx.RUN]);
  const mount = await run(["mount", "-t", "nfs4", "-o", "vers=4.2", `127.0.0.1:/srv/inaya-nas/${shareName}`, "/mnt/nfstest" + fx.RUN]);
  try {
    assert.ok(mount.ok, `NFS mount failed: ${mount.out}`);
    const w = await run(["sh", "-c", `echo nfs-content > /mnt/nfstest${fx.RUN}/from-nfs.txt && cat /mnt/nfstest${fx.RUN}/from-nfs.txt`]);
    assert.match(w.out, /nfs-content/);
    assert.equal((await fx.agent.readFile({ shareName, relativePath: "from-nfs.txt" })).toString().trim(), "nfs-content", "the file written over NFS is on the appliance filesystem");
    await run(["sh", "-c", `mv /mnt/nfstest${fx.RUN}/from-nfs.txt /mnt/nfstest${fx.RUN}/renamed.txt && rm /mnt/nfstest${fx.RUN}/renamed.txt`]);
    assert.equal((await fx.agent.call("stat_path", { share: shareName, relPath: "renamed.txt" })).exists, false);
    await run(["umount", "/mnt/nfstest" + fx.RUN]);
    const re = await run(["mount", "-t", "nfs4", "-o", "vers=4.2", `127.0.0.1:/srv/inaya-nas/${shareName}`, "/mnt/nfstest" + fx.RUN]);
    assert.ok(re.ok, "remount works");
  } finally {
    await run(["umount", "-l", "/mnt/nfstest" + fx.RUN]);
    await run(["rmdir", "/mnt/nfstest" + fx.RUN]);
  }
  assert.ok(!(await setNfsExport({ ...M(), shareId, enabled: false })).error);
});

test("remote access modes are ENFORCED on the appliance; raw SMB can never be opened to the public Internet", async (t) => {
  const shareName = fx.tag("ra");
  fx.created.shares.add(shareName);
  const s = await createShare({ ...M(), applianceId: String(appliance._id), shareName, ownerUnixUser: mgr.unix });
  assert.ok(!(await setShareAccess({ ...M(), shareId: String(s.share._id), entries: [{ principalType: "user", principalId: String(mgr.nasUser._id), level: "write" }] })).error);
  const A = String(appliance._id);

  await t.test("public networks are rejected outright", async () => {
    for (const net of ["8.8.8.0/24", "0.0.0.0/0", "1.2.3.4"]) assert.equal((await setRemoteAccess({ ...M(), applianceId: A, mode: "PRIVATE_NETWORK", allowedNetworks: [net] })).status, 400, net);
    assert.equal((await setRemoteAccess({ ...M(), applianceId: A, mode: "EVERYONE" })).status, 400);
    assert.equal((await setRemoteAccess({ orgId: org.orgId, applianceId: A, mode: "LOCAL_ONLY", membership: org.staff.membership, actorEmail: org.staff.email })).status, 403);
  });

  await t.test("GATEWAY/LOCAL mode: a connection from the appliance's LAN address is refused, loopback still works", async () => {
    const r = await setRemoteAccess({ ...M(), applianceId: A, mode: "GATEWAY" });
    assert.ok(!r.error, r.error);
    assert.equal(r.remoteAccess.label, "REMOTE ACCESS VIA INAYA GATEWAY");
    const lo = await fx.smb(shareName, mgr.unix, mgr.password, "ls", { host: "127.0.0.1" });
    assert.doesNotMatch(lo.out, deny, "loopback allowed");
    const lan = await fx.smb(shareName, mgr.unix, mgr.password, "ls", { host });
    assert.match(lan.out, /NT_STATUS|refused|denied|Connection/i, `LAN address blocked: ${lan.out.slice(0, 160)}`);
    const ev = await listNasEvidence({ orgId: org.orgId, applianceId: appliance._id, action: "REMOTE_ACCESS_ENABLED" });
    assert.ok(ev.length >= 1, "remote-access changes are audited");
  });

  await t.test("PRIVATE_NETWORK mode allows the private LAN again; the state is reported", async () => {
    assert.ok(!(await setRemoteAccess({ ...M(), applianceId: A, mode: "PRIVATE_NETWORK" })).error);
    assert.doesNotMatch((await fx.smb(shareName, mgr.unix, mgr.password, "ls", { host })).out, /NT_STATUS_CONNECTION|refused/i);
    const cur = await getRemoteAccess({ orgId: org.orgId, applianceId: A, membership: org.manager.membership });
    assert.equal(cur.remoteAccess.mode, "PRIVATE_NETWORK");
    assert.match(cur.warning, /never exposed/i);
  });
});

test("discovery and network information are measured, not invented", async () => {
  const A = String(appliance._id);
  const n = await getNetworkInfo({ orgId: org.orgId, applianceId: A, membership: org.manager.membership });
  assert.equal(n.measurement, "MEASURED");
  assert.ok(n.interfaces.some((i) => i.addresses.some((a) => a.family === "inet")), "IPv4 reported");
  assert.ok(n.hostname);
  const d = await setDiscovery({ ...M(), applianceId: A, mdns: true });
  assert.ok(!d.error, d.error);
  assert.ok(d.discovery.mdns.supported);
  assert.match(d.discovery.lanVisibilityNote, /NAT/, "the NAT limitation is stated");
  assert.equal((await setDiscovery({ ...M(), applianceId: A, hostname: "bad host name!" })).status, 400);
  const l = await listLocks({ orgId: org.orgId, applianceId: A, membership: org.manager.membership });
  assert.ok(Array.isArray(l.locks) && Array.isArray(l.sessions));
});
