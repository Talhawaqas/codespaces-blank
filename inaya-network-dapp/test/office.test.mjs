// test/office.test.mjs -- Microsoft 365 / Office / Outlook integration (INTEGRATION-001/002/003): the adapter's honest status, Office launch URIs, edit sessions with locks, short-lived
// edit tokens and version verification, and Outlook secure links. Real MongoDB and the real sharing and locking engines. Nothing here talks to Microsoft.
// Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=300000 test/office.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { ObjectId } from "mongodb";
import { NextRequest } from "next/server";
import { setup, teardown, makeChatOrg, c as cols } from "./_chat-fixtures.mjs";
import { getOrgCollections, createSession } from "../src/lib/orgs.js";
import { setOrgFeature } from "../src/lib/featureFlags.js";
import { createMemberShare, revokeShare } from "../src/lib/sharing/shares.js";
import * as O from "../src/lib/integrations/office.js";
import * as orgRoute from "../src/app/api/orgs/office/[[...path]]/route.js";
import * as sessRoute from "../src/app/api/office/sessions/[sessionId]/[action]/route.js";

const T = { timeout: 300000 };
const code = (p) => p.then(() => null, (e) => e);
let org, other, owner, editor, viewer, db, dept, proj, doc, sheet, pdf;
const mkDoc = async (filename, extra = {}) => (await cols.orgDocuments.insertOne({ orgId: org.orgId, departmentId: dept, projectId: proj, filename, fileHash: `0xoff-${randomBytes(5).toString("hex")}`, sizeBytes: 500, cidAlpha: "QmA" + randomBytes(3).toString("hex"), cidBeta: "QmB" + randomBytes(3).toString("hex"), uploadedByEmail: owner.email, txHash: "0xfake", status: "DRAFT", accessLevel: "PRIVATE", createdAt: new Date().toISOString(), deletedAt: null, version: 1, ...extra })).insertedId;
const lockOf = async (id) => (await cols.orgDocuments.findOne({ _id: id })).lock;
const asEditor = () => ({ orgId: org.oid, membership: editor.membership, email: editor.email });

before(async () => {
  await setup(); db = (await getOrgCollections()).db; org = await makeChatOrg("off", { people: ["editor", "viewer"] }); other = await makeChatOrg("off2", { people: [] }); owner = org.owner; editor = org.editor; viewer = org.viewer;
  for (const o of [org, other]) await setOrgFeature({ orgId: o.oid, name: "FEATURE_ADVANCED_SHARING", enabled: true });
  dept = (await cols.departments.insertOne({ orgId: org.orgId, name: "Legal", createdAt: new Date().toISOString() })).insertedId; proj = (await cols.projects.insertOne({ orgId: org.orgId, departmentId: dept, name: "Contracts", createdAt: new Date().toISOString(), createdByEmail: owner.email })).insertedId;
  doc = await mkDoc("Master services agreement.docx"); sheet = await mkDoc("Budget.xlsx"); pdf = await mkDoc("Scan.pdf");
  for (const id of [doc, sheet, pdf]) { await createMemberShare({ orgId: org.oid, documentId: String(id), actorEmail: owner.email, targetEmail: editor.email, permission: "edit" }); await createMemberShare({ orgId: org.oid, documentId: String(id), actorEmail: owner.email, targetEmail: viewer.email, permission: "view" }); }
  editor = { ...editor, membership: await cols.orgMembers.findOne({ orgId: org.orgId, email: editor.email }) }; viewer = { ...viewer, membership: await cols.orgMembers.findOne({ orgId: org.orgId, email: viewer.email }) };
});
after(async () => { for (const n of ["office_edit_sessions", "documentShares", "documentPermissions"]) await db.collection(n).deleteMany({ orgId: { $in: [org.orgId, other.orgId] } }).catch(() => {}); await cols.documentShares.deleteMany({ orgId: org.orgId }).catch(() => {}); await cols.orgDocuments.deleteMany({ orgId: org.orgId }); await cols.projects.deleteMany({ orgId: org.orgId }); await cols.departments.deleteMany({ orgId: org.orgId }); await teardown(); });

