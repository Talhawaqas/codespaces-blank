// test/portal-requests.test.mjs -- customer portal requests (PORTAL-001): staff-created requests with upload, download, secure form and agreement items; strict
// per-customer isolation; encrypted answers; hashed agreements; status, comments, history and notifications; the real portal sign-in and the real HTTP route handlers.
// Real MongoDB and real encrypted storage. Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=300000 test/portal-requests.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { setup, cleanup, makeSupportOrg, portalSession, sc, c as cols } from "./_support-fixtures.mjs";
import * as PR from "../src/lib/support/portalRequests.js";
import { handlePortal } from "../src/lib/support/portalApi.js";
import * as uploadRoute from "../src/app/api/portal/[slug]/request-files/route.js";
import * as downloadRoute from "../src/app/api/portal/[slug]/request-files/[fileId]/route.js";
import * as staffRoute from "../src/app/api/orgs/portal-requests/[[...path]]/route.js";
import { createSession } from "../src/lib/orgs.js";
import { NextRequest } from "next/server";

const T = { timeout: 300000 };
let org, other, alice, bob, otherAlice, S;
const PDF = (n = 200) => Buffer.concat([Buffer.from("%PDF-1.4\n"), randomBytes(n)]);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const staff = (who = org.agent) => ({ orgId: org.oid, settings: org.settings, membership: who.membership, actorEmail: who.email });
const mkReq = async (items, o = {}) => { const r = await PR.createRequest({ ...staff(), customerEmail: alice.user.email, title: o.title || "Onboarding", instructions: "Please complete these.", items }); assert.ok(r.request, JSON.stringify(r)); return r.request; };
const ITEMS = () => [
  { kind: "upload", title: "Signed contract", accept: ["pdf"], maxFiles: 2 },
  { kind: "form", title: "Company details", fields: [{ key: "legal_name", label: "Legal name", type: "text", required: true }, { key: "employees", label: "Employees", type: "number" }, { key: "tier", label: "Tier", type: "select", options: ["Basic", "Plus"], required: true }, { key: "agree", label: "Authorised", type: "checkbox", required: true }, { key: "since", label: "Customer since", type: "date" }] },
  { kind: "ack", title: "Mutual NDA", text: "Both parties agree to keep the exchanged information confidential for five years." },
  { kind: "download", title: "Your welcome pack", required: false },
];
const itemOf = (req, kind) => req.items.find((i) => i.kind === kind);
const portalReq = (user, token, method, path, body, extra = {}) => new Request(`http://localhost:3000/api/portal/${org.slug}/${path}`, { method, headers: { cookie: `inaya_portal_session=${token}`, "x-portal-request": "1", host: "localhost:3000", ...extra } , ...(body ? { body } : {}) });

before(async () => {
  S = await setup(); org = await makeSupportOrg("preq"); other = await makeSupportOrg("preq2");
  alice = await portalSession(org, org.alice.email); bob = await portalSession(org, org.bob.email); otherAlice = await portalSession(other, other.alice.email);
});
after(async () => { try { for (const n of ["supportPortalRequests", "supportPortalRequestFiles"]) await sc.db.collection(n).deleteMany({ orgId: { $in: [org.orgId, other.orgId] } }); } catch { /* best effort */ } await cleanup(); });

