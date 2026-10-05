// test/sharing-routes.test.mjs -- Secure Sharing 2.0 over HTTP: the real route handlers with real cookies against the real database:
// feature flag, authentication, creation and management, and the public recipient flow (password in the body, access session, ciphertext).
// Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=300000 test/sharing-routes.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server.js";
import { ObjectId } from "mongodb";
import { setup, teardown, makeChatOrg, cookieFor, c as cols } from "./_chat-fixtures.mjs";
import { SESSION_COOKIE, getOrgCollections } from "../src/lib/orgs.js";
import { setOrgFeature } from "../src/lib/featureFlags.js";
import * as S from "../src/lib/sharing/shares.js";

const T = { timeout: 300000 };
const mod = {}; const load = async (p) => (mod[p] ||= await import(p));
const CID_A = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const CID_B = "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
let org, other, doc, cAlice, cBob, cCarol, db;

async function call(file, method, { path = "/", cookie, body, query = {}, params = {}, headers = {}, ip = "203.0.113.7" } = {}) {
  const m = await load(file);
  const url = new URL("http://localhost" + path); for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const h = { host: "localhost", "x-forwarded-for": ip, ...(cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers };
  const res = await m[method](new NextRequest(url, { method, headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), { params: Promise.resolve(params) });
  let data = null; try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data, headers: res.headers };
}
const R = {
  create: (cookie, body, orgId = org.oid) => call("../src/app/api/orgs/shares/route.js", "POST", { cookie, body: { orgId, ...body } }),
  list: (cookie, query, orgId = org.oid) => call("../src/app/api/orgs/shares/route.js", "GET", { cookie, query: { orgId, ...query } }),
  patch: (cookie, shareId, body, orgId = org.oid) => call("../src/app/api/orgs/shares/[shareId]/route.js", "PATCH", { cookie, body: { orgId, ...body }, params: { shareId } }),
  revoke: (cookie, shareId, orgId = org.oid) => call("../src/app/api/orgs/shares/[shareId]/route.js", "DELETE", { cookie, query: { orgId }, params: { shareId } }),
  events: (cookie, shareId) => call("../src/app/api/orgs/shares/[shareId]/events/route.js", "GET", { cookie, query: { orgId: org.oid }, params: { shareId } }),
  member: (cookie, body) => call("../src/app/api/orgs/shares/member/route.js", "POST", { cookie, body: { orgId: org.oid, ...body } }),
  peek: (token) => call("../src/app/api/orgs/share/[token]/route.js", "GET", { params: { token } }),
  access: (token, body, ip) => call("../src/app/api/orgs/share/[token]/access/route.js", "POST", { body, params: { token }, ip }),
  content: (token, session, part, ip) => call("../src/app/api/orgs/share/[token]/content/route.js", "GET", { query: { part }, headers: session ? { "x-share-session": session } : {}, params: { token }, ip }),
};
const tokenOf = (url) => url.split("/").pop();

before(async () => {
  await setup(); db = (await getOrgCollections()).db;
  org = await makeChatOrg("shr"); other = await makeChatOrg("shr-other", { people: ["eve"] });
  [cAlice, cBob, cCarol] = await Promise.all([cookieFor(org.alice.email), cookieFor(org.bob.email), cookieFor(org.carol.email)]);
  const ins = await cols.orgDocuments.insertOne({ orgId: org.orgId, departmentId: new ObjectId(), projectId: new ObjectId(), filename: "contract.pdf", fileHash: `0xr-${randomBytes(4).toString("hex")}`, sizeBytes: 999, cidAlpha: CID_A, cidBeta: CID_B, uploadedByEmail: org.alice.email, txHash: "0xfake", status: "DRAFT", accessLevel: "PRIVATE", createdAt: new Date().toISOString(), deletedAt: null });
  doc = await cols.orgDocuments.findOne({ _id: ins.insertedId });
  S.setShardFetcher(async (cid) => JSON.stringify({ shard: cid === CID_A ? "ALPHA-CIPHER" : "BETA-CIPHER" }));
});
after(async () => {
  for (const n of ["orgDocuments", "documentShares", "documentPermissions", "documentActivity"]) await cols[n].deleteMany({ $or: [{ orgId: { $in: [org.orgId, other.orgId] } }, { organizationId: { $in: [org.orgId, other.orgId] } }] }).catch(() => {});
  for (const n of ["file_share_access_events", "drm_sessions", "share_email_codes"]) await db.collection(n).deleteMany({}).catch(() => {});
  await teardown();
});

test("creation is off until the feature is on; then needs MANAGE on the document; and validates", T, async () => {
  const body = { documentId: String(doc._id), expirationPreset: "7d", permission: "download" };
  assert.equal((await R.create(cAlice, body)).status, 404, "off by default");
  await setOrgFeature({ orgId: org.oid, name: "FEATURE_ADVANCED_SHARING", enabled: true });
  assert.equal((await R.create(null, body)).status, 401);
  assert.equal((await R.create(cBob, body)).status, 403, "Bob has no MANAGE access to Alice's private document");
  assert.equal((await R.create(cAlice, { ...body, expirationPreset: "10 years" })).status, 400);
  assert.equal((await R.create(cAlice, { ...body, password: "short" })).status, 400);
  assert.equal((await R.create(cAlice, { ...body, ipAllow: ["bad"] })).status, 400);
  assert.equal((await R.create(cAlice, {})).status, 400);
  assert.equal((await R.create(cAlice, body, other.oid)).status, 403, "Alice is not a member of the other organization");
  const ok = await R.create(cAlice, { ...body, password: "swordfish-123", label: "Contract" });
  assert.equal(ok.status, 200); assert.match(ok.data.shareUrl, /\/business\/share\/[A-Za-z0-9_-]{40,}$/); assert.equal(ok.data.passwordProtected, true);
  assert.equal(JSON.stringify(ok.data).includes("tokenHash"), false);
});

let link, token;
test("the recipient flow over HTTP: peek, password in the body, access session, ciphertext", T, async () => {
  const made = await R.create(cAlice, { documentId: String(doc._id), expirationPreset: "7d", permission: "download", password: "swordfish-123", maxDownloads: 1, watermark: true, label: "Contract" });
  link = made.data; token = tokenOf(link.shareUrl);
  const peek = await R.peek(token);
  assert.equal(peek.status, 200); assert.deepEqual(peek.data.requires, { password: true, email: false }); assert.equal(JSON.stringify(peek.data).includes("contract.pdf"), false);
  assert.equal((await R.access(token, {})).status, 401);
  const wrong = await R.access(token, { password: "nope-nope-nope" }); assert.equal(wrong.status, 401);
  const ok = await R.access(token, { password: "swordfish-123", deviceId: "device-0001" });
  assert.equal(ok.status, 200); assert.equal(ok.data.filename, "contract.pdf"); assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.equal(JSON.stringify(ok.data).includes(CID_A), false); assert.match(ok.data.watermark, /^Contract \| guest \| /);
  const a = await R.content(token, ok.data.sessionToken, "alpha"); assert.equal(a.status, 200); assert.equal(JSON.parse(a.data.content).shard, "ALPHA-CIPHER");
  assert.equal((await R.content(token, ok.data.sessionToken, "beta")).status, 200);
  assert.equal((await R.content(token, null, "alpha")).status, 401); assert.equal((await R.content(token, "bogus", "alpha")).status, 401);
  assert.equal((await R.content(token, ok.data.sessionToken, "zeta")).status, 400);
  // the download limit (1) is now spent: the link is exhausted, so a second visitor is turned away at the door, with the right password
  const second = await R.access(token, { password: "swordfish-123", deviceId: "device-0002" }); assert.equal(second.status, 410);
  assert.equal((await R.peek(token)).data.status, "exhausted");
  // ...while the session that already holds the reservation keeps working until it expires
  assert.equal((await R.content(token, ok.data.sessionToken, "alpha")).status, 200);
});

test("the old endpoint answers the same preview for a v2 link and never a storage pointer", T, async () => {
  const peek = await R.peek(token); assert.equal(peek.status, 200); assert.equal(peek.data.v2, true);
  assert.equal(JSON.stringify(peek.data).includes(CID_A), false);
  const { resolveShareAccess } = await import("../src/lib/document-permissions.js");
  assert.equal((await resolveShareAccess(token)).status, 409);
});

test("the public routes do not leak: unknown tokens, malformed bodies, wrong methods", T, async () => {
  assert.equal((await R.access("A".repeat(43), { password: "x" })).status, 404);
  const m = await load("../src/app/api/orgs/share/[token]/access/route.js");
  const fresh = tokenOf((await R.create(cAlice, { documentId: String(doc._id), expirationPreset: "7d", permission: "view", password: "swordfish-123" })).data.shareUrl);
  const bad = await m.POST(new NextRequest("http://localhost/x", { method: "POST", body: "{not json", headers: { "x-forwarded-for": "203.0.113.8" } }), { params: Promise.resolve({ token: fresh }) });
  assert.ok([400, 401].includes(bad.status));
  assert.equal(typeof m.GET, "undefined", "access is POST-only so a password can never sit in a URL");
  const body = JSON.stringify(await bad.json()); assert.equal(body.includes("at "), false);
});

test("manager list, update, events, revoke over HTTP, with delegation and isolation", T, async () => {
  const made = await R.create(cAlice, { documentId: String(doc._id), expirationPreset: "7d", permission: "view", managerEmails: [org.bob.email], notifyOnAccess: true });
  const id = made.data.shareId; const t = tokenOf(made.data.shareUrl);
  assert.ok((await R.access(t, { deviceId: "device-0003" })).data.sessionToken);
  const mine = await R.list(cAlice, { scope: "byMe", limit: "100" }); assert.equal(mine.status, 200); assert.ok(mine.data.items.some((i) => i.shareId === id && i.filename === "contract.pdf"));
  const bobList = await R.list(cBob, { scope: "byMe" }); assert.ok(bobList.data.items.some((i) => i.shareId === id), "a delegated manager sees it");
  assert.equal((await R.list(cBob, { scope: "org" })).status, 403);
  assert.equal((await R.list(cCarol, { scope: "byMe" })).data.items.some((i) => i.shareId === id), false, "a stranger does not");
  assert.equal((await R.list(cAlice, { scope: "document", documentId: String(doc._id), status: "active" })).status, 200);
  assert.equal((await R.list(cBob, { scope: "document", documentId: String(doc._id) })).status, 403, "document scope needs MANAGE on the document");
  assert.equal((await R.list(cAlice, { scope: "bogus" })).status, 400);
  const upd = await R.patch(cBob, id, { label: "Updated by delegate", expiresAt: new Date(Date.now() + 2 * 86400_000).toISOString() }); assert.equal(upd.status, 200); assert.equal(upd.data.label, "Updated by delegate");
  assert.equal((await R.patch(cBob, id, { managerEmails: [org.carol.email] })).status, 403);
  assert.equal((await R.patch(cCarol, id, { label: "hijack" })).status, 403);
  const ev = await R.events(cAlice, id); assert.equal(ev.status, 200); assert.ok(ev.data.events.some((e) => e.type === "OPENED"));
  assert.equal((await R.events(cCarol, id)).status, 403);
  assert.equal((await R.revoke(cCarol, id)).status, 403);
  assert.equal((await R.revoke(null, id)).status, 401);
  assert.equal((await R.revoke(cBob, id)).status, 200);
  assert.equal((await R.access(t, { deviceId: "device-0004" })).status, 410);
  assert.equal((await R.peek(t)).data.status, "revoked");
  const eve = await cookieFor(other.eve.email); await setOrgFeature({ orgId: other.oid, name: "FEATURE_ADVANCED_SHARING", enabled: true });
  assert.equal((await R.revoke(eve, id, other.oid)).status, 404, "another organization cannot touch it");
});

test("member share over HTTP: only for organization members, optionally expiring; needs MANAGE", T, async () => {
  const ok = await R.member(cAlice, { documentId: String(doc._id), email: org.carol.email, permission: "view", expiresAt: new Date(Date.now() + 86400_000).toISOString() });
  assert.equal(ok.status, 200); assert.equal(ok.data.level, "VIEW");
  assert.equal((await R.member(cAlice, { documentId: String(doc._id), email: "nobody@example.net", permission: "view" })).status, 404);
  assert.equal((await R.member(cAlice, { documentId: String(doc._id), email: org.carol.email, permission: "view", expiresAt: new Date(Date.now() - 1000).toISOString() })).status, 400);
  assert.equal((await R.member(cCarol, { documentId: String(doc._id), email: org.bob.email, permission: "view" })).status, 403, "view access is not enough to share");
  const withMe = await R.list(cCarol, { scope: "withMe" }); assert.ok(withMe.data.items.some((i) => i.documentId === String(doc._id)));
});

test("nothing sensitive is stored or returned: no token, no password, no pointer in lists or logs", T, async () => {
  const all = JSON.stringify((await R.list(cAlice, { scope: "byMe", limit: "100" })).data);
  for (const bad of ["tokenHash", "passwordHash", CID_A, CID_B, "swordfish"]) assert.equal(all.includes(bad), false, `${bad} must not appear in a list`);
  const events = JSON.stringify(await db.collection("file_share_access_events").find({ orgId: org.oid }).toArray());
  assert.equal(events.includes("203.0.113.7"), false, "full IPs are never stored in the access log");
});