test("the adapter is honest: sovereign capabilities are available, Microsoft-side ones depend on a real connection, and what it never does is stated", T, async () => {
  const s = await O.adapterStatus({ orgId: org.oid }); const by = Object.fromEntries(s.capabilities.map((c) => [c.id, c]));
  assert.equal(by.office_editing.status, "AVAILABLE"); assert.equal(by.outlook_links.status, "AVAILABLE"); assert.equal(by.office_editing.mode, "SOVEREIGN");
  if (!s.platformAppRegistered) assert.equal(by.graph_identity.status, "NOT_CONFIGURED", "no Microsoft app registration, so not claimed"); else assert.ok(["AVAILABLE", "NOT_CONNECTED"].includes(by.graph_identity.status));
  assert.ok(s.neverDoes.some((x) => /plaintext/i.test(x)) && s.neverDoes.some((x) => /Office on the web/i.test(x))); assert.match(s.verified, /Not exercised against a live Microsoft 365 tenant/); assert.ok(Array.isArray(s.connections));
});

test("Office launch URIs: only Office apps, only https or local file URLs, never credentials, edit and view-only forms", T, () => {
  assert.equal(O.buildLaunchUri({ app: "word", fileUrl: "https://files.example.com/a b.docx" }), "ms-word:ofe|u|https://files.example.com/a%20b.docx");
  assert.equal(O.buildLaunchUri({ app: "excel", fileUrl: "file:///C:/Temp/Budget.xlsx", mode: "view" }), "ms-excel:ofv|u|file:///C:/Temp/Budget.xlsx"); assert.match(O.buildLaunchUri({ app: "powerpoint", fileUrl: "https://x.example/p.pptx" }), /^ms-powerpoint:ofe\|u\|/);
  for (const bad of [{ app: "notepad", fileUrl: "https://x.example/a" }, { app: "word", fileUrl: "javascript:alert(1)" }, { app: "word", fileUrl: "ftp://x.example/a.docx" }, { app: "word", fileUrl: "https://user:pw@x.example/a.docx" }, { app: "word", fileUrl: "not a url" }]) assert.throws(() => O.buildLaunchUri(bad), (e) => e.status === 400, JSON.stringify(bad));
});

let s1, tok1;
test("starting an edit: needs Edit access and an Office file; takes the lock; the token is shown once and only its hash is kept; a second person is refused while it is held", T, async () => {
  assert.equal((await code(O.startEditSession({ orgId: org.oid, membership: viewer.membership, email: viewer.email, documentId: String(doc) })))?.status, 403, "view-only cannot edit");
  assert.equal((await code(O.startEditSession({ ...asEditor(), documentId: String(pdf) })))?.status, 400, "a PDF is not an Office file");
  assert.equal((await code(O.startEditSession({ orgId: other.oid, membership: other.owner.membership, email: other.owner.email, documentId: String(doc) })))?.status, 404, "another organization cannot reach it");
  const r = await O.startEditSession({ ...asEditor(), documentId: String(doc), leaseMinutes: 20 }); s1 = r.session; tok1 = r.editToken; assert.match(tok1, /^ied_/); assert.equal(s1.app, "word"); assert.equal(s1.status, "active"); assert.match(r.dataFlow, /never sent to Microsoft/);
  const lock = await lockOf(doc); assert.equal(lock.byEmail, editor.email.toLowerCase()); const raw = await db.collection("office_edit_sessions").findOne({ _id: new ObjectId(s1.sessionId) }); assert.equal(JSON.stringify(raw).includes(tok1), false, "the token itself is never stored"); assert.equal(raw.tokenHash.length, 64);
  assert.equal((await code(O.startEditSession({ orgId: org.oid, membership: owner.membership, email: owner.email, documentId: String(doc) })))?.status, 423, "the file is locked by the editor");
  assert.equal((await O.listSessions({ orgId: org.oid, membership: editor.membership, email: editor.email })).sessions.length, 1); assert.equal((await code(O.listSessions({ orgId: org.oid, membership: editor.membership, email: editor.email, scope: "org" })))?.status, 403);
  assert.equal((await O.listSessions({ orgId: org.oid, membership: owner.membership, email: owner.email, scope: "org" })).sessions.length, 1);
});