test("creating a request: support staff only; validation; the customer is notified in the portal", T, async () => {
  const bad = (items, o = {}) => PR.createRequest({ ...staff(), customerEmail: alice.user.email, title: "x", items, ...o });
  assert.equal((await PR.createRequest({ ...staff(org.plain), customerEmail: alice.user.email, title: "x", items: ITEMS() })).status, 403, "a member without a support role cannot");
  assert.ok((await PR.createRequest({ ...staff(org.manager), customerEmail: alice.user.email, title: "By a manager", items: [ITEMS()[2]] })).request);
  for (const [r, why] of [[await bad([]), "no items"], [await bad([{ kind: "teleport", title: "x" }]), "unknown kind"], [await bad([{ kind: "upload", title: "" }]), "no title"], [await bad([{ kind: "ack", title: "NDA", text: "short" }]), "short agreement"],
    [await bad([{ kind: "form", title: "F", fields: [{ key: "Bad Key", label: "x", type: "text" }] }]), "bad field key"], [await bad([{ kind: "form", title: "F", fields: [{ key: "a", label: "x", type: "select", options: ["one"] }] }]), "select needs two options"],
    [await bad([{ kind: "form", title: "F", fields: [{ key: "a", label: "x", type: "text" }, { key: "a", label: "y", type: "text" }] }]), "duplicate key"], [await bad(ITEMS(), { customerEmail: "nope" }), "bad e-mail"], [await bad(ITEMS(), { dueAt: "2020-01-01" }), "due in the past"], [await bad(new Array(21).fill({ kind: "ack", title: "n", text: "x".repeat(30) })), "too many items"]]) assert.ok(r.error && r.status !== 500, `${why}: ${JSON.stringify(r).slice(0, 80)}`);
  const req = await mkReq(ITEMS()); assert.equal(req.status, "OPEN"); assert.equal(req.items.length, 4); assert.equal(req.progress.required, 3); assert.equal(req.items[1].fields[2].options.length, 2);
  const note = await sc.supportCustomerNotifications.findOne({ orgId: org.orgId, type: "portal_request", dedupeKey: `preq:${req.requestId}:new` }); assert.ok(note && /Onboarding/.test(note.title));
  globalThis.__req = req;
});

test("isolation: a customer sees only their own requests; another customer, another portal and another organization's staff get nothing", T, async () => {
  const req = globalThis.__req;
  assert.equal((await PR.listForCustomer({ orgId: org.oid, user: alice.user })).requests.length >= 2, true);
  assert.equal((await PR.listForCustomer({ orgId: org.oid, user: bob.user })).requests.length, 0, "bob sees nothing of alice's");
  assert.equal((await PR.getForCustomer({ orgId: org.oid, user: bob.user, requestId: req.requestId })).status, 404);
  assert.equal((await PR.customerComment({ orgId: org.oid, user: bob.user, requestId: req.requestId, text: "hi" })).status, 404);
  assert.equal((await PR.customerAccept({ orgId: org.oid, user: bob.user, requestId: req.requestId, itemId: itemOf(req, "ack").itemId, name: "Bob B", textHash: itemOf(req, "ack").textHash })).status, 404);
  assert.equal((await PR.customerForm({ orgId: org.oid, user: bob.user, requestId: req.requestId, itemId: itemOf(req, "form").itemId, values: {} })).status, 404);
  assert.equal((await PR.customerUpload({ orgId: org.oid, settings: org.settings, user: bob.user, requestId: req.requestId, itemId: itemOf(req, "upload").itemId, filename: "a.pdf", buffer: PDF() })).status, 404);
  assert.equal((await PR.getForCustomer({ orgId: other.oid, user: otherAlice.user, requestId: req.requestId })).status, 404, "another portal's customer with the same name");
  assert.equal((await PR.listRequests({ orgId: other.oid, membership: other.agent.membership })).requests.length, 0, "another organization's staff see none of ours");
  assert.equal((await PR.getRequestStaff({ orgId: other.oid, membership: other.agent.membership, requestId: req.requestId })).status, 404);
  assert.equal((await PR.listForCustomer({ orgId: other.oid, user: alice.user })).requests.length, 0, "a session for one portal cannot read another's requests");
  assert.equal((await PR.getRequestStaff({ orgId: org.oid, membership: org.plain.membership, requestId: req.requestId })).status, 403);
});

