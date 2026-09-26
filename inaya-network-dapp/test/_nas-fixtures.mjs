// test/_nas-fixtures.mjs
// Shared fixtures for the Sovereign NAS test suites. Everything here talks to
// the REAL appliance (the WSL2 Ubuntu distro running Samba, nfsd, mdadm, Btrfs)
// and the real MongoDB -- nothing is mocked. Each suite creates its own
// organization(s) and appliance-side resources with a unique suffix and tears
// them all down, on the appliance as well as in the database.
import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { registerAppliance } from "../src/lib/nas/appliances.js";
import { NasAgentClient } from "../src/lib/nas/agent.js";

export const RUN = randomBytes(3).toString("hex");
export const agent = new NasAgentClient({ backend: "wsl-local" });
export let collections;
export const created = { orgIds: [], shares: new Set(), pools: new Set(), users: new Set(), replicas: new Set(), groups: new Set() };

export async function setup() {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  await agent.ensureAgent();
  await agent.call("ensure_online", {});
  return collections;
}

export async function nasHost() {
  const n = await agent.call("network_info", {});
  const eth = n.interfaces.find((i) => i.addresses.some((a) => a.family === "inet"));
  return eth.addresses.find((a) => a.family === "inet").address;
}

/** An organization with an owner, a NAS manager, NAS staff and an outsider. */
export async function makeOrg(label) {
  const orgId = new ObjectId();
  await collections.orgs.insertOne({ _id: orgId, name: `nas-${RUN}-${label}`, createdAt: new Date().toISOString() });
  created.orgIds.push(orgId);
  const mk = async (kind, role, nasRole) => {
    const email = `${kind}-${RUN}-${label}@example.com`;
    await collections.orgMembers.insertOne({ orgId, email, role, nasRole: nasRole || null, status: "active", createdAt: new Date().toISOString() });
    return { email, membership: { role, nasRole: nasRole || null, email } };
  };
  const owner = await mk("owner", "owner");
  const manager = await mk("mgr", "member", "manager");
  const manager2 = await mk("mgr2", "member", "manager");
  const staff = await mk("staff", "member", "staff");
  const outsider = await mk("outsider", "member");
  return { orgId: orgId.toString(), owner, manager, manager2, staff, outsider };
}

export async function makeAppliance(org, name = "Test NAS") {
  const host = await nasHost();
  const r = await registerAppliance({ orgId: org.orgId, name, backend: "wsl-local", host, membership: org.manager.membership, actorEmail: org.manager.email });
  if (r.error) throw new Error("registerAppliance failed: " + r.error);
  return r.appliance;
}

export const tag = (prefix) => `${prefix}${RUN}${randomBytes(2).toString("hex")}`.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24);

export async function teardown() {
  for (const s of created.shares) await agent.call("share_delete", { name: s, purgeData: true }).catch(() => {});
  for (const r of created.replicas) await agent.call("replica_delete", { targetName: r }).catch(() => {});
  for (const p of created.pools) await agent.call("pool_destroy", { pool: p }).catch(() => {});
  for (const g of created.groups) await agent.call("group_delete", { group: g }).catch(() => {});
  for (const u of created.users) await agent.call("user_delete", { username: u }).catch(() => {});
  const ids = created.orgIds;
  const names = ["orgs", "orgMembers", "nasAppliances", "nasShares", "nasUsers", "nasGroups", "nasPools", "nasSnapshots", "nasSnapshotPolicies", "nasBackupPolicies", "nasBackupIndex", "nasBackupRuns", "nasRecoveryDrills", "nasReplicationPolicies", "nasCloudTargets", "nasThreatEvents", "nasTieringProposals", "nasJobs", "nasEvidence", "nasUpdates", "nasStateCommitments", "nasAcls", "nasRequests", "nasApplianceState", "storageResources", "orgActivity", "orgDocuments", "businessEvents", "auditChainEntries", "auditChainHeads", "notifications"];
  for (const n of names) {
    if (!collections[n]) continue;
    const key = n === "orgs" ? "_id" : "orgId";
    await collections[n].deleteMany({ [key]: { $in: ids } }).catch(() => {});
  }
  try { const { connectToDatabase } = await import("../src/lib/mongodb.js"); const { db } = await connectToDatabase(); await db.collection("notifications").deleteMany({ orgId: { $in: ids } }); } catch { /* best effort */ }
  const client = await mongoClientPromise;
  await client.close();
}

/** Registers a NAS user for a member and remembers the unix name for cleanup. */
export async function provisionUser(org, who, applianceId) {
  const { provisionNasUser } = await import("../src/lib/nas/users.js");
  const r = await provisionNasUser({ orgId: org.orgId, applianceId: String(applianceId), memberEmail: who.email, membership: org.manager.membership, actorEmail: org.manager.email });
  if (r.error) throw new Error("provisionNasUser: " + r.error);
  created.users.add(r.nasUser.unixUsername);
  return { nasUser: r.nasUser, password: r.initialPassword, unix: r.nasUser.unixUsername };
}

/** smbclient inside the appliance (a real Linux SMB client over TCP). */
export async function smb(share, user, password, commands, { host = "127.0.0.1" } = {}) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  try {
    const { stdout, stderr } = await run("wsl.exe", ["-d", "Ubuntu", "-u", "root", "--", "smbclient", `//${host}/${share}`, "-U", `${user}%${password}`, "-c", commands], { timeout: 60000 });
    return { ok: true, out: stdout + stderr };
  } catch (e) {
    return { ok: false, out: (e.stdout || "") + (e.stderr || "") + e.message };
  }
}

/** Uploads a Buffer to a share through smbclient (a real SMB client): the
 *  bytes go through an approved temp file the appliance can read. */
export async function smbPut(share, user, password, remote, buffer, opts = {}) {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const { winPathToWslPath } = await import("../src/lib/nas/agent.js");
  const tmp = path.join(os.tmpdir(), `smbput-${randomUUID()}.bin`);
  await fs.writeFile(tmp, buffer);
  try {
    return await smb(share, user, password, `put ${winPathToWslPath(tmp)} ${remote}`, opts);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

/** Notifications live in their own collection (notifications.js). */
export async function notifCount(filter) {
  const { connectToDatabase } = await import("../src/lib/mongodb.js");
  const { db } = await connectToDatabase();
  return db.collection("notifications").countDocuments(filter);
}