test("the edit token authorizes exactly one session: wrong, missing, borrowed and malformed tokens are refused; content pointers are only served while it is active", T, async () => {
  assert.equal((await code(O.renewSession({ sessionId: s1.sessionId, token: "ied_wrong" })))?.status, 401); assert.equal((await code(O.renewSession({ sessionId: s1.sessionId, token: "" })))?.status, 401); assert.equal((await code(O.renewSession({ sessionId: "nope", token: tok1 })))?.status, 401);
  const r2 = await O.startEditSession({ ...asEditor(), documentId: String(sheet) }); assert.equal((await code(O.renewSession({ sessionId: s1.sessionId, token: r2.editToken })))?.status, 401, "another session's token cannot act on this one"); assert.equal((await code(O.sessionContent({ sessionId: r2.session.sessionId, token: tok1 })))?.status, 401);
  const before = (await lockOf(doc)).expiresAt; const ren = await O.renewSession({ sessionId: s1.sessionId, token: tok1, leaseMinutes: 120 }); assert.ok(new Date(ren.expiresAt) > new Date(before), "renewing extends the lease"); assert.equal((await lockOf(doc)).expiresAt, ren.expiresAt);
  const c = await O.sessionContent({ sessionId: s1.sessionId, token: tok1 }); assert.equal(c.encrypted, true); assert.equal(c.filename, "Master services agreement.docx"); assert.ok(c.cidAlpha && c.cidBeta);
  assert.ok((await cols.orgActivity.countDocuments({ orgId: org.orgId, recordType: "OFFICE_EDIT", action: "CONTENT_FETCHED" })) >= 1, "fetching the content is recorded");
  await db.collection("office_edit_sessions").updateOne({ _id: new ObjectId(r2.session.sessionId) }, { $set: { expiresAt: new Date(Date.now() - 1000).toISOString() } }); const exp = await code(O.renewSession({ sessionId: r2.session.sessionId, token: r2.editToken })); assert.equal(exp?.code, "SESSION_EXPIRED");
  assert.equal((await O.expireSessions()).expired >= 0, true); await O.abortSession({ sessionId: r2.session.sessionId, token: r2.editToken }).catch(() => {});
  await cols.orgDocuments.updateOne({ _id: sheet }, { $unset: { lock: "" } });
});

test("finishing: only a REAL new version written by this person during this session, directly after the base version, ends the edit; the lock is released and the audit chain says so", T, async () => {
  const fin = (newDocumentId) => O.finishSession({ sessionId: s1.sessionId, token: tok1, newDocumentId });
  assert.equal((await code(fin(undefined)))?.status, 400); assert.equal((await code(fin(String(new ObjectId()))))?.code, "NO_NEW_VERSION");
  assert.equal((await code(fin(String(doc))))?.code, "NOT_A_NEW_VERSION", "the original file is not a new version");
  const base = await cols.orgDocuments.findOne({ _id: doc }); const group = base.documentGroupId || base._id;
  const wrongGroup = await mkDoc("Master services agreement.docx", { documentGroupId: new ObjectId(), version: 2, uploadedByEmail: editor.email }); assert.equal((await code(fin(String(wrongGroup))))?.code, "NOT_A_NEW_VERSION", "a different document");
  const bySomeoneElse = await mkDoc("Master services agreement.docx", { documentGroupId: group, version: 2, uploadedByEmail: owner.email }); assert.equal((await code(fin(String(bySomeoneElse))))?.code, "NOT_A_NEW_VERSION", "written by someone else");
  const skipped = await mkDoc("Master services agreement.docx", { documentGroupId: group, version: 5, uploadedByEmail: editor.email }); assert.equal((await code(fin(String(skipped))))?.code, "NOT_A_NEW_VERSION", "not directly after the base version");
  await cols.orgDocuments.deleteMany({ _id: { $in: [skipped, bySomeoneElse, wrongGroup] } }); // the negative cases are not real versions
  const good = await mkDoc("Master services agreement.docx", { documentGroupId: group, version: 2, uploadedByEmail: editor.email, supersedesId: doc }); const ok = await fin(String(good)); assert.equal(ok.finished, true); assert.equal(ok.newVersion, 2);
  assert.equal(await lockOf(doc), undefined, "the lock is released"); const row = await db.collection("office_edit_sessions").findOne({ _id: new ObjectId(s1.sessionId) }); assert.equal(row.status, "finished"); assert.equal(String(row.newDocumentId), String(good));
  assert.equal((await code(fin(String(good))))?.code, "SESSION_FINISHED", "a session finishes once"); assert.equal((await code(O.renewSession({ sessionId: s1.sessionId, token: tok1 })))?.code, "SESSION_FINISHED");
  const log = await cols.orgActivity.find({ orgId: org.orgId, recordType: "OFFICE_EDIT" }).toArray(); const f = log.find((e) => e.action === "FINISHED"); assert.ok(f && f.metadata.newVersion === 2 && f.metadata.app === "word");
  assert.equal((await code(O.startEditSession({ ...asEditor(), documentId: String(doc) })))?.code, "NOT_LATEST", "the old version can no longer be opened for editing");
  const again = await O.startEditSession({ ...asEditor(), documentId: String(good) }); assert.equal(again.session.baseVersion, 2); await O.abortSession({ sessionId: again.session.sessionId, token: again.editToken });
});