test("secure form: validated field by field, answers stored encrypted, shown to staff (audited) and to the customer, submitted once", T, async () => {
  const req = globalThis.__req; const it = itemOf(req, "form"); const submit = (values) => PR.customerForm({ orgId: org.oid, user: alice.user, requestId: req.requestId, itemId: it.itemId, values });
  const bad = await submit({ employees: "lots", tier: "Gold", extra: 1, since: "yesterday" }); assert.equal(bad.status, 400); assert.equal(bad.reasonCode, "FORM_INVALID");
  for (const k of ["legal_name", "employees", "tier", "agree", "since", "extra"]) assert.ok(bad.errors[k], `error for ${k}`);
  const secret = `Zebra Holdings ${randomBytes(3).toString("hex")} <script>`; const ok = await submit({ legal_name: secret, employees: "250", tier: "Plus", agree: true, since: "2024-03-01" }); assert.equal(ok.ok, true);
  const raw = await sc.db.collection("supportPortalRequests").findOne({ _id: new (await import("mongodb")).ObjectId(req.requestId) }); const rawText = JSON.stringify(raw); assert.equal(rawText.includes("Zebra"), false, "answers are not stored in the clear"); assert.ok(raw.items.find((i) => i.kind === "form").responseEnc);
  assert.equal((await submit({ legal_name: "again", tier: "Basic", agree: true })).status, 409, "a form is submitted once");
  const st = await PR.getRequestStaff({ orgId: org.oid, membership: org.agent.membership, requestId: req.requestId, actorEmail: org.agent.email }); const resp = itemOf(st.request, "form").response; assert.equal(resp.employees, 250); assert.equal(resp.tier, "Plus"); assert.ok(resp.legal_name.startsWith("Zebra Holdings") && !resp.legal_name.includes("<"), "text is stored as plain text");
  assert.ok((await cols.orgActivity.countDocuments({ orgId: org.orgId, recordType: "PORTAL_REQUEST", action: "RESPONSES_VIEWED" })) >= 1, "a staff member reading the answers is recorded");
  const mine = await PR.getForCustomer({ orgId: org.oid, user: alice.user, requestId: req.requestId }); assert.equal(itemOf(mine.request, "form").response.tier, "Plus"); assert.equal(itemOf(mine.request, "form").state, "DONE");
  assert.ok((await PR.listRequests({ orgId: org.oid, membership: org.agent.membership })).requests.every((r) => !("items" in r)), "the list never carries answers");
});

test("agreement: the exact text is hashed, a changed text is refused, a typed name is required, acceptance is recorded once with a masked address", T, async () => {
  const req = globalThis.__req; const it = itemOf(req, "ack"); const acc = (o) => PR.customerAccept({ orgId: org.oid, user: alice.user, requestId: req.requestId, itemId: it.itemId, ip: "203.0.113.77", ...o });
  assert.equal(it.textHash, sha(it.text));
  assert.equal((await acc({ name: "Alice Customer", textHash: sha("a different text") })).reasonCode, "TEXT_CHANGED"); assert.ok((await acc({ name: "A", textHash: it.textHash })).error, "a real name is required");
  const ok = await acc({ name: "Alice Customer", textHash: it.textHash }); assert.equal(ok.ok, true); assert.equal(ok.acceptance.textHash, it.textHash);
  assert.equal((await acc({ name: "Alice Customer", textHash: it.textHash })).status, 409, "accepted once");
  const row = await sc.db.collection("supportPortalRequests").findOne({ _id: new (await import("mongodb")).ObjectId(req.requestId) }); const a = row.items.find((i) => i.kind === "ack").acceptance; assert.equal(a.ipMasked, "203.0.113.0"); assert.equal(a.email, alice.user.email);
  const log = await cols.orgActivity.find({ orgId: org.orgId, recordType: "PORTAL_REQUEST", action: "AGREEMENT_ACCEPTED" }).toArray(); assert.ok(log.length >= 1 && log.every((e) => e.metadata.textHash === it.textHash && !JSON.stringify(e.metadata).includes("203.0.113.77")), "audited, with the hash and no full address");
});

