// scripts/demo/resilience/seed.mjs -- builds the isolated demo company and records the baseline evidence (SOW Workstream A).
//   node --env-file=.env.local --import ./test/_next-loader.mjs scripts/demo/resilience/seed.mjs
// Creates (TEST database, local storage only): the synthetic company "Northwind Advisory (Demo)", an administrator and a
// member whose sync credential plays the compromised account, the bucket client-files with 10 business documents (versioned,
// with the automatic tripwire), the office NAS share "finance" on the test NAS VM with the same documents, a clean threat
// baseline, a locked snapshot and one off-site recovery point. Writes evidence/baseline-<time>.json with every SHA-256 hash,
// version id, the snapshot id and time, and the protection settings. Refuses if the demo company already exists (use reset.mjs).
import "./_env.mjs";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { ObjectId } from "mongodb";
import { DEMO_EVIDENCE_DIR, DEMO_STORAGE_DIR } from "./_env.mjs";
import { DEMO_ORG_ID, DEMO_ORG_NAME, ADMIN, COMPROMISED, BUCKET, NAS_SHARE, NAS_APPLIANCE, DOCUMENTS, sha256, saveState, stamp, log, smbPut } from "./_common.mjs";
import { getOrgCollections, ensureOrgIndexes, createSession } from "../../../src/lib/orgs.js";
import { issueS3Credential, ensureOwnerS3Passphrase } from "../../../src/lib/s3-compat/credentials.js";
import { putS3Object, getBucketVersioning, getLifecyclePolicy } from "../../../src/lib/s3-compat/store.js";
import { getPolicy as getRansomwarePolicy, DEFAULT_THRESHOLDS } from "../../../src/lib/ransomware/cloud.js";
import { NasAgentClient, winPathToWslPath } from "../../../src/lib/nas/agent.js";
import { registerAppliance } from "../../../src/lib/nas/appliances.js";
import { provisionNasUser } from "../../../src/lib/nas/users.js";
import { createShare } from "../../../src/lib/nas/shares.js";
import { setThreatPolicy, setBaseline } from "../../../src/lib/nas/ransomware.js";
import { createSnapshot, getSnapshotPolicy } from "../../../src/lib/nas/snapshots.js";
import { backupShareToInaya } from "../../../src/lib/nas/backup.js";

const orgId = new ObjectId(DEMO_ORG_ID);
const ORG = String(orgId);
const adminMembership = { role: "owner", nasRole: "manager", email: ADMIN.email };
await ensureOrgIndexes();
const c = await getOrgCollections();
if (await c.orgs.findOne({ _id: orgId })) { console.error("The demo company already exists. Run reset.mjs to start clean."); process.exit(1); }

const now = stamp();
log("Creating the synthetic company", DEMO_ORG_NAME);
await c.orgs.insertOne({ _id: orgId, name: DEMO_ORG_NAME, ownerEmail: ADMIN.email, createdAt: now, demo: "enterprise-resilience" });
const departmentId = (await c.departments.insertOne({ orgId, name: "Advisory", createdAt: now })).insertedId;
await c.orgMembers.insertOne({ orgId, email: ADMIN.email, displayName: ADMIN.name, role: "owner", nasRole: "manager", status: "active", departmentIds: [departmentId], createdAt: now });
await c.orgMembers.insertOne({ orgId, email: COMPROMISED.email, displayName: COMPROMISED.name, role: "member", nasRole: "staff", status: "active", departmentIds: [departmentId], createdAt: now });