test("abort releases the lock and writes no version; the helper's HTTP endpoints enforce the bearer token; the organization route needs a session and a feature switch", T, async () => {
  const r = await O.startEditSession({ ...asEditor(), documentId: String(sheet) }); const ab = await O.abortSession({ sessionId: r.session.sessionId, token: r.editToken }); assert.deepEqual(ab, { aborted: true, versionWritten: false }); assert.equal(await lockOf(sheet), undefined);
  assert.equal((await code(O.abortSession({ sessionId: r.session.sessionId, token: r.editToken })))?.code, "SESSION_ABORTED");
  const live = await O.startEditSession({ ...asEditor(), documentId: String(sheet) }); const call = (action, method, token, body) => sessRoute[method](new NextRequest(`http://localhost:3000/api/office/sessions/${live.session.sessionId}/${action}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), { params: Promise.resolve({ sessionId: live.session.sessionId, action }) });
  assert.equal((await call("content", "GET", null)).status, 401); assert.equal((await call("content", "GET", "ied_nope")).status, 401); const c = await call("content", "GET", live.editToken); assert.equal(c.status, 200); assert.equal((await c.json()).encrypted, true);
  assert.equal((await call("renew", "POST", live.editToken, { leaseMinutes: 45 })).status, 200); assert.equal((await call("finish", "POST", live.editToken, {})).status, 400); assert.equal((await call("explode", "POST", live.editToken)).status, 404); assert.equal((await call("abort", "POST", live.editToken)).status, 200);
  const cookie = (await createSession(editor.email)).sessionToken; const req = (path, method = "GET", body) => new NextRequest(`http://localhost:3000/api/orgs/office/${path}${path.includes("?") ? "&" : "?"}orgId=${org.oid}`, { method, headers: { cookie: `inaya_org_session=${cookie}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }); const ctx = (p) => ({ params: Promise.resolve({ path: p.split("/") }) });
  const st = await orgRoute.GET(req("status"), ctx("status")); assert.equal(st.status, 200); assert.ok((await st.json()).capabilities.length >= 4);
  const l = await orgRoute.POST(req("launch", "POST", { app: "word", fileUrl: "https://x.example/a.docx" }), ctx("launch")); assert.equal(l.status, 200); assert.match((await l.json()).uri, /^ms-word:ofe/);
  assert.equal((await orgRoute.POST(req("launch", "POST", { app: "word", fileUrl: "javascript:1" }), ctx("launch"))).status, 400);
  const sx = await orgRoute.POST(req("sessions", "POST", { documentId: String(sheet) }), ctx("sessions")); assert.equal(sx.status, 201); const sj = await sx.json(); assert.match(sj.editToken, /^ied_/); await O.abortSession({ sessionId: sj.session.sessionId, token: sj.editToken });
  assert.equal((await orgRoute.GET(new NextRequest(`http://localhost:3000/api/orgs/office/status?orgId=${org.oid}`), ctx("status"))).status, 401, "no session, no access");
  await setOrgFeature({ orgId: org.oid, name: "FEATURE_ADVANCED_SHARING", enabled: false }); assert.ok([403, 404].includes((await orgRoute.POST(req("sessions", "POST", { documentId: String(sheet) }), ctx("sessions"))).status), "the feature switch applies"); await setOrgFeature({ orgId: org.oid, name: "FEATURE_ADVANCED_SHARING", enabled: true });
});

let linkA;
test("Outlook secure links: need Manage access; policy-enforced; the e-mail block carries expiry and reminders but never the password; everything is escaped", T, async () => {
  const mk = (o = {}) => O.createOutlookLink({ orgId: org.oid, membership: owner.membership, email: owner.email, documentId: String(doc), origin: "https://app.example.com/", expirationPreset: "7d", ...o });
  assert.equal((await code(O.createOutlookLink({ orgId: org.oid, membership: editor.membership, email: editor.email, documentId: String(doc), origin: "https://app.example.com", expirationPreset: "7d" })))?.status, 403, "Edit is not enough to share");
  assert.equal((await code(mk({ expirationPreset: undefined })))?.status, 400, "an expiry is required"); assert.equal((await code(mk({ customExpiresAt: "2000-01-01", expirationPreset: undefined })))?.status, 400);
  const secret = "Sup3r-secret-pw!"; const r = await mk({ options: { password: secret, domainAllow: ["partner.example"], oneTime: true }, note: "Please review <b>today</b>" }); linkA = r;
  assert.match(r.url, /^https:\/\/app\.example\.com\/business\/share\/[A-Za-z0-9_-]{20,}$/); assert.ok(new Date(r.expiresAt) > new Date());
  const all = JSON.stringify(r.block); assert.equal(all.includes(secret), false, "the password is never in the e-mail"); assert.match(r.block.text, /password protected\. The password is shared separately/); assert.match(r.block.text, /Only people at partner\.example/); assert.match(r.block.text, /opened once/); assert.match(r.block.text, /expires on/);
  assert.ok(r.block.html.includes(r.url) && r.block.html.includes("&lt;b&gt;today&lt;/b&gt;") && !r.block.html.includes("<b>today"), "note text is escaped");
  const evil = await mkDoc("<img src=x onerror=alert(1)>.docx"); await createMemberShare({ orgId: org.oid, documentId: String(evil), actorEmail: owner.email, targetEmail: editor.email, permission: "view" }); const e = await O.createOutlookLink({ orgId: org.oid, membership: owner.membership, email: owner.email, documentId: String(evil), origin: "https://app.example.com", expirationPreset: "24h" }); assert.equal(e.block.html.includes("<img"), false, "a hostile file name cannot inject markup");
  const share = await cols.documentShares.findOne({ _id: new ObjectId(r.shareId) }); assert.equal(share.createdVia, "outlook"); assert.equal(share.passwordHash && share.passwordHash.includes(secret), false); assert.deepEqual(share.domainAllow, ["partner.example"]);
  assert.equal(JSON.stringify(await cols.orgActivity.find({ orgId: org.orgId, recordType: "OUTLOOK_LINK" }).toArray()).includes(secret), false, "the audit trail never holds it either");
});

test("managing and inspecting Outlook links: listed for the person who made them, revocable, and inspection never reveals the token or the file", T, async () => {
  const mine = await O.listOutlookLinks({ orgId: org.oid, email: owner.email }); const row = mine.links.find((l) => l.shareId === linkA.shareId); assert.ok(row && row.status === "active" && row.passwordProtected && row.filename);
  assert.equal((await O.listOutlookLinks({ orgId: org.oid, email: editor.email })).links.length, 0, "someone else's links are not listed");
  const ins = await O.inspectLink({ url: linkA.url }); assert.equal(ins.recognized, true); assert.equal(ins.status, "active"); assert.equal(ins.passwordProtected, true); assert.equal(ins.restrictedToDomains, true); assert.equal(ins.oneTime, true);
  const text = JSON.stringify(ins); assert.equal(text.includes(linkA.url.split("/").pop()), false, "no token"); assert.equal(/Master services|docx/.test(text), false, "no file name");
  assert.equal((await code(O.inspectLink({ url: "https://evil.example/not-inaya" })))?.status, 400); assert.equal((await O.inspectLink({ url: "https://app.example.com/business/share/" + "x".repeat(40) })).recognized, false);
  await revokeShare({ orgId: org.oid, shareId: linkA.shareId, actorEmail: owner.email, membership: owner.membership }); assert.equal((await O.inspectLink({ url: linkA.url })).status, "revoked"); assert.equal((await O.listOutlookLinks({ orgId: org.oid, email: owner.email })).links.find((l) => l.shareId === linkA.shareId).status, "revoked");
  const cookie = (await createSession(owner.email)).sessionToken; const req = (path, method = "GET", body) => new NextRequest(`http://localhost:3000/api/orgs/office/${path}${path.includes("?") ? "&" : "?"}orgId=${org.oid}`, { method, headers: { cookie: `inaya_org_session=${cookie}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }); const ctx = (p) => ({ params: Promise.resolve({ path: p.split("/") }) });
  const made = await orgRoute.POST(req("outlook/links", "POST", { documentId: String(doc), expirationPreset: "24h" }), ctx("outlook/links")); assert.equal(made.status, 201); const mj = await made.json(); assert.ok(mj.block.html && mj.url);
  assert.equal((await orgRoute.GET(req("outlook/links"), ctx("outlook/links"))).status, 200); assert.equal((await orgRoute.DELETE(req(`outlook/links/${mj.shareId}`, "DELETE"), ctx(`outlook/links/${mj.shareId}`))).status, 200);
  const ir = await orgRoute.POST(req("outlook/inspect", "POST", { url: mj.url }), ctx("outlook/inspect")); assert.equal((await ir.json()).status, "revoked");
});

test("the Outlook add-in files are well formed and consistent: valid manifest XML, matching task pane URL, icons present, no inline script, password never written to the message", T, () => {
  const dir = new URL("../public/outlook/", import.meta.url); const m = fs.readFileSync(new URL("manifest.xml", dir), "utf8"); const html = fs.readFileSync(new URL("taskpane.html", dir), "utf8"); const js = fs.readFileSync(new URL("taskpane.js", dir), "utf8");
  const opens = (m.match(/<([A-Za-z][\w:]*)(\s[^<>]*?)?(?<!\/)>/g) || []).filter((t) => !t.startsWith("<?")).length; const closes = (m.match(/<\/[A-Za-z][\w:]*>/g) || []).length; assert.equal(opens, closes, "every element is closed");
  assert.match(m, /<OfficeApp[\s\S]*xsi:type="MailApp"/); assert.match(m, /<Permissions>ReadWriteItem<\/Permissions>/); assert.ok(/<Id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}<\/Id>/.test(m));
  for (const u of m.match(/https:\/\/www\.inayanetwork\.com\/outlook\/[\w.-]+/g)) { const f = u.split("/").pop(); assert.ok(fs.existsSync(new URL(f, dir)), `${f} exists`); }
  assert.ok(html.includes("taskpane.js") && !/<script>[^<]/.test(html.replace(/<script src[^>]*><\/script>/g, "")), "no inline script"); assert.match(js, /setSelectedDataAsync/); assert.equal(/password.*setSelectedDataAsync|setSelectedDataAsync.*\$\("pw"\)/.test(js), false);
  assert.ok(/options\.password = \$\("pw"\)\.value/.test(js) && /r\.block\.html/.test(js), "the password goes to Inaya, and only the server-built block goes into the message"); assert.equal(/innerHTML/.test(js), false, "no innerHTML");
});
