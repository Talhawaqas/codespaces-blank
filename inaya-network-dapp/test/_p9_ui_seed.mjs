// test/_p9_ui_seed.mjs -- throwaway organization for the Phase 9 browser pass: a REAL gateway agent running against the local server (needs `next start -p 3000`), a customer portal
// with a request for a portal customer, replication records, documents and an edit session. Prints SEED {...} and runs until killed.
//   node --env-file=.env.local test/_p9_ui_seed.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { setup, cleanup, makeSupportOrg, portalSession, cookieFor, sc, c as cols } from "./_support-fixtures.mjs";
import { setOrgFeature } from "../src/lib/featureFlags.js";
import * as G from "../src/lib/gateway/gateway.js";
import * as PR from "../src/lib/support/portalRequests.js";
import * as H from "../src/lib/ha/replication.js";
import * as O from "../src/lib/integrations/office.js";
import { createMemberShare } from "../src/lib/sharing/shares.js";
import clientPromise from "../src/lib/mongodb.js";
import { enrollGateway, makeClient } from "../../inaya-gateway-agent/src/client.js";
import { runOnce } from "../../inaya-gateway-agent/src/agent.js";
import { openQueue } from "../../inaya-gateway-agent/src/queue.js";
import { openAudit } from "../../inaya-gateway-agent/src/audit.js";

const BASE = "http://localhost:3000";
await setup();
const org = await makeSupportOrg("p9ui");
for (const f of ["FEATURE_SOVEREIGN_GATEWAY", "FEATURE_ADVANCED_SHARING"]) await setOrgFeature({ orgId: org.oid, name: f, enabled: true });
const now = new Date().toISOString();
const proj = (await cols.projects.insertOne({ orgId: org.orgId, departmentId: org.dept, name: "Contracts", createdAt: now, createdByEmail: org.owner.email })).insertedId;
const mk = async (filename, extra = {}) => (await cols.orgDocuments.insertOne({ orgId: org.orgId, departmentId: org.dept, projectId: proj, filename, fileHash: `0xp9-${randomBytes(5).toString("hex")}`, sizeBytes: 4096, cidAlpha: "QmA" + randomBytes(3).toString("hex"), cidBeta: "QmB" + randomBytes(3).toString("hex"), uploadedByEmail: org.owner.email, txHash: "0xfake", status: "DRAFT", accessLevel: "PRIVATE", createdAt: new Date(Date.now() - Math.random() * 5 * 3600_000).toISOString(), deletedAt: null, version: 1, ...extra })).insertedId;
const d1 = await mk("Master services agreement.docx"), d2 = await mk("Budget 2027.xlsx"), d3 = await mk("Board deck.pptx"), d4 = await mk("Scan.pdf");
await createMemberShare({ orgId: org.oid, documentId: String(d1), actorEmail: org.owner.email, targetEmail: org.agent.email, permission: "edit" });

// a real gateway agent
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p9-gw-")); const root = path.join(tmp, "fileserver"); fs.mkdirSync(path.join(root, "Finance", "2026"), { recursive: true }); fs.mkdirSync(path.join(root, "HR"), { recursive: true });
fs.writeFileSync(path.join(root, "Finance", "budget.xlsx"), "budget"); fs.writeFileSync(path.join(root, "Finance", "2026", "forecast.pdf"), "forecast"); fs.writeFileSync(path.join(root, "HR", "salaries.csv"), "secret");
const { token } = await G.createEnrollment({ orgId: org.oid, membership: org.owner.membership, actorEmail: org.owner.email, label: "Head office" });
const dataKey = randomBytes(32); const id = await enrollGateway({ baseUrl: BASE, token, label: "Head office", version: "0.1.0", platform: "seed", capabilities: ["filesystem", "ntfs-acl"] });
const client = makeClient({ baseUrl: BASE, gatewayId: id.gatewayId, privateKeyPem: id.privateKeyPem, retries: 1 }); const dir = path.join(tmp, "agent"); const queue = openQueue(dir); const audit = openAudit(dir); const config = { dataKey: dataKey.toString("base64"), scanIntervalSeconds: 3600, aclIntervalSeconds: 3600 };
const conn = await G.upsertConnector({ orgId: org.oid, membership: org.owner.membership, actorEmail: org.owner.email, gatewayId: id.gatewayId, name: "File server", type: "smb", rootPath: root, folders: [{ path: "Finance", label: "Finance" }] });
const folderId = conn.folders[0].folderId;
await runOnce({ client, config, dir, audit, queue });
await client.post("/api/gateway/v1/acl", { folderId, source: "ntfs", entries: [{ principal: "CONTOSO\\finance", type: "allow", rights: ["modify"], inherited: false }, { principal: "CONTOSO\\interns", type: "deny", rights: ["write", "delete"], inherited: false }, { principal: "CONTOSO\\ghost", type: "allow", rights: ["read"], inherited: false }], principals: [{ principal: "CONTOSO\\agent", kind: "user", upn: org.agent.email, memberOf: ["CONTOSO\\finance"] }, { principal: "CONTOSO\\finance", kind: "group", memberOf: [] }] });
const loop = setInterval(() => runOnce({ client, config, dir, audit, queue }).catch(() => {}), 30_000);

