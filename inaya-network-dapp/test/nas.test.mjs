// test/nas.test.mjs
// Sovereign NAS SOW. Real end-to-end tests against the live wsl-local
// appliance set up for this SOW (Samba 4.23 + nfs-kernel-server on this
// machine's WSL2 "Ubuntu" distro) -- not mocked. Requires NAS_WSL_HOST
// (the appliance's real IP, e.g. 172.21.35.48) to be set, and the
// appliance to actually be running (see nas-setup/*.sh).
// Run with: node --env-file=.env.local --test test/nas.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { registerAppliance, checkApplianceHealth, deleteAppliance, listAppliances } from "../src/lib/nas/appliances.js";
import { createShare, deleteShare, listShares, listRecycleBin } from "../src/lib/nas/shares.js";
import { provisionNasUser, revokeNasUser, listNasUsers } from "../src/lib/nas/users.js";
import { backupShareToInaya, runRecoveryDrill } from "../src/lib/nas/backup.js";
import { NasAgentClient } from "../src/lib/nas/agent.js";
import { getS3ObjectBody } from "../src/lib/s3-compat/store.js";

const execFileAsync = promisify(execFile);
const RUN_ID = randomUUID().slice(0, 8);
const NAS_HOST = process.env.NAS_WSL_HOST || "172.21.35.48";
const cleanup = { orgIds: [] };
let collections;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: { $in: cleanup.orgIds } }),
    collections.orgMembers.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    collections.nasAppliances.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    collections.nasShares.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    collections.nasUsers.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    collections.nasBackupRuns.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    collections.nasRecoveryDrills.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    collections.storageResources.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    collections.orgActivity.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    collections.orgDocuments.deleteMany({ orgId: { $in: cleanup.orgIds } }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

async function makeTestOrg(label) {
  const orgId = new ObjectId();
  await collections.orgs.insertOne({ _id: orgId, name: `nas-test-${RUN_ID}-${label}`, createdAt: new Date().toISOString() });
  cleanup.orgIds.push(orgId);
  const managerEmail = `nasmgr-${RUN_ID}-${label}@example.com`;
  await collections.orgMembers.insertOne({ orgId, email: managerEmail, role: "member", nasRole: "manager", status: "active", createdAt: new Date().toISOString() });
  const membership = { role: "member", nasRole: "manager", email: managerEmail };
  return { orgId: orgId.toString(), membership, managerEmail };
}

test("NasAgentClient rejects unimplemented backends explicitly, never silently", () => {
  assert.throws(() => new NasAgentClient({ backend: "physical-daemon" }), /not implemented in this pass/);
});

test("NasAgentClient rejects path traversal and unsafe names for real", async () => {
  const agent = new NasAgentClient({ backend: "wsl-local" });
  await assert.rejects(() => agent.readFile({ shareName: "x", relativePath: "../../etc/passwd" }), /Path traversal/);
  await assert.rejects(() => agent.createShare({ shareName: "not a valid name!", ownerUnixUser: "u" }), /Invalid share name/);
});

test("registerAppliance is denied for a member without nasRole (fails closed)", async () => {
  const { orgId } = await makeTestOrg("deny");
  const result = await registerAppliance({ orgId, name: "x", backend: "wsl-local", host: NAS_HOST, membership: { role: "member" }, actorEmail: "nobody@example.com" });
  assert.equal(result.status, 403);
});

test("full real lifecycle: register appliance -> health -> digital-twin resource -> user -> share -> SMB write via smbclient -> recycle bin -> backup to Inaya -> verified recovery drill -> path-traversal rejection -> cleanup", async (t) => {
  const { orgId, membership, managerEmail } = await makeTestOrg("lifecycle");

  await t.test("register appliance and get a real health check", async () => {
    const result = await registerAppliance({ orgId, name: "Test Appliance", backend: "wsl-local", host: NAS_HOST, membership, actorEmail: managerEmail });
    assert.ok(!result.error, result.error);
    assert.ok(result.appliance._id);
    assert.equal(result.appliance.adminCredential, undefined, "credential must never be returned in an API response shape");
    assert.equal(result.health.status, "REACHABLE", `expected the live appliance at ${NAS_HOST} to be reachable — is it running? (see nas-setup/*.sh)`);
    t.applianceId = result.appliance._id.toString();
  });

  await t.test("the appliance is registered as a real storageResource, reusable by the existing Digital Twin", async () => {
    const doc = await collections.nasAppliances.findOne({ _id: new ObjectId(t.applianceId) });
    assert.ok(doc.storageResourceId);
    const resource = await collections.storageResources.findOne({ _id: doc.storageResourceId });
    assert.ok(resource, "expected a real storageResources row, not a fabricated reference");
    assert.equal(resource.type, "fileShare");
  });

  await t.test("checkApplianceHealth re-checks for real and updates status", async () => {
    const result = await checkApplianceHealth({ orgId, applianceId: t.applianceId, membership });
    assert.equal(result.status, "REACHABLE");
    assert.equal(result.detail.measurement, "MEASURED");
  });

  await t.test("listAppliances returns it, never exposing the credential field", async () => {
    const result = await listAppliances({ orgId, membership });
    assert.equal(result.appliances.length, 1);
    assert.equal(result.appliances[0].adminCredential, undefined);
  });

  await t.test("provisionNasUser creates a real Samba login on the appliance", async () => {
    const result = await provisionNasUser({ orgId, applianceId: t.applianceId, memberEmail: managerEmail, membership, actorEmail: managerEmail });
    assert.ok(!result.error, result.error);
    assert.ok(result.initialPassword && result.initialPassword.length >= 20);
    t.unixUsername = result.nasUser.unixUsername;
    t.password = result.initialPassword;
  });

  await t.test("provisionNasUser rejects a member without NAS access (fails closed)", async () => {
    const otherEmail = `no-access-${RUN_ID}@example.com`;
    await collections.orgMembers.insertOne({ orgId: new ObjectId(orgId), email: otherEmail, role: "member", status: "active", createdAt: new Date().toISOString() });
    const result = await provisionNasUser({ orgId, applianceId: t.applianceId, memberEmail: otherEmail, membership, actorEmail: managerEmail });
    assert.equal(result.status, 400);
  });

  await t.test("createShare actually provisions a real Samba share on the appliance", async () => {
    const shareName = `t${RUN_ID}`;
    const result = await createShare({ orgId, applianceId: t.applianceId, shareName, ownerUnixUser: t.unixUsername, quotaBytes: 5 * 1024 * 1024 * 1024, membership, actorEmail: managerEmail });
    assert.ok(!result.error, result.error);
    assert.equal(result.share.quota.enforced, false, "quota must be honestly reported as not enforced in this environment (no ext4 quota mount option)");
    t.shareId = result.share._id.toString();
    t.shareName = shareName;
  });

  await t.test("the real share is genuinely reachable via a real SMB client (smbclient inside WSL) using the newly-provisioned user's own credential", async () => {
    const cmd = `smbclient //${NAS_HOST}/${t.shareName} -U ${t.unixUsername}%${t.password} -c 'put /etc/hostname livetest.txt; ls; del livetest.txt'`;
    const { stdout } = await execFileAsync("wsl.exe", ["-d", process.env.NAS_WSL_DISTRO || "Ubuntu", "-u", "root", "--", "bash", "-c", cmd], { timeout: 15000 });
    assert.match(stdout, /livetest\.txt/, "expected the per-user-provisioned SMB login to genuinely read/write the newly created share");
  });

  await t.test("a deleted file lands in the real recycle bin, not gone", async () => {
    const cmd = `smbclient //${NAS_HOST}/${t.shareName} -U ${t.unixUsername}%${t.password} -c 'put /etc/hostname recycleme.txt; del recycleme.txt'`;
    await execFileAsync("wsl.exe", ["-d", process.env.NAS_WSL_DISTRO || "Ubuntu", "-u", "root", "--", "bash", "-c", cmd], { timeout: 15000 });
    const result = await listRecycleBin({ orgId, shareId: t.shareId, membership });
    assert.ok(result.entries.some((e) => e.originalPath.includes("recycleme.txt")), `expected recycleme.txt in the recycle bin, got: ${JSON.stringify(result.entries)}`);
  });

  await t.test("writeFile via the agent, then backupShareToInaya pushes real bytes through the real s3-compat pipeline", async () => {
    const agent = new NasAgentClient({ backend: "wsl-local" });
    const content = Buffer.from(`Inaya Sovereign NAS backup test ${RUN_ID}`);
    await agent.writeFile({ shareName: t.shareName, relativePath: "backup-target.txt", buffer: content });
    t.originalContent = content;

    const result = await backupShareToInaya({ orgId, shareId: t.shareId, membership, actorEmail: managerEmail });
    assert.ok(!result.error, result.error);
    assert.equal(result.status, "COMPLETED", JSON.stringify(result.failures));
    assert.ok(result.filesBackedUp >= 1);

    const appliance = await collections.nasAppliances.findOne({ _id: new ObjectId(t.applianceId) });
    const stored = await getS3ObjectBody({ orgId, bucket: appliance.backupBucket, key: `${t.shareName}/backup-target.txt` });
    assert.ok(stored, "expected a real object in the real S3-compat bucket");
    assert.equal(Buffer.compare(stored.buffer, content), 0, "backed-up bytes must match the original file exactly");
  });

  await t.test("runRecoveryDrill restores from Inaya and verifies bytes match, without touching the live file", async () => {
    const result = await runRecoveryDrill({ orgId, shareId: t.shareId, relativePath: "backup-target.txt", membership, actorEmail: managerEmail });
    assert.ok(!result.error, result.error);
    assert.equal(result.verified, true, JSON.stringify(result));
    assert.equal(result.restoredTo, ".recovery-drill/backup-target.txt");

    const agent = new NasAgentClient({ backend: "wsl-local" });
    const stillThere = await agent.readFile({ shareName: t.shareName, relativePath: "backup-target.txt" });
    assert.equal(Buffer.compare(stillThere, t.originalContent), 0, "the live file must be untouched by a recovery drill");
  });

  await t.test("every consequential NAS mutation was recorded in the SHARED audit chain, not a second one", async () => {
    const events = await collections.orgActivity.find({ orgId: new ObjectId(orgId), recordType: { $in: ["NAS_APPLIANCE", "NAS_SHARE", "NAS_USER"] } }).toArray();
    const actions = events.map((e) => e.action);
    for (const expected of ["REGISTERED", "USER_GRANTED_ACCESS", "SHARE_CREATED", "BACKUP_VERIFIED", "RECOVERY_COMPLETED"]) {
      assert.ok(actions.includes(expected), `expected a ${expected} audit event, got: ${actions.join(", ")}`);
    }
  });

  await t.test("cleanup: revoke user, delete share, delete appliance -- all really removed from the appliance too", async () => {
    const users = await listNasUsers({ orgId, applianceId: t.applianceId, membership });
    for (const u of users.nasUsers) {
      const revoked = await revokeNasUser({ orgId, nasUserId: u._id.toString(), membership, actorEmail: managerEmail });
      assert.ok(!revoked.error, revoked.error);
    }
    const deletedShare = await deleteShare({ orgId, shareId: t.shareId, purgeData: true, membership, actorEmail: managerEmail });
    assert.ok(!deletedShare.error, deletedShare.error);

    const remainingShares = await listShares({ orgId, applianceId: t.applianceId, membership });
    assert.equal(remainingShares.shares.length, 0);

    const deletedAppliance = await deleteAppliance({ orgId, applianceId: t.applianceId, membership, actorEmail: managerEmail });
    assert.ok(!deletedAppliance.error, deletedAppliance.error);
  });
});