// Cloud: the sync credential that will play the compromised account, then the documents (uploaded by the administrator).
await ensureOwnerS3Passphrase({ type: "org", orgId: ORG });
const samKey = await issueS3Credential({ owner: { type: "org", orgId: ORG }, label: `${COMPROMISED.name} - laptop sync`, actorEmail: ADMIN.email });
const cloudFiles = [];
for (const [key, body] of DOCUMENTS) {
  const doc = await putS3Object({ orgId: ORG, bucket: BUCKET, key, bodyBuffer: body, contentType: key.endsWith(".csv") ? "text/csv" : "text/plain", actorEmail: ADMIN.email });
  cloudFiles.push({ key, sha256: sha256(body), sizeBytes: body.length, versionId: doc.versionId, uploadedAt: doc.createdAt || doc.lastModified || stamp() });
}
const tripwire = await c.orgDocuments.findOne({ orgId, filename: /^\.inaya-canary\//, deletedAt: null }, { projection: { filename: 1 } });
log(`Bucket ${BUCKET}: ${cloudFiles.length} documents, versioning ${(await getBucketVersioning({ orgId: ORG, bucket: BUCKET })).versioningStatus}, tripwire ${tripwire ? "present" : "MISSING"}`);

// NAS: the office appliance (the test NAS VM), the administrator's NAS account, the share and the same documents.
const agent = new NasAgentClient({ backend: "wsl-local" });
await agent.ensureAgent(); await agent.call("ensure_online", {});
const net = await agent.call("network_info", {});
const host = net.interfaces.find((i) => i.addresses.some((a) => a.family === "inet")).addresses.find((a) => a.family === "inet").address;
const ap = await registerAppliance({ orgId: ORG, name: NAS_APPLIANCE, backend: "wsl-local", host, membership: adminMembership, actorEmail: ADMIN.email });
if (ap.error) throw new Error("registerAppliance: " + ap.error);
const nasUser = await provisionNasUser({ orgId: ORG, applianceId: String(ap.appliance._id), memberEmail: ADMIN.email, membership: adminMembership, actorEmail: ADMIN.email });
if (nasUser.error) throw new Error("provisionNasUser: " + nasUser.error);
const shareName = `${NAS_SHARE}${DEMO_ORG_ID.slice(-4)}`;
await agent.call("share_delete", { name: shareName, purgeData: true }).catch(() => {}); // a leftover from an interrupted run
const sh = await createShare({ orgId: ORG, applianceId: String(ap.appliance._id), shareName, ownerUnixUser: nasUser.nasUser.unixUsername, membership: adminMembership, actorEmail: ADMIN.email });
if (sh.error) throw new Error("createShare: " + sh.error);
const shareId = String(sh.share._id);
const nasFiles = [];
// Saved over SMB by the administrator's own NAS account, as staff would save them (folders then belong to that account).
for (const [key, body] of DOCUMENTS) {
  const r = await smbPut({ shareName, user: nasUser.nasUser.unixUsername, password: nasUser.initialPassword, remote: key, buffer: body, wslPath: winPathToWslPath });
  if (!r.ok) throw new Error(`SMB upload of ${key} failed: ${r.status}`);
  nasFiles.push({ path: key, sha256: sha256(body), sizeBytes: body.length });
}
await setThreatPolicy({ orgId: ORG, shareId, enabled: true, autoSnapshot: true, autoLockdown: false, lockdownMinutes: 60, scanIntervalMinutes: 15, membership: adminMembership, actorEmail: ADMIN.email });
const baseline = await setBaseline({ orgId: ORG, shareId, membership: adminMembership, actorEmail: ADMIN.email });
if (baseline?.error) throw new Error("setBaseline: " + baseline.error);
const snap = await createSnapshot({ orgId: ORG, shareId, name: "nightly-clean", immutable: true, retentionDays: 7, lockMode: "governance", reason: "Demo baseline: equivalent to the daily scheduled snapshot", membership: adminMembership, actorEmail: ADMIN.email });
if (snap.error) throw new Error("createSnapshot: " + snap.error);
const backup = await backupShareToInaya({ orgId: ORG, shareId, idempotencyKey: `demo-baseline-${Date.now()}`, membership: adminMembership, actorEmail: ADMIN.email });
if (backup.error) throw new Error("off-site backup: " + backup.error);
log(`NAS share ${shareName}: ${nasFiles.length} documents, snapshot ${snap.snapshot?.name || "nightly-clean"}, off-site recovery point ${backup.runId}`);

const session = await createSession(ADMIN.email);
const snapshotPolicy = (await getSnapshotPolicy({ orgId: ORG, shareId, membership: adminMembership })).policy;
let build = "unknown"; try { build = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() + (execSync("git status --porcelain src", { encoding: "utf8" }).trim() ? " (+ uncommitted src changes)" : ""); } catch { /* no git */ }
const evidence = {
  recordedAt: stamp(), build, environment: { database: "TEST cluster (INAYA_USE_TEST_DB=1)", fileStorage: `local folder ${DEMO_STORAGE_DIR} (Filebase/Pinata credentials blanked)`, email: "off (no Resend key)", nasAppliance: `test NAS VM (WSL Ubuntu), host ${host}` },
  company: { orgId: ORG, name: DEMO_ORG_NAME, administrator: ADMIN.email, compromisedAccount: { member: COMPROMISED.email, credential: samKey.accessKeyId, label: `${COMPROMISED.name} - laptop sync` } },
  cloud: { bucket: BUCKET, versioning: (await getBucketVersioning({ orgId: ORG, bucket: BUCKET })).versioningStatus, lifecycleRules: (await getLifecyclePolicy({ orgId: ORG, bucket: BUCKET })).rules, tripwire: tripwire?.filename || null, files: cloudFiles,
    ransomwarePolicy: await getRansomwarePolicy(ORG).catch(() => null), defaultThresholds: DEFAULT_THRESHOLDS },
  nas: { appliance: NAS_APPLIANCE, applianceId: String(ap.appliance._id), share: shareName, shareId, files: nasFiles, snapshot: { id: String(snap.snapshot?._id || ""), name: snap.snapshot?.name, createdAt: snap.snapshot?.createdAt, immutable: snap.snapshot?.immutable, retentionUntil: snap.snapshot?.retentionUntil, lockMode: snap.snapshot?.lockMode },
    snapshotPolicy, threatPolicy: { enabled: true, autoSnapshot: true, autoLockdown: false, lockdownMinutes: 60, scanIntervalMinutes: 15 }, offsiteRecoveryPoint: backup.runId },
};
const file = path.join(DEMO_EVIDENCE_DIR, `baseline-${evidence.recordedAt.replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify(evidence, null, 2));
saveState({ orgId: ORG, shareId, shareName, applianceId: String(ap.appliance._id), nasUnixUser: nasUser.nasUser.unixUsername, nasPassword: nasUser.initialPassword,
  samAccessKeyId: samKey.accessKeyId, samSecretAccessKey: samKey.secretAccessKey, sessionToken: session.sessionToken, baselineFile: file, seededAt: evidence.recordedAt });
log("Baseline evidence:", file);
process.exit(0);