test("upload: type filter, file count, size limit, blocked and mismatching files refused; a real file is stored encrypted and only its owner can read it back", T, async () => {
  const req = globalThis.__req; const it = itemOf(req, "upload"); const up = (filename, buffer, user = alice.user) => PR.customerUpload({ orgId: org.oid, settings: org.settings, user, requestId: req.requestId, itemId: it.itemId, filename, buffer });
  assert.equal((await up("notes.docx", Buffer.from("PK\u0003\u0004 x"))).status, 400, "only the accepted types");
  assert.equal((await up("run.exe.pdf", PDF())).status, 400, "double extension"); assert.ok((await up("a.pdf", Buffer.from("not really a pdf"))).error, "content must match the type");
  assert.equal((await up("big.pdf", Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(PR.LIMITS.fileBytes + 10)]))).status, 413);
  const bytes = PDF(5000); const ok = await up("signed contract.pdf", bytes); assert.ok(ok.file, JSON.stringify(ok)); assert.equal(ok.file.filename, "signed contract.pdf");
  assert.equal((await up("late.pdf", PDF())).status, 404, "once every required item is done the request is closed to changes");
  const u2 = await mkReq([{ kind: "upload", title: "Two scans", accept: ["pdf"], maxFiles: 2 }, { kind: "ack", title: "Terms", text: "You confirm the scans are genuine copies of the originals." }], { title: "Two files" }); const up2 = (fn, b) => PR.customerUpload({ orgId: org.oid, settings: org.settings, user: alice.user, requestId: u2.requestId, itemId: u2.items[0].itemId, filename: fn, buffer: b });
  assert.ok((await up2("one.pdf", PDF())).file); assert.ok((await up2("two.pdf", PDF())).file); assert.equal((await up2("three.pdf", PDF())).status, 409, "at most two files for this item");
  const dl = await PR.getFileForDownload({ orgId: org.oid, requestId: req.requestId, fileId: ok.file.fileId, viewer: { kind: "customer", user: alice.user } }); assert.deepEqual(dl.buffer, bytes, "round trip is byte for byte");
  assert.equal(await PR.getFileForDownload({ orgId: org.oid, requestId: req.requestId, fileId: ok.file.fileId, viewer: { kind: "customer", user: bob.user } }), null, "another customer cannot");
  assert.equal(await PR.getFileForDownload({ orgId: other.oid, requestId: req.requestId, fileId: ok.file.fileId, viewer: { kind: "customer", user: otherAlice.user } }), null, "nor another portal");
  assert.equal(await PR.getFileForDownload({ orgId: org.oid, requestId: req.requestId, fileId: ok.file.fileId, viewer: { kind: "staff", membership: org.plain.membership } }), null, "nor a member without a support role");
  const sd = await PR.getFileForDownload({ orgId: org.oid, requestId: req.requestId, fileId: ok.file.fileId, viewer: { kind: "staff", membership: org.agent.membership }, actorEmail: org.agent.email }); assert.deepEqual(sd.buffer, bytes);
  assert.ok((await cols.orgActivity.countDocuments({ orgId: org.orgId, recordType: "PORTAL_REQUEST", action: "FILE_DOWNLOADED" })) >= 2, "every download is recorded");
  const stored = await sc.db.collection("supportPortalRequestFiles").findOne({ requestId: new (await import("mongodb")).ObjectId(req.requestId), direction: "in" }); assert.ok(stored.storage.key.startsWith("portal-requests/") && stored.sha256.length === 64 && !stored.buffer, "the database keeps a reference, never the bytes");
});

test("a request completes when every REQUIRED item is done; optional items do not block; staff are told; history and comments record it all", T, async () => {
  const req = globalThis.__req; const mine = await PR.getForCustomer({ orgId: org.oid, user: alice.user, requestId: req.requestId });
  assert.equal(mine.request.status, "COMPLETE", "contract, form and agreement are done; the optional welcome pack is not required"); assert.ok(mine.request.completedAt); assert.deepEqual(mine.request.progress, { done: 3, required: 3 });
  const kinds = mine.request.history.map((h) => h.kind); for (const k of ["CREATED", "STARTED", "ITEM_DONE", "FILE_UPLOADED", "COMPLETED"]) assert.ok(kinds.includes(k), k);
  assert.ok(mine.request.history.find((h) => h.kind === "CREATED").actor === "Staff", "the customer sees 'Staff', not a colleague's address"); assert.equal(mine.request.history.some((h) => /^customer:/.test(h.actor)), false);
  assert.ok(await sc.db.collection("notifications").findOne({ orgId: org.orgId, type: "support", title: /Customer request complete/ }), "the person who made the request is told it is complete");
  assert.equal((await PR.customerComment({ orgId: org.oid, user: alice.user, requestId: req.requestId, text: "All done, thank you <b>!</b>" })).ok, true);
  assert.equal((await PR.staffComment({ ...staff(), requestId: req.requestId, text: "Received, thanks." })).ok, true); const th = (await PR.getForCustomer({ orgId: org.oid, user: alice.user, requestId: req.requestId })).request.comments; assert.deepEqual(th.map((x) => x.by), ["customer", "staff"]); assert.equal(th[0].text.includes("<"), false);
  assert.equal((await PR.staffComment({ ...staff(org.plain), requestId: req.requestId, text: "x" })).status, 403);
});