// a portal request for a portal customer
const alice = await portalSession(org, org.alice.email);
const req = await PR.createRequest({ orgId: org.oid, settings: org.settings, membership: org.agent.membership, actorEmail: org.agent.email, customerEmail: org.alice.email, title: "Onboarding documents", instructions: "Please complete these so we can start your project.", dueAt: new Date(Date.now() + 7 * 86400_000).toISOString(), items: [
  { kind: "upload", title: "Signed contract", accept: ["pdf"], maxFiles: 1, instructions: "A PDF of the signed copy." },
  { kind: "form", title: "Company details", fields: [{ key: "legal_name", label: "Legal name", type: "text", required: true }, { key: "tier", label: "Plan", type: "select", options: ["Basic", "Plus"], required: true }, { key: "authorised", label: "I am authorised to sign", type: "checkbox", required: true }] },
  { kind: "ack", title: "Mutual NDA", text: "Both parties agree to keep all information exchanged during this engagement confidential for five years." },
  { kind: "download", title: "Welcome pack", required: false }] });

// replication records: primary has everything, the secondary two of four
const reps = (await clientPromise).db("inaya_network").collection("backup_replicas"); const hashOf = async (d) => (await cols.orgDocuments.findOne({ _id: d })).fileHash;
for (const d of [d1, d2, d3, d4]) { const fh = await hashOf(d); await reps.updateOne({ fileHash: fh, shardId: "alpha", provider: "pinata" }, { $set: { fileHash: fh, shardId: "alpha", provider: "pinata", cid: "c", providerRef: "r-" + fh, contentHash: "a".repeat(64), lastCheckedAt: new Date(), lastCheckOk: true, consecutiveFailures: 0, corrupted: false } }, { upsert: true }); }
for (const d of [d3, d4]) { const fh = await hashOf(d); await reps.updateOne({ fileHash: fh, shardId: "alpha", provider: "filebase" }, { $set: { fileHash: fh, shardId: "alpha", provider: "filebase", cid: "c", providerRef: "r2-" + fh, contentHash: "a".repeat(64), lastCheckedAt: new Date(), lastCheckOk: true, consecutiveFailures: 0, corrupted: false } }, { upsert: true }); }
await H.setProfile({ orgId: org.oid, membership: org.owner.membership, actorEmail: org.owner.email, primary: "pinata", secondaries: ["filebase"], targets: { rtoMinutes: 240, rpoMinutes: 120 } });
await O.startEditSession({ orgId: org.oid, membership: org.agent.membership, email: org.agent.email, documentId: String(d1) });

console.log("SEED " + JSON.stringify({ orgId: org.oid, slug: org.slug, ownerToken: await cookieFor(org.owner.email), agentToken: await cookieFor(org.agent.email), plainToken: await cookieFor(org.plain.email), aliceToken: alice.sessionToken, requestId: req.request.requestId, folderId, gatewayId: id.gatewayId, ownerEmail: org.owner.email, agentEmail: org.agent.email }));
const stop = async () => { clearInterval(loop); try { await reps.deleteMany({ fileHash: { $regex: "^0xp9-" } }); for (const n of ["gateway_enrollments", "gateways", "gateway_connectors", "gateway_inventory", "gateway_audit", "gateway_principals", "gateway_identity_map", "gateway_acl_snapshots", "gateway_acl_events", "gateway_transfers", "gateway_chunks", "org_deployment_profile", "ha_profiles", "ha_recovery_tests", "office_edit_sessions", "supportPortalRequests", "supportPortalRequestFiles"]) await sc.db.collection(n).deleteMany({ orgId: org.orgId }); await cols.orgDocuments.deleteMany({ orgId: org.orgId }); await cols.projects.deleteMany({ orgId: org.orgId }); await cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop); setTimeout(stop, 50 * 60_000); setInterval(() => {}, 1e6);
