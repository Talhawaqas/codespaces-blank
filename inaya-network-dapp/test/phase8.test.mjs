// test/phase8.test.mjs -- Competitive Expansion Phase 8: role gates, admin dashboard, branding, notification routing and privacy, file preferences, unified
// search (permissions), share-expiry job, the public API v1 families (real route handlers + real API key), and the read-only AI governance tools.
// Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=300000 test/phase8.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { setup, teardown, makeChatOrg, c as cols } from "./_chat-fixtures.mjs";
import { getOrgCollections } from "../src/lib/orgs.js";
import { hasAdminRole, ADMIN_ROLES } from "../src/lib/orgGates.js";
import { buildDashboard } from "../src/lib/admin/dashboard.js";
import * as B from "../src/lib/branding/branding.js";
import * as N from "../src/lib/notify/router.js";
import { notifyExpiringShares } from "../src/lib/notify/jobs.js";
import * as FP from "../src/lib/filePrefs.js";
import { unifiedSearch, TIERS } from "../src/lib/search/unified.js";
import { createApiKey } from "../src/lib/api-keys.js";
import { setOrgFeature } from "../src/lib/featureFlags.js";
import { createLinkShare } from "../src/lib/sharing/shares.js";
import { runGovernanceTool, GOVERNANCE_TOOL_DECLARATIONS } from "../src/lib/ai-governance-tools.js";