test("released files: staff release a file for a download item; only the addressed customer can collect it; collecting completes the item; cancelling shuts it", T, async () => {
  const req = await mkReq([{ kind: "download", title: "Welcome pack" }], { title: "Pack" }); const it = req.items[0]; const bytes = PDF(300);
  assert.equal((await PR.releaseFile({ ...staff(org.plain), requestId: req.requestId, itemId: it.itemId, filename: "pack.pdf", buffer: bytes })).status, 403);
  assert.equal((await PR.releaseFile({ ...staff(), requestId: req.requestId, itemId: new Date().getTime().toString(), filename: "pack.pdf", buffer: bytes })).status, 404, "no such item");
  const rel = await PR.releaseFile({ ...staff(), requestId: req.requestId, itemId: it.itemId, filename: "pack.pdf", buffer: bytes }); assert.ok(rel.file);
  assert.ok(await sc.supportCustomerNotifications.findOne({ orgId: org.orgId, type: "portal_request", title: /A file is ready/ }));
  let view = (await PR.getForCustomer({ orgId: org.oid, user: alice.user, requestId: req.requestId })).request; assert.equal(view.items[0].file.filename, "pack.pdf"); assert.equal(view.status, "OPEN");
  assert.equal(await PR.getFileForDownload({ orgId: org.oid, requestId: req.requestId, fileId: rel.file.fileId, viewer: { kind: "customer", user: bob.user } }), null, "bob is not the addressee");
  const got = await PR.getFileForDownload({ orgId: org.oid, requestId: req.requestId, fileId: rel.file.fileId, viewer: { kind: "customer", user: alice.user } }); assert.deepEqual(got.buffer, bytes);
  view = (await PR.getForCustomer({ orgId: org.oid, user: alice.user, requestId: req.requestId })).request; assert.equal(view.items[0].state, "DONE"); assert.equal(view.status, "COMPLETE");
  const r2 = await mkReq([{ kind: "download", title: "Second" }, { kind: "ack", title: "Policy", text: "You agree to follow the acceptable use policy at all times." }], { title: "Cancelled one" }); const rel2 = await PR.releaseFile({ ...staff(), requestId: r2.requestId, itemId: r2.items[0].itemId, filename: "p2.pdf", buffer: bytes });
  assert.equal((await PR.cancelRequest({ ...staff(org.plain), requestId: r2.requestId })).status, 403); assert.equal((await PR.cancelRequest({ ...staff(), requestId: r2.requestId, reason: "sent in error" })).cancelled, true);
  assert.equal((await PR.cancelRequest({ ...staff(), requestId: r2.requestId })).status, 404, "already finished");
  assert.equal(await PR.getFileForDownload({ orgId: org.oid, requestId: r2.requestId, fileId: rel2.file.fileId, viewer: { kind: "customer", user: alice.user } }), null, "a cancelled request releases nothing");
  assert.equal((await PR.customerAccept({ orgId: org.oid, user: alice.user, requestId: r2.requestId, itemId: r2.items[1].itemId, name: "Alice Customer", textHash: r2.items[1].textHash })).status, 404, "and takes nothing");
  assert.equal((await PR.remind({ ...staff(), requestId: r2.requestId })).status, 404);
});

