// scripts/demo/resilience/reset.mjs -- returns the demo environment to a clean starting state (SOW Workstream A.7, D).
//   node --env-file=.env.local --import ./test/_next-loader.mjs scripts/demo/resilience/reset.mjs            # clean + seed again
//   node --env-file=.env.local --import ./test/_next-loader.mjs scripts/demo/resilience/reset.mjs --clean-only
// Removes ONLY the demo company: its rows in every collection of the TEST database (refuses on any other database), its NAS
// snapshots (locked ones through the documented governance override, with a reason), share, NAS account and appliance record
// on the test NAS VM, and its files in the demo's local storage folder. Evidence files are kept.
import "./_env.mjs";
import { rmSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { ObjectId } from "mongodb";
import { DEMO_STORAGE_DIR } from "./_env.mjs";
import { DEMO_ORG_ID, ADMIN, COMPROMISED, loadState, saveState, log } from "./_common.mjs";
import { getOrgCollections } from "../../../src/lib/orgs.js";
import { NasAgentClient } from "../../../src/lib/nas/agent.js";
import { deleteSnapshot } from "../../../src/lib/nas/snapshots.js";
import { liftLockdown } from "../../../src/lib/nas/ransomware.js";

if (!process.env.TEST_MONGODB_URI || process.env.MONGODB_URI !== process.env.TEST_MONGODB_URI) { console.error("REFUSED: not connected to the test database."); process.exit(2); }
const orgId = new ObjectId(DEMO_ORG_ID); const ORG = String(orgId);
const adminMembership = { role: "owner", nasRole: "manager", email: ADMIN.email };
const { db, nasSnapshots, nasShares, nasUsers } = await getOrgCollections();
const state = loadState();

// NAS first (needs the records to find what to remove on the appliance).
const agent = new NasAgentClient({ backend: "wsl-local" });
const shares = await nasShares.find({ orgId }).toArray();
if (shares.length) {
  await agent.ensureAgent().catch(() => {}); await agent.call("ensure_online", {}).catch(() => {});
  for (const s of shares) {
    await liftLockdown({ orgId: ORG, shareId: String(s._id), membership: adminMembership, actorEmail: ADMIN.email }).catch(() => {});
    for (const snap of await nasSnapshots.find({ orgId, shareId: s._id }).toArray()) {
      const r = await deleteSnapshot({ orgId: ORG, snapshotId: String(snap._id), override: true, reason: "Demo reset: removing the demonstration company's test snapshots", membership: adminMembership, actorEmail: ADMIN.email }).catch((e) => ({ error: e.message }));
      if (r?.error) log("snapshot", snap.name, "->", String(r.error).slice(0, 100));
    }
    await agent.call("share_delete", { name: s.shareName, purgeData: true }).catch((e) => log("share_delete", s.shareName, e.message));
  }
  for (const u of await nasUsers.find({ orgId }).toArray()) await agent.call("user_delete", { username: u.unixUsername }).catch(() => {});
}

// Every collection of the TEST database: rows that belong to the demo company or its two synthetic people.
const emails = [ADMIN.email, COMPROMISED.email];
let removed = 0;
for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
  if (name.startsWith("system.")) continue;
  const col = db.collection(name);
  const q = name === "orgs" ? { _id: orgId } : { $or: [{ orgId }, { orgId: ORG }, { ownerId: ORG }, { email: { $in: emails } }, { memberEmail: { $in: emails } }] };
  try { removed += (await col.deleteMany(q)).deletedCount; } catch { /* views or capped collections */ }
}
rmSync(DEMO_STORAGE_DIR, { recursive: true, force: true }); mkdirSync(DEMO_STORAGE_DIR, { recursive: true });
saveState({ orgId: null, shareId: null, sessionToken: null, samAccessKeyId: null, samSecretAccessKey: null, nasPassword: null, resetAt: new Date().toISOString(), previousSeed: state.seededAt || null });
log(`Demo company removed: ${removed} database rows, ${shares.length} NAS share(s), local storage cleared.`);

if (!process.argv.includes("--clean-only")) {
  // A fresh environment for the seed: this process has already switched MONGODB_URI to the test cluster, and the seed's own
  // guard must compare the real production setting from .env.local with the test one.
  const env = { ...process.env }; for (const k of ["MONGODB_URI", "INAYA_USE_TEST_DB"]) delete env[k];
  const r = spawnSync(process.execPath, ["--env-file=.env.local", "--import", "./test/_next-loader.mjs", "scripts/demo/resilience/seed.mjs"], { stdio: "inherit", env });
  process.exit(r.status ?? 1);
}
process.exit(0);