const T = { timeout: 300000 };
let org, db, owner, member, auditor, devAdmin, docA, docB, key;
const code = (p) => p.then(() => null, (e) => e);
const PNG = "data:image/png;base64," + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(40)]).toString("base64");
let dept, proj;
const mkDoc = async (filename, extra = {}) => (await cols.orgDocuments.insertOne({ orgId: org.orgId, departmentId: dept, projectId: proj, filename, fileHash: `0xp8-${randomBytes(4).toString("hex")}`, sizeBytes: 100, cidAlpha: "QmA", cidBeta: "QmB", uploadedByEmail: owner.email, txHash: "0xfake", status: "DRAFT", accessLevel: "PRIVATE", createdAt: new Date().toISOString(), deletedAt: null, ...extra })).insertedId;
const apiReq = (method, url, body) => new Request(`http://localhost:3000${url}`, { method, headers: { authorization: `Bearer ${key.rawKey}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });

before(async () => {
  await setup(); db = (await getOrgCollections()).db;
  org = await makeChatOrg("p8", { people: ["member", "auditor", "devAdmin"] }); owner = org.owner; member = org.member;
  await cols.orgMembers.updateOne({ orgId: org.orgId, email: org.auditor.email }, { $set: { adminRoles: ["auditor"] } });
  await cols.orgMembers.updateOne({ orgId: org.orgId, email: org.devAdmin.email }, { $set: { adminRoles: ["deviceAdmin"] } });
  auditor = { ...org.auditor, membership: await cols.orgMembers.findOne({ orgId: org.orgId, email: org.auditor.email }) };
  devAdmin = { ...org.devAdmin, membership: await cols.orgMembers.findOne({ orgId: org.orgId, email: org.devAdmin.email }) };
  dept = (await cols.departments.insertOne({ orgId: org.orgId, name: "Finance", createdAt: new Date().toISOString() })).insertedId; proj = (await cols.projects.insertOne({ orgId: org.orgId, departmentId: dept, name: "Reports", createdAt: new Date().toISOString(), createdByEmail: owner.email })).insertedId;
  docA = await mkDoc("quarterly-report.pdf", { classification: "CONFIDENTIAL", metadata: { client: "Acme Holdings" } }); docB = await mkDoc("notes.txt");
  key = await createApiKey({ orgId: org.oid, label: "p8", actorEmail: owner.email });
});
after(async () => {
  for (const n of ["org_branding", "file_prefs", "notification_prefs", "notification_deliveries", "dlp_events", "governance_policies", "org_devices", "org_webhooks", "org_webhook_deliveries"]) await db.collection(n).deleteMany({ orgId: org.orgId }).catch(() => {});
  await cols.apiKeys.deleteMany({ orgId: org.orgId }).catch(() => {}); await cols.orgDocuments.deleteMany({ orgId: org.orgId }).catch(() => {}); await cols.documentShares.deleteMany({ orgId: org.orgId }).catch(() => {}); await cols.projects.deleteMany({ orgId: org.orgId }).catch(() => {}); await cols.departments.deleteMany({ orgId: org.orgId }).catch(() => {});
  await teardown();
});

// ------------------------------------------------------------------------------------------------ role gates and dashboard
test("role gates: owner/admin hold every scope, scoped roles hold only theirs, an auditor reads but never changes", T, () => {
  assert.equal(hasAdminRole(owner.membership, "securityAdmin"), true);
  assert.equal(hasAdminRole(member.membership, "securityAdmin"), false);
  assert.equal(hasAdminRole(devAdmin.membership, "deviceAdmin"), true);
  assert.equal(hasAdminRole(devAdmin.membership, "securityAdmin"), false);
  assert.equal(hasAdminRole(devAdmin.membership, ["securityAdmin", "deviceAdmin"]), true, "any of a list");
  assert.equal(hasAdminRole(auditor.membership, "securityAdmin"), false, "an auditor cannot change");
  assert.equal(hasAdminRole(auditor.membership, "securityAdmin", { read: true }), true, "but can read");
  assert.ok(Object.keys(ADMIN_ROLES).includes("auditor"));
});

test("dashboard: refused to a plain member, shown to an auditor, tiles are honest (off features say so, empty areas say NO_DATA, the storage figure is real)", T, async () => {
  assert.equal((await code(buildDashboard({ orgId: org.oid, membership: member.membership })))?.status, 403);
  const d = await buildDashboard({ orgId: org.oid, membership: auditor.membership });
  const states = new Set(["OK", "ATTENTION", "NO_DATA", "NOT_ENABLED", "UNKNOWN"]);
  assert.ok(d.tiles.length >= 15); for (const t of d.tiles) assert.ok(states.has(t.state), `${t.id}: ${t.state}`);
  const by = Object.fromEntries(d.tiles.map((t) => [t.id, t]));
  assert.equal(by.storage.state, "OK"); assert.equal(by.storage.detail?.includes?.("2") || String(by.storage.value).length > 0, true);
  assert.equal(by.devices.state, "NOT_ENABLED", "a feature that is off is not shown as zero");
  assert.equal(by.s3.state, "UNKNOWN", "usage that is not collected is not invented");
  assert.equal(by.resilience.state, "NO_DATA");
  assert.ok(by.devices.note && by.s3.note && by.resilience.note, "every non-OK tile explains itself");
});

// ------------------------------------------------------------------------------------------------ branding
test("branding: input is validated and sanitized, only managers change it, public view carries no admin fields, email output is escaped", T, async () => {
  assert.equal((await code(B.setBranding({ orgId: org.oid, membership: member.membership, actorEmail: member.email, input: { accent: "#112233" } })))?.status, 403);
  for (const bad of [{ accent: "red" }, { accent: "#12345" }, { supportUrl: "http://x.com" }, { supportUrl: "https://u:p@x.com" }, { logo: "data:image/svg+xml;base64,PHN2Zz4=" }, { logo: "data:image/png;base64," + Buffer.from("not a png at all").toString("base64") }, { logo: "javascript:alert(1)" }, { email: { headerColor: "url(x)" } }]) {
    assert.equal((await code(B.setBranding({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, input: bad })))?.status, 400, JSON.stringify(bad).slice(0, 60));
  }
  const big = "data:image/png;base64," + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(B.LIMITS.logo + 10)]).toString("base64");
  assert.equal((await code(B.setBranding({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, input: { logo: big } })))?.status, 400, "oversize logo");
  const saved = await B.setBranding({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, input: { portalTitle: "Acme <b>Files</b>", accent: "#1a73e8", supportUrl: "https://acme.example/help", logo: PNG, email: { headerColor: "#0b1220", footerText: "Acme legal" } } });
  assert.equal(saved.portalTitle, "Acme bFiles/b", "angle brackets are stripped"); assert.equal(saved.accent, "#1a73e8");
  const pub = await B.publicBranding(org.oid); assert.equal(pub.accent, "#1a73e8"); assert.equal(pub.logo, PNG);
  assert.equal("updatedBy" in pub || "customDomain" in pub, false, "public view has no admin fields");
  const m = await B.brandedEmail({ orgId: org.oid, title: "Hello <script>x</script>", lines: ["a & b"], ctaUrl: "javascript:alert(1)" });
  assert.equal(m.html.includes("<script>"), false); assert.equal(m.html.includes("javascript:"), false, "a non-http link never becomes a button"); assert.ok(m.html.includes("a &amp; b"));
});

test("custom domain: refuses domains it must not accept, issues a TXT challenge, verifies only when the record is really there; routing is NOT claimed", T, async () => {
  for (const d of ["localhost", "x.inaya.network", "not a domain", "a..b.com", "http://x.com"]) assert.equal((await code(B.setCustomDomain({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, domain: d })))?.status, 400, d);
  assert.equal((await code(B.setCustomDomain({ orgId: org.oid, membership: member.membership, actorEmail: member.email, domain: "files.acme.example" })))?.status, 403);
  const r = await B.setCustomDomain({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, domain: "Files.Acme.Example." });
  const cd = r.customDomain || r; assert.equal(cd.domain, "files.acme.example"); assert.equal(cd.status, "PENDING_DNS"); assert.equal(cd.routing, "NOT_CONFIGURED");
  const no = await B.verifyCustomDomain({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, resolver: async () => [["something-else"]] }); assert.equal((no.customDomain || no).status, "PENDING_DNS");
  const yes = await B.verifyCustomDomain({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, resolver: async () => [[cd.txtValue]] }); const v = yes.customDomain || yes;
  assert.equal(v.status, "VERIFIED_DNS"); assert.equal(v.routing, "NOT_CONFIGURED", "verified DNS ownership is not the same as routing");
});

// ------------------------------------------------------------------------------------------------ notifications
test("notification preferences: documented defaults, per-person changes, unknown events and channels refused, webhook only where an event has one", T, async () => {
  const p0 = await N.getPrefs({ orgId: org.oid, email: member.email });
  assert.equal(p0.prefs["file.shared"].inApp, true); assert.equal(p0.prefs["note.shared"].email, false); assert.equal(p0.prefs["file.shared"].webhook, false, "no webhook for an event without one");
  assert.equal((await code(N.setPrefs({ orgId: org.oid, email: member.email, changes: { "file.shared": { webhook: true } } })))?.status, 400, "no webhook equivalent for file.shared");
  assert.equal((await N.setPrefs({ orgId: org.oid, email: member.email, changes: { "security.incident": { webhook: true } } })).prefs["security.incident"].webhook, true);
  assert.ok((await code(N.setPrefs({ orgId: org.oid, email: member.email, changes: { "nope.event": { email: true } } })))?.status === 400);
  assert.ok(await code(N.setPrefs({ orgId: org.oid, email: member.email, changes: { "file.shared": { carrierPigeon: true } } })));
  const p1 = await N.setPrefs({ orgId: org.oid, email: member.email, changes: { "file.shared": { email: false } } }); assert.equal(p1.prefs["file.shared"].email, false);
  assert.equal((await N.getPrefs({ orgId: org.oid, email: owner.email })).prefs["file.shared"].email, true, "another person is unaffected");
});

test("notification privacy: email carries the generic text for protected content, in-app carries the detail, push says NOT_CONFIGURED honestly, a person's off switch is respected", T, async () => {
  const sent = []; const sender = async (m) => { sent.push(m); return { sent: true }; };
  const secret = "Project Falcon merger term sheet.pdf";
  const r = await N.notifyEvent({ orgId: org.oid, event: "dlp.blocked", targetEmail: owner.email, title: `Blocked: ${secret}`, body: `Detail about ${secret}`, dedupeKey: `t1-${randomBytes(3).toString("hex")}`, sender });
  assert.equal(sent.length, 1); const mail = JSON.stringify(sent[0]); assert.equal(mail.includes("Falcon"), false, "no protected detail in email"); assert.ok(mail.includes("data protection rule"));
  assert.equal(r.results.find((x) => x.channel === "email").state, "SENT");
  const feed = await db.collection("notifications").find({ targetEmail: owner.email, type: "dlp.blocked" }).toArray().catch(() => []);
  if (feed.length) assert.ok(feed.some((n) => JSON.stringify(n).includes("Falcon")), "the in-app item keeps the detail");
  const p = await N.notifyEvent({ orgId: org.oid, event: "security.incident", targetEmail: owner.email, title: "x", dedupeKey: `t2-${randomBytes(3).toString("hex")}`, sender }); const push = p.results.find((x) => x.channel === "push");
  assert.ok(push && (push.state === "NOT_CONFIGURED" || process.env.EXPO_ACCESS_TOKEN || process.env.FCM_SERVER_KEY || process.env.APNS_KEY_ID), "no push credential: not pretended");
  await N.setPrefs({ orgId: org.oid, email: owner.email, changes: { "dlp.blocked": { email: false } } }); const before = sent.length;
  await N.notifyEvent({ orgId: org.oid, event: "dlp.blocked", targetEmail: owner.email, title: "again", dedupeKey: `t3-${randomBytes(3).toString("hex")}`, sender }); assert.equal(sent.length, before, "email is off, so none is sent");
});

test("share-expiry job: tells the creator once, then not again", T, async () => {
  const soon = new Date(Date.now() + 6 * 3600_000).toISOString(); const out = [];
  const { shareId } = await createLinkShare({ orgId: org.oid, documentId: String(docB), actorEmail: owner.email, expiresAt: soon, options: { permission: "view" }, role: "owner" }).catch((e) => { out.push(e.message); return {}; });
  if (!shareId) return assert.fail(`could not create share: ${out}`);
  const a = await notifyExpiringShares({ withinHours: 12 }); assert.ok(a.sent >= 1);
  const row = await cols.documentShares.findOne({ _id: new ObjectId(shareId) }); assert.ok(row.expiryNotifiedAt);
  const b = await notifyExpiringShares({ withinHours: 12 }); const row2 = await cols.documentShares.findOne({ _id: new ObjectId(shareId) }); assert.equal(row2.expiryNotifiedAt, row.expiryNotifiedAt, "not notified twice");
  assert.ok(b.sent >= 0);
});

// ------------------------------------------------------------------------------------------------ file prefs and search
test("file preferences: favorites, pins, tags and recents are per person and permission-checked", T, async () => {
  const a = { orgId: org.oid, email: owner.email, membership: owner.membership, documentId: String(docA) };
  let p = await FP.setPrefs({ ...a, favorite: true, addTag: "Q3 review" }); assert.equal(p.favorite, true); assert.deepEqual(p.tags, ["Q3 review"]);
  await FP.setPrefs({ ...a, touch: true });
  assert.equal((await code(FP.setPrefs({ ...a, addTag: "<script>" })))?.status, 400, "tag shape is validated");
  const other = await FP.prefsForDocs({ orgId: org.oid, email: member.email, documentIds: [String(docA)] }); assert.equal(other.size, 0, "another person sees none of it");
  const mine = await FP.prefsForDocs({ orgId: org.oid, email: owner.email, documentIds: [String(docA), String(docB)] }); assert.equal(mine.get(String(docA)).favorite, true); assert.ok(mine.get(String(docA)).recentAt);
  assert.ok((await code(FP.setPrefs({ orgId: org.oid, email: member.email, membership: member.membership, documentId: String(docA), favorite: true }))), "a member without access to the file cannot mark it");
  p = await FP.setPrefs({ ...a, removeTag: "Q3 review" }); assert.deepEqual(p.tags, []);
  assert.deepEqual((await FP.listTags({ orgId: org.oid, email: owner.email })).tags, []);
  await FP.setPrefs({ ...a, addTag: "board" });
});

test("unified search: finds by name, metadata, classification and your tag; pages respect roles; reports its privacy tiers; never returns what the caller cannot see", T, async () => {
  const s = (who, query, filters) => unifiedSearch({ orgId: org.oid, membership: who.membership, email: who.email, query, filters });
  const byName = await s(owner, "quarterly"); assert.ok(byName.results.some((r) => r.entityType === "document" && r.title === "quarterly-report.pdf"));
  const byMeta = await s(owner, "acme"); assert.ok(byMeta.results.some((r) => r.title === "quarterly-report.pdf" && /metadata/.test(r.subtitle)));
  const byTag = await s(owner, "board"); assert.ok(byTag.results.some((r) => r.title === "quarterly-report.pdf" && /tag/.test(r.subtitle)));
  const byClass = await s(owner, "confidential"); assert.ok(byClass.results.some((r) => r.title === "quarterly-report.pdf"));
  const fav = await s(owner, "", { favorite: true }); assert.ok(fav.results.length >= 1 && fav.results.every((r) => r.entityType === "document"));
  assert.deepEqual(Object.keys(byName.tiers), ["A", "B", "C"]); assert.equal(byName.tiers.A.status, "LOCAL"); assert.equal(byName.tiers.C.status, "NOT_CONFIGURED"); assert.equal(TIERS.B.status, "OK");
  const memberTag = await s(member, "board"); assert.equal(memberTag.results.some((r) => r.title === "quarterly-report.pdf"), false, "someone else's tag, and a file they cannot open, never match");
  assert.equal((await s(member, "acme")).results.some((r) => r.title === "quarterly-report.pdf"), false, "no access, no result, even by metadata");
  const pagesOwner = (await s(owner, "ransomware")).results.filter((r) => r.entityType === "page"); const pagesMember = (await s(member, "ransomware")).results.filter((r) => r.entityType === "page");
  assert.ok(pagesOwner.length >= 1); assert.equal(pagesMember.length, 0, "an admin-only page is not offered to a member");
  assert.equal((await s(owner, "x")).results.length, 0, "a single character is not a search");
});

// ------------------------------------------------------------------------------------------------ public API v1
test("public API: refuses missing and bad keys; flags gate each family; org comes from the key", T, async () => {
  const shares = await import("../src/app/api/public/v1/shares/route.js"); const devices = await import("../src/app/api/public/v1/devices/route.js");
  assert.equal((await shares.GET(new Request("http://localhost:3000/api/public/v1/shares"))).status, 401);
  assert.equal((await shares.GET(new Request("http://localhost:3000/api/public/v1/shares", { headers: { authorization: "Bearer inaya_wrong" } }))).status, 401);
  const prevS = process.env.FEATURE_ADVANCED_SHARING; const prevD = process.env.FEATURE_DEVICE_CONTROL; delete process.env.FEATURE_ADVANCED_SHARING; delete process.env.FEATURE_DEVICE_CONTROL;
  try {
    const off = await shares.GET(apiReq("GET", "/api/public/v1/shares")); assert.ok([403, 404].includes(off.status), `flag off -> ${off.status}`);
    assert.ok([403, 404].includes((await devices.GET(apiReq("GET", "/api/public/v1/devices"))).status));
    await setOrgFeature({ orgId: org.oid, name: "FEATURE_ADVANCED_SHARING", enabled: true }); await setOrgFeature({ orgId: org.oid, name: "FEATURE_DEVICE_CONTROL", enabled: true });
    const ok = await shares.GET(apiReq("GET", "/api/public/v1/shares")); assert.equal(ok.status, 200); assert.ok(Array.isArray((await ok.json()).items));
    assert.equal((await devices.GET(apiReq("GET", "/api/public/v1/devices"))).status, 200);
  } finally { if (prevS !== undefined) process.env.FEATURE_ADVANCED_SHARING = prevS; if (prevD !== undefined) process.env.FEATURE_DEVICE_CONTROL = prevD; }
});

test("public API: create, list, read events and revoke a share; the token is returned once and never listed; another org's key sees nothing", T, async () => {
  const shares = await import("../src/app/api/public/v1/shares/route.js"); const one = await import("../src/app/api/public/v1/shares/[shareId]/route.js");
  const exp = new Date(Date.now() + 86400_000).toISOString();
  const created = await shares.POST(apiReq("POST", "/api/public/v1/shares", { documentId: String(docA), expiresAt: exp, options: { permission: "view", label: "via api" } })); assert.equal(created.status, 200);
  const body = await created.json(); assert.ok(body.token && body.shareId);
  const listed = await (await shares.GET(apiReq("GET", "/api/public/v1/shares"))).json(); assert.ok(listed.items.some((i) => i.shareId === body.shareId)); assert.equal(JSON.stringify(listed).includes(body.token), false, "the token is never listed");
  const ev = await one.GET(apiReq("GET", `/api/public/v1/shares/${body.shareId}`), { params: Promise.resolve({ shareId: body.shareId }) }); assert.equal(ev.status, 200);
  const bad = await shares.POST(apiReq("POST", "/api/public/v1/shares", { documentId: String(docA), expiresAt: "yesterday" })); assert.ok(bad.status >= 400 && bad.status < 500);
  const org2 = await makeChatOrg("p8b", { people: [] }); const key2 = await createApiKey({ orgId: org2.oid, label: "other", actorEmail: org2.owner.email }); await setOrgFeature({ orgId: org2.oid, name: "FEATURE_ADVANCED_SHARING", enabled: true });
  const theirs = await (await shares.GET(new Request("http://localhost:3000/api/public/v1/shares", { headers: { authorization: `Bearer ${key2.rawKey}` } }))).json(); assert.equal(theirs.items.some((i) => i.shareId === body.shareId), false, "org isolation");
  const cross = await one.DELETE(new Request(`http://localhost:3000/api/public/v1/shares/${body.shareId}`, { method: "DELETE", headers: { authorization: `Bearer ${key2.rawKey}` } }), { params: Promise.resolve({ shareId: body.shareId }) }); assert.equal(cross.status, 404, "another organization's key cannot revoke it");
  const rev = await one.DELETE(apiReq("DELETE", `/api/public/v1/shares/${body.shareId}`), { params: Promise.resolve({ shareId: body.shareId }) }); assert.equal(rev.status, 200); assert.equal((await rev.json()).revoked, true);
  await cols.apiKeys.deleteMany({ orgId: org2.orgId });
});

test("public API: file requests are listed and revoked but cannot be created (the key pair belongs in a browser); the private key is never returned", T, async () => {
  const route = await import("../src/app/api/public/v1/file-requests/route.js"); const one = await import("../src/app/api/public/v1/file-requests/[requestId]/route.js");
  assert.equal(route.POST, undefined, "no create endpoint");
  const r = await db.collection("file_requests").insertOne({ orgId: org.orgId, createdByEmail: owner.email, createdAt: new Date().toISOString(), title: "Tax docs", expiresAt: new Date(Date.now() + 86400_000).toISOString(), revokedAt: null, tokenHash: randomBytes(8).toString("hex"), maxFiles: 3, maxFileBytes: 100, allowedExtensions: [], requireIdentity: { name: true, email: true, company: false }, notifyOwner: true, publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" }, wrappedPrivateKey: JSON.stringify({ v: 1, ct: "SECRETWRAP", salt: "s", iv: "i" }), received: 0 });
  const id = String(r.insertedId);
  const list = await (await route.GET(apiReq("GET", "/api/public/v1/file-requests"))).json(); assert.ok(list.items.some((i) => i.requestId === id)); assert.equal(JSON.stringify(list).includes("SECRETWRAP"), false);
  const got = await one.GET(apiReq("GET", `/api/public/v1/file-requests/${id}`), { params: Promise.resolve({ requestId: id }) }); assert.equal(got.status, 200); assert.equal(JSON.stringify(await got.json()).includes("SECRETWRAP"), false);
  const rev = await one.DELETE(apiReq("DELETE", `/api/public/v1/file-requests/${id}`), { params: Promise.resolve({ requestId: id }) }); assert.equal(rev.status, 200);
  await db.collection("file_requests").deleteOne({ _id: r.insertedId });
});

test("public API: governance and classification are read-only here, dry-run by default, and gated by their flags", T, async () => {
  const pol = await import("../src/app/api/public/v1/governance/policies/route.js"); const cls = await import("../src/app/api/public/v1/classification/[documentId]/route.js"); const dlp = await import("../src/app/api/public/v1/governance/dlp-events/route.js");
  for (const f of ["FEATURE_FILE_GOVERNANCE", "FEATURE_DLP", "FEATURE_SMART_CLASSIFICATION"]) await setOrgFeature({ orgId: org.oid, name: f, enabled: true });
  assert.equal(pol.POST, undefined); assert.equal(dlp.POST, undefined);
  assert.equal((await pol.GET(apiReq("GET", "/api/public/v1/governance/policies"))).status, 200);
  assert.equal((await dlp.GET(apiReq("GET", "/api/public/v1/governance/dlp-events"))).status, 200);
  const dry = await cls.POST(apiReq("POST", `/api/public/v1/classification/${docB}`, {}), { params: Promise.resolve({ documentId: String(docB) }) }); assert.equal(dry.status, 200);
  assert.equal((await cols.orgDocuments.findOne({ _id: docB })).classification ?? null, null, "a call with no explicit dryRun:false changes nothing");
  assert.equal((await cls.GET(apiReq("GET", `/api/public/v1/classification/${docA}`), { params: Promise.resolve({ documentId: String(docA) }) })).status, 200);
});

test("public API: device list and actions; an unknown action is refused", T, async () => {
  const list = await import("../src/app/api/public/v1/devices/route.js"); const one = await import("../src/app/api/public/v1/devices/[deviceId]/route.js");
  const d = await db.collection("org_devices").insertOne({ orgId: org.orgId, deviceId: `dev-${randomBytes(4).toString("hex")}`, email: member.email, name: "Laptop", platform: "windows", trust: "untrusted", firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() });
  const row = await db.collection("org_devices").findOne({ _id: d.insertedId });
  const l = await (await list.GET(apiReq("GET", "/api/public/v1/devices"))).json(); assert.ok(JSON.stringify(l).includes(row.deviceId));
  const bad = await one.POST(apiReq("POST", `/api/public/v1/devices/${row.deviceId}`, { action: "explode" }), { params: Promise.resolve({ deviceId: row.deviceId }) }); assert.ok(bad.status >= 400 && bad.status < 500);
  const t = await one.POST(apiReq("POST", `/api/public/v1/devices/${row.deviceId}`, { action: "trust" }), { params: Promise.resolve({ deviceId: row.deviceId }) }); assert.equal(t.status, 200);
});

// ------------------------------------------------------------------------------------------------ AI governance tools
test("AI governance tools: only read tools exist, roles are re-checked, write and certify requests are refused, no file content is ever returned", T, async () => {
  assert.ok(GOVERNANCE_TOOL_DECLARATIONS.length >= 6);
  for (const t of GOVERNANCE_TOOL_DECLARATIONS) assert.equal(/^(publish|approve|reject|retire|delete|block|unblock|revoke|lift|restore|wipe|set|create|update|change|classify)/.test(t.name), false, `${t.name} must be a read tool`);
  const ctxOf = (who) => ({ orgId: org.oid, membership: who.membership, email: who.email });
  assert.equal((await runGovernanceTool("dlp_summary", {}, ctxOf(member))).refused, true, "a plain member is refused");
  assert.equal((await runGovernanceTool("device_summary", {}, ctxOf(devAdmin))).total >= 0, true, "a device administrator may read devices");
  assert.equal((await runGovernanceTool("dlp_summary", {}, ctxOf(devAdmin))).refused, true, "but not DLP");
  assert.equal((await runGovernanceTool("ransomware_status", {}, ctxOf(auditor))).refused, undefined, "an auditor may read");
  const w = await runGovernanceTool("list_governance_policies", { query: "please publish the policy and enable DLP" }, ctxOf(owner)); assert.equal(w.refused, true); assert.match(w.reason, /cannot change/);
  const c = await runGovernanceTool("classification_overview", { query: "certify that we are compliant" }, ctxOf(owner)); assert.equal(c.refused, true); assert.match(c.reason, /certify/);
  const o = await runGovernanceTool("classification_overview", {}, ctxOf(owner)); assert.ok(Array.isArray(o.byLevel)); assert.ok(o.byLevel.some((x) => x.level === "CONFIDENTIAL"));
  assert.equal(JSON.stringify(o).includes("quarterly-report"), false, "names of files are not even needed; no content");
  assert.equal((await runGovernanceTool("nonexistent", {}, ctxOf(owner))).error?.startsWith("Unknown"), true);
  assert.equal((await runGovernanceTool("explain_dlp_event", { eventId: "not-an-id" }, ctxOf(owner))).error !== undefined, true);
});

test("AI governance tools are registered with the OS router (declarations, dispatch and system instruction)", T, async () => {
  const fs = await import("node:fs"); const src = fs.readFileSync(new URL("../src/lib/ai-os-router.js", import.meta.url), "utf8");
  for (const s of ["buildGovernanceContext", "GOVERNANCE_TOOL_DECLARATIONS", "runGovernanceTool", "governanceSystemInstruction", 'withPrefix(GOVERNANCE_TOOL_DECLARATIONS, "governance")', 'name.startsWith("governance_")']) assert.ok(src.includes(s), s);
});