test("reminders reach the customer; the portal API enforces its CSRF header and sign-in; the same operations work through the real HTTP handlers", T, async () => {
  const req = await mkReq([{ kind: "form", title: "Quick form", fields: [{ key: "note", label: "Note", type: "text", required: true }] }, { kind: "upload", title: "Photo ID", accept: ["png", "jpg"], maxFiles: 1 }], { title: "Via HTTP" });
  assert.equal((await PR.remind({ ...staff(), requestId: req.requestId })).reminded, true);
  const org2 = { orgId: org.orgId, settings: org.settings, portalSlug: org.slug }; const call = (user, method, path, body, token = alice.sessionToken) => handlePortal({ method, path, query: {}, body: body || {}, req: new Request("http://localhost:3000/x", { method, headers: { cookie: `inaya_portal_session=${token}`, "x-portal-request": "1", host: "localhost:3000" } }), org: org2, ip: "198.51.100.9" });
  const noCsrf = await handlePortal({ method: "POST", path: ["requests", req.requestId, "comments"], query: {}, body: { text: "x" }, req: new Request("http://localhost:3000/x", { method: "POST", headers: { cookie: `inaya_portal_session=${alice.sessionToken}` } }), org: org2, ip: "1.1.1.1" }); assert.equal(noCsrf.status, 403);
  const noUser = await handlePortal({ method: "GET", path: ["requests"], query: {}, body: {}, req: new Request("http://localhost:3000/x", { headers: {} }), org: org2, ip: "1.1.1.1" }); assert.ok(noUser.status === 401 || noUser.error, "no session, no requests");
  const list = await call(alice.user, "GET", ["requests"]); assert.ok(list.requests.some((r) => r.requestId === req.requestId)); assert.equal((await call(bob.user, "GET", ["requests"], null, bob.sessionToken)).requests.length, 0);
  assert.equal((await call(bob.user, "GET", ["requests", req.requestId], null, bob.sessionToken)).status, 404);
  const one = await call(alice.user, "GET", ["requests", req.requestId]); const form = one.request.items[0]; const bad = await call(alice.user, "POST", ["requests", req.requestId, "items", form.itemId, "form"], { values: {} }); assert.equal(bad.status, 400);
  assert.equal((await call(alice.user, "POST", ["requests", req.requestId, "items", form.itemId, "form"], { values: { note: "hello" } })).ok, true);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(300)]); const upUrl = `http://localhost:3000/api/portal/${org.slug}/request-files?requestId=${req.requestId}&itemId=${one.request.items[1].itemId}&filename=id.png`;
  const mk = (token, headers = {}) => new Request(upUrl, { method: "POST", headers: { cookie: `inaya_portal_session=${token}`, host: "localhost:3000", ...headers }, body: png }); const ctx = { params: Promise.resolve({ slug: org.slug }) };
  assert.equal((await uploadRoute.POST(mk(alice.sessionToken), ctx)).status, 403, "no CSRF header"); assert.equal((await uploadRoute.POST(mk("not-a-session", { "x-portal-request": "1" }), ctx)).status, 401, "not signed in");
  assert.equal((await uploadRoute.POST(mk(bob.sessionToken, { "x-portal-request": "1" }), ctx)).status, 404, "bob cannot upload to alice's request"); assert.equal((await uploadRoute.POST(mk(alice.sessionToken, { "x-portal-request": "1", origin: "https://evil.example" }), ctx)).status, 403, "cross-site origin");
  const done = await uploadRoute.POST(mk(alice.sessionToken, { "x-portal-request": "1", origin: "http://localhost:3000" }), ctx); assert.equal(done.status, 200); const fileId = (await done.json()).file.fileId;
  const d1 = await downloadRoute.GET(new Request(`http://localhost:3000/x?requestId=${req.requestId}`, { headers: { cookie: `inaya_portal_session=${alice.sessionToken}` } }), { params: Promise.resolve({ slug: org.slug, fileId }) }); assert.equal(d1.status, 200); assert.deepEqual(Buffer.from(await d1.arrayBuffer()), png); assert.match(d1.headers.get("content-disposition"), /attachment/); assert.equal(d1.headers.get("x-content-type-options"), "nosniff");
  const d2 = await downloadRoute.GET(new Request(`http://localhost:3000/x?requestId=${req.requestId}`, { headers: { cookie: `inaya_portal_session=${bob.sessionToken}` } }), { params: Promise.resolve({ slug: org.slug, fileId }) }); assert.equal(d2.status, 404);
  assert.equal((await call(alice.user, "GET", ["requests", req.requestId])).request.status, "COMPLETE");
  const cookie = (await createSession(org.agent.email)).sessionToken; const sctx = (path) => ({ params: Promise.resolve({ path }) }); const sreq = (path, method = "GET", extra = {}) => new NextRequest(`http://localhost:3000/api/orgs/portal-requests/${path.join("/")}?orgId=${org.oid}`, { method, headers: { cookie: `inaya_org_session=${cookie}` }, ...extra });
  const sl = await staffRoute.GET(sreq([]), sctx([])); assert.equal(sl.status, 200); assert.ok((await sl.json()).requests.length >= 3);
  const sd = await staffRoute.GET(sreq([req.requestId, "files", fileId]), sctx([req.requestId, "files", fileId])); assert.equal(sd.status, 200); assert.deepEqual(Buffer.from(await sd.arrayBuffer()), png);
  const plainCookie = (await createSession(org.plain.email)).sessionToken; assert.equal((await staffRoute.GET(new NextRequest(`http://localhost:3000/api/orgs/portal-requests?orgId=${org.oid}`, { headers: { cookie: `inaya_org_session=${plainCookie}` } }), sctx([]))).status, 403);
});
