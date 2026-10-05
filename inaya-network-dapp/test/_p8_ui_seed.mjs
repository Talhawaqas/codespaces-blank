// test/_p8_ui_seed.mjs -- throwaway org for the Phase 8 browser pass: features on, documents with classification/tags/favorites, a branded organization, a share link,
// a file request, a webhook, an auditor member, a device. Prints SEED {...} and stays up until killed (cleans up on exit).
//   node --env-file=.env.local test/_p8_ui_seed.mjs
import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { setup, teardown, makeChatOrg, cookieFor, c as cols } from "./_chat-fixtures.mjs";
import { getOrgCollections } from "../src/lib/orgs.js";
import { setOrgFeature } from "../src/lib/featureFlags.js";
import * as B from "../src/lib/branding/branding.js";
import * as W from "../src/lib/webhooks/registry.js";
import * as FP from "../src/lib/filePrefs.js";
import { createLinkShare } from "../src/lib/sharing/shares.js";
import * as N from "../src/lib/notify/router.js";

await setup();
const db = (await getOrgCollections()).db;
const org = await makeChatOrg("p8ui", { people: ["bob", "auditor"] });
for (const f of ["FEATURE_ADVANCED_SHARING", "FEATURE_FILE_GOVERNANCE", "FEATURE_DLP", "FEATURE_SMART_CLASSIFICATION", "FEATURE_DEVICE_CONTROL", "FEATURE_RANSOMWARE_SIGNALS", "FEATURE_ENDPOINT_BACKUP_V2"]) await setOrgFeature({ orgId: org.oid, name: f, enabled: true });
await cols.orgMembers.updateOne({ orgId: org.orgId, email: org.auditor.email }, { $set: { adminRoles: ["auditor"] } });
const now = new Date().toISOString();
const dept = (await cols.departments.insertOne({ orgId: org.orgId, name: "Finance", createdAt: now })).insertedId;
const proj = (await cols.projects.insertOne({ orgId: org.orgId, departmentId: dept, name: "Reports", createdAt: now, createdByEmail: org.owner.email })).insertedId;
const mk = async (filename, extra = {}) => String((await cols.orgDocuments.insertOne({ orgId: org.orgId, departmentId: dept, projectId: proj, filename, fileHash: `0xp8ui-${randomBytes(4).toString("hex")}`, sizeBytes: 2048, cidAlpha: "QmA", cidBeta: "QmB", uploadedByEmail: org.owner.email, txHash: "0xfake", status: "DRAFT", accessLevel: "PRIVATE", createdAt: now, deletedAt: null, ...extra })).insertedId);
const a = await mk("quarterly-report.pdf", { classification: "CONFIDENTIAL", metadata: { client: "Acme Holdings" } });
const b = await mk("board-minutes.docx", { classification: "RESTRICTED", legalHold: true });
const c = await mk("lunch-menu.txt", { classification: "PUBLIC" });
await mk("budget.xlsx", { classification: "INTERNAL", lockedByEmail: org.owner.email, lockedAt: now, lockExpiresAt: new Date(Date.now() + 3600_000).toISOString() });
const o = { orgId: org.oid, email: org.owner.email, membership: org.owner.membership };
await FP.setPrefs({ ...o, documentId: a, favorite: true, addTag: "Q3" }); await FP.setPrefs({ ...o, documentId: b, pinned: true }); await FP.setPrefs({ ...o, documentId: c, touch: true });
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
await B.setBranding({ orgId: org.oid, membership: org.owner.membership, actorEmail: org.owner.email, input: { portalTitle: "Acme Secure Files", accent: "#d9480f", logo: PNG, supportUrl: "https://acme.example/help", legal: { terms: "Acme terms of use.", privacy: "Acme privacy notice." } } });
const share = await createLinkShare({ orgId: org.oid, documentId: a, actorEmail: org.owner.email, expiresAt: new Date(Date.now() + 5 * 86400_000).toISOString(), options: { permission: "view", label: "Acme review" }, role: "owner" });
const reqToken = randomBytes(24).toString("base64url");
await db.collection("file_requests").insertOne({ orgId: org.orgId, createdByEmail: org.owner.email, createdAt: now, title: "Tax documents", instructions: "Upload last year's statements.", expiresAt: new Date(Date.now() + 5 * 86400_000).toISOString(), revokedAt: null, tokenHash: (await import("node:crypto")).createHash("sha256").update(reqToken).digest("hex"), maxFiles: 3, maxFileBytes: 1_000_000, allowedExtensions: [], requireIdentity: { name: true, email: true, company: false }, notifyOwner: true, publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, wrappedPrivateKey: JSON.stringify({ v: 1, ct: "c", salt: "s", iv: "i" }), received: 0 });
await W.createWebhook({ orgId: org.oid, membership: org.owner.membership, actorEmail: org.owner.email, url: "https://hooks.example.com/inaya", events: ["file.uploaded", "share.created"], description: "Ops pager" });
await db.collection("org_devices").insertOne({ orgId: org.orgId, deviceId: `dev-${randomBytes(3).toString("hex")}`, email: org.owner.email, name: "Work laptop", platform: "windows", trust: "trusted", firstSeenAt: now, lastSeenAt: now });
await N.notifyEvent({ orgId: org.oid, event: "file.shared", targetEmail: org.owner.email, title: "x", dedupeKey: "seed", sender: async () => ({ sent: true }) });
console.log("SEED " + JSON.stringify({ orgId: org.oid, ownerToken: await cookieFor(org.owner.email), auditorToken: await cookieFor(org.auditor.email), bobToken: await cookieFor(org.bob.email), shareToken: share.token, requestToken: reqToken, docA: a }));
const stop = async () => { try { for (const n of ["org_branding", "file_prefs", "org_webhooks", "org_webhook_deliveries", "org_devices", "file_requests", "notification_prefs", "notification_deliveries"]) await db.collection(n).deleteMany({ orgId: org.orgId }); await cols.documentShares.deleteMany({ orgId: org.orgId }); await cols.orgDocuments.deleteMany({ orgId: org.orgId }); await cols.projects.deleteMany({ orgId: org.orgId }); await cols.departments.deleteMany({ orgId: org.orgId }); await teardown(); } catch {} process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop); setTimeout(stop, 40 * 60_000); setInterval(() => {}, 1e6);
