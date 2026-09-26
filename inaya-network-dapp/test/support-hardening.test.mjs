// test/support-hardening.test.mjs -- the gap-closing features, against the real database and route handlers:
//   * large attachments (chunked upload up to 25 MB) incl. malware refusal, ownership and integrity checks;
//   * customer single sign-on (OIDC + PKCE) against a local identity provider that signs real RS256 tokens;
//   * inbound email through Resend (Svix signatures, routing by portal address, sender authentication, attachments);
//   * administrator status / outbound-email test.
// Only external services are replaced: the identity provider and the Resend API are local stand-ins.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac, createHash, generateKeyPairSync, sign as cryptoSign, randomBytes } from "node:crypto";
import { NextRequest } from "next/server.js";
import { setup, makeSupportOrg, portalSession, cleanup, cookieFor, sc, c } from "./_support-fixtures.mjs";
import { SESSION_COOKIE } from "../src/lib/orgs.js";
import { __setAiProvider } from "../src/lib/workflows/ai.js";
import { submitTicket } from "../src/lib/support/flows.js";
import { loadTicket } from "../src/lib/support/tickets.js";
import { updateSettings, setSsoClientSecret, getSettings, getInboundSecret } from "../src/lib/support/settings.js";
import { startSso, finishSso, verifyIdToken, __resetSsoCaches } from "../src/lib/support/sso.js";
import { getPortalUser } from "../src/lib/support/portalAuth.js";
import { verifySvix, handleReceived, authFromHeaders, normHeaders } from "../src/lib/support/inboundResend.js";
import { replyToAddress, supportAddressOf } from "../src/lib/support/notify.js";
import { EICAR_TEST_STRING } from "../src/lib/support/scanner.js";
import { flushEvidence } from "../src/lib/support/record.js";

let A; let B; let alice; let bob; let idp; const idpState = { codes: new Map(), keys: {}, base: "" };
const J = JSON.stringify;
const mod = {}; const load = async (k, p) => (mod[k] ||= await import(p));
const b64u = (b) => Buffer.from(b).toString("base64url");

function req(method, path, { body, cookie, headers = {}, query = {}, raw } = {}) {
  const url = new URL(`http://localhost${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new NextRequest(url, { method, headers: { "x-forwarded-for": "203.0.113.9", host: "localhost", ...(cookie ? { cookie } : {}), ...headers }, ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: J(body) } : {}) });
}
const call = async (handler, r, params = {}) => { const res = await handler(r, { params: Promise.resolve(params) }); const ct = res.headers.get("content-type") || ""; return { status: res.status, headers: res.headers, body: ct.includes("json") ? await res.json().catch(() => ({})) : Buffer.from(await res.arrayBuffer()) }; };

// ------------------------------------------------------------------------ a real (local) OIDC identity provider
function makeIdp() {
  const kp = generateKeyPairSync("rsa", { modulusLength: 2048 }); const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...kp.publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" };
  idpState.keys = { good: kp.privateKey, other: other.privateKey };
  const server = http.createServer((req2, res) => {
    const u = new URL(req2.url, idpState.base); let raw = "";
    req2.on("data", (d) => (raw += d));
    req2.on("end", () => {
      const send = (o, s = 200) => { res.statusCode = s; res.setHeader("content-type", "application/json"); res.end(J(o)); };
      if (u.pathname === "/.well-known/openid-configuration") return send({ issuer: idpState.base, authorization_endpoint: `${idpState.base}/authorize`, token_endpoint: `${idpState.base}/token`, jwks_uri: `${idpState.base}/jwks` });
      if (u.pathname === "/jwks") return send({ keys: [jwk] });
      if (u.pathname === "/token") {
        const f = new URLSearchParams(raw); const entry = idpState.codes.get(f.get("code"));
        idpState.codes.delete(f.get("code"));
        if (!entry || f.get("client_secret") !== "s3cret-value" || f.get("client_id") !== "client-1") return send({ error: "invalid_client" }, 401);
        if (b64u(createHash("sha256").update(f.get("code_verifier") || "").digest()) !== entry.challenge) return send({ error: "invalid_grant" }, 400); // PKCE really enforced
        return send({ id_token: entry.token, token_type: "Bearer" });
      }
      send({ error: "not found" }, 404);
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => { idpState.base = `http://127.0.0.1:${server.address().port}`; r(server); }));
}
function mintToken(claims, { alg = "RS256", key = "good", kid = "k1" } = {}) {
  const header = b64u(J({ alg, typ: "JWT", kid })); const payload = b64u(J(claims)); const data = `${header}.${payload}`;
  if (alg === "none") return `${data}.`;
  if (alg === "HS256") return `${data}.${b64u(createHmac("sha256", "s3cret-value").update(data).digest())}`;
  return `${data}.${b64u(cryptoSign("RSA-SHA256", Buffer.from(data), idpState.keys[key]))}`;
}
/** Plays the browser + identity provider: takes the authorize URL, "logs the user in", returns { code, state }. */
function login(authUrl, { email = "x@y.z", overrides = {}, tokenOpts = {}, nonceOverride = null } = {}) {
  const u = new URL(authUrl); const p = u.searchParams;
  assert.equal(p.get("code_challenge_method"), "S256"); assert.equal(p.get("response_type"), "code"); assert.equal(p.get("client_id"), "client-1"); assert.match(p.get("redirect_uri"), /\/api\/portal\/.+\/sso\/callback$/);
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: idpState.base, aud: "client-1", sub: "user-1", email, email_verified: true, iat: now, exp: now + 300, nonce: nonceOverride || p.get("nonce"), ...overrides };
  const code = randomBytes(8).toString("hex");
  idpState.codes.set(code, { token: mintToken(claims, tokenOpts), challenge: p.get("code_challenge") });
  return { code, state: p.get("state") };
}
const callback = async (slug, code, state) => { const m = await load("cb", "../src/app/api/portal/[slug]/sso/callback/route.js"); const res = await m.GET(req("GET", `/api/portal/${slug}/sso/callback`, { query: { code, state } }), { params: Promise.resolve({ slug }) }); return { status: res.status, location: res.headers.get("location") || "", cookie: (res.headers.get("set-cookie") || "").split(";")[0] }; };

before(async () => {
  process.env.WORKFLOW_HTTP_TEST_ALLOW_LOCAL = "1"; process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.SUPPORT_INBOUND_DOMAIN = "in.support.test"; process.env.RESEND_WEBHOOK_SECRET = `whsec_${Buffer.from("resend-test-signing-secret").toString("base64")}`;
  await setup();
  A = await makeSupportOrg("ha"); B = await makeSupportOrg("hb");
  alice = await portalSession(A, A.alice.email); bob = await portalSession(A, A.bob.email);
  idp = await makeIdp();
  __setAiProvider(async () => { throw new Error("off"); });
});
after(async () => { __setAiProvider(null); idp?.close(); for (const k of ["WORKFLOW_HTTP_TEST_ALLOW_LOCAL", "SUPPORT_INBOUND_DOMAIN", "RESEND_WEBHOOK_SECRET"]) delete process.env[k]; await flushEvidence(); await cleanup(); });

const mk = (org, u, over = {}) => submitTicket({ orgId: org.oid, settings: org.settings, actor: { type: "customer", email: u.email, portalUserId: u._id }, requester: { email: u.email, name: u.name, portalUserId: u._id }, subject: "Large file test", description: "I need to send a big file.", channel: "PORTAL", triage: false, ...over });
const cookieOf = (s) => `inaya_portal_session=${s.sessionToken}`;

// =========================================================================================== uploads
const portalUp = async (org, cookie, path, method, opts = {}) => {
  if (path === "") { const m = await load("pinit", "../src/app/api/portal/[slug]/uploads/route.js"); return call(m.POST, req("POST", `/api/portal/${org.slug}/uploads`, { cookie, body: opts.body, headers: { "x-portal-request": "1" } }), { slug: org.slug }); }
  const m = await load("pchunk", "../src/app/api/portal/[slug]/uploads/[id]/route.js");
  return call(m[method], req(method, `/api/portal/${org.slug}/uploads/${path}`, { cookie, raw: opts.raw, query: opts.query || {}, headers: { "x-portal-request": "1" } }), { slug: org.slug, id: path });
};
const CH = 3 * 1024 * 1024;
const upload = async (org, cookie, { ticketId, filename, data, sha = true, ideaId }) => {
  const init = await portalUp(org, cookie, "", "POST", { body: { ...(ideaId ? { ideaId } : { ticketId }), filename, size: data.length, ...(sha ? { sha256: createHash("sha256").update(data).digest("hex") } : {}) } });
  if (init.status !== 200) return { init };
  for (let i = 0; i < init.body.chunks; i++) { const r = await portalUp(org, cookie, init.body.uploadId, "PUT", { raw: data.subarray(i * CH, Math.min(data.length, (i + 1) * CH)), query: { index: String(i) } }); assert.equal(r.status, 200, J(r.body)); }
  return { init, done: await portalUp(org, cookie, init.body.uploadId, "POST") };
};

test("a 7 MB file goes up in chunks, is scanned, stored encrypted, and comes back byte for byte", async () => {
  const t = await mk(A, alice.user);
  const data = Buffer.from("Quarterly figures line.\n".repeat(Math.ceil((7 * 1024 * 1024) / 24))).subarray(0, 7 * 1024 * 1024);
  const r = await upload(A, cookieOf(alice), { ticketId: String(t.ticket._id), filename: "report.txt", data });
  assert.equal(r.init.body.chunks, 3); assert.equal(r.init.body.chunkBytes, CH);
  assert.equal(r.done.status, 200, J(r.done.body));
  const att = await sc.supportAttachments.findOne({ _id: new (await import("mongodb")).ObjectId(r.done.body.attachment.id) });
  assert.equal(att.sizeBytes, data.length); assert.equal(att.scan.status, "CLEAN"); assert.ok(att.scan.engines.includes("static"));
  const dl = await load("dl", "../src/app/api/portal/[slug]/attachments/[id]/route.js");
  const got = await call(dl.GET, req("GET", `/api/portal/${A.slug}/attachments/${r.done.body.attachment.id}`, { cookie: cookieOf(alice) }), { slug: A.slug, id: r.done.body.attachment.id });
  assert.equal(got.status, 200); assert.ok(Buffer.compare(got.body, data) === 0, "bytes round-trip through encrypted storage");
  assert.equal(await sc.supportUploadChunks.countDocuments({ uploadId: att._id }), 0);
  assert.equal(await sc.supportUploads.countDocuments({ orgId: A.orgId }), 0, "the upload record and chunks are removed");
  // a colleague cannot read it
  const bobDl = await call(dl.GET, req("GET", `/api/portal/${A.slug}/attachments/${r.done.body.attachment.id}`, { cookie: cookieOf(bob) }), { slug: A.slug, id: r.done.body.attachment.id });
  assert.equal(bobDl.status, 404);
});

test("uploads are refused early and safely: name, size, ownership, chunk shape, completeness, checksum, malware", async () => {
  const t = await mk(A, alice.user, { subject: "Upload refusals" }); const tid = String(t.ticket._id); const ck = cookieOf(alice);
  assert.equal((await portalUp(A, ck, "", "POST", { body: { ticketId: tid, filename: "run.exe", size: 100 } })).status, 400, "blocked type refused before any bytes move");
  assert.equal((await portalUp(A, ck, "", "POST", { body: { ticketId: tid, filename: "big.txt", size: 26 * 1024 * 1024 } })).status, 400, "over the 25 MB limit");
  assert.equal((await portalUp(A, ck, "", "POST", { body: { ticketId: tid, filename: "a.txt", size: 0 } })).status, 400);
  assert.equal((await portalUp(A, cookieOf(bob), "", "POST", { body: { ticketId: tid, filename: "a.txt", size: 10 } })).status, 404, "a colleague cannot attach to someone else's request");
  assert.equal((await portalUp(A, "", "", "POST", { body: { ticketId: tid, filename: "a.txt", size: 10 } })).status, 401);

  const init = await portalUp(A, ck, "", "POST", { body: { ticketId: tid, filename: "two.txt", size: CH + 10 } });
  const id = init.body.uploadId; assert.equal(init.body.chunks, 2);
  assert.equal((await portalUp(A, cookieOf(bob), id, "PUT", { raw: Buffer.alloc(CH), query: { index: "0" } })).status, 404, "another user cannot use the token");
  assert.equal((await portalUp(A, ck, id, "PUT", { raw: Buffer.alloc(100), query: { index: "0" } })).status, 400, "wrong chunk size");
  assert.equal((await portalUp(A, ck, id, "PUT", { raw: Buffer.alloc(10), query: { index: "5" } })).status, 400, "index out of range");
  assert.equal((await portalUp(A, ck, id, "PUT", { raw: Buffer.alloc(CH, 65), query: { index: "0" } })).status, 200);
  const early = await portalUp(A, ck, id, "POST");
  assert.equal(early.status, 409); assert.deepEqual(early.body.received, [0], "the response says which chunks are still missing");
  assert.equal((await portalUp(A, ck, id, "PUT", { raw: Buffer.alloc(10, 66), query: { index: "1" } })).status, 200);
  assert.equal((await portalUp(A, ck, id, "PUT", { raw: Buffer.alloc(10, 66), query: { index: "1" } })).status, 200, "re-sending a chunk is harmless");
  const ok = await portalUp(A, ck, id, "POST"); assert.equal(ok.status, 200, J(ok.body));
  assert.equal((await portalUp(A, ck, id, "POST")).status, 404, "an upload can be completed once");

  const bad = Buffer.from("plain text ".repeat(50));
  const wrongSum = await portalUp(A, ck, "", "POST", { body: { ticketId: tid, filename: "sum.txt", size: bad.length, sha256: "0".repeat(64) } });
  await portalUp(A, ck, wrongSum.body.uploadId, "PUT", { raw: bad, query: { index: "0" } });
  const sumRes = await portalUp(A, ck, wrongSum.body.uploadId, "POST");
  assert.equal(sumRes.status, 400); assert.equal(sumRes.body.reasonCode, "CHECKSUM_MISMATCH");

  const virus = await upload(A, ck, { ticketId: tid, filename: "eicar.txt", data: Buffer.from(EICAR_TEST_STRING) });
  assert.equal(virus.done.status, 400, J(virus.done.body)); assert.equal(virus.done.body.reasonCode, "MALWARE_DETECTED");
  assert.equal(await sc.supportAttachments.countDocuments({ ticketId: t.ticket._id, filename: "eicar.txt" }), 0, "nothing was stored");
  assert.ok(await c.orgActivity.findOne({ orgId: A.orgId, action: "TICKET_ATTACHMENT_BLOCKED" }), "the block is in the audit log");
  const macro = await upload(A, ck, { ticketId: tid, filename: "sheet.pdf", data: Buffer.from("%PDF-1.7\n1 0 obj<</S/JavaScript/JS(x)>>endobj\n%%EOF") });
  assert.equal(macro.done.body.reasonCode, "MALWARE_DETECTED");
});

test("strict scan mode refuses files when no engine is available; agents and API keys can upload large files too", async () => {
  const t = await mk(A, alice.user, { subject: "Other surfaces" }); const tid = String(t.ticket._id);
  await updateSettings({ orgId: A.oid, patch: { scan: { mode: "engine_required" } }, actorEmail: A.owner.email });
  const strict = await upload(A, cookieOf(alice), { ticketId: tid, filename: "ok.txt", data: Buffer.from("fine") });
  assert.equal(strict.done.status, 503); assert.equal(strict.done.body.reasonCode, "SCAN_UNAVAILABLE");
  await updateSettings({ orgId: A.oid, patch: { scan: { mode: "static" } }, actorEmail: A.owner.email });

  // an agent (console) attaches a private file to a note
  const ag = await load("agentInit", "../src/app/api/orgs/support/uploads/route.js"); const agc = await load("agentChunk", "../src/app/api/orgs/support/uploads/[id]/route.js");
  const cookie = `${SESSION_COOKIE}=${await cookieFor(A.agent.email)}`; const data = Buffer.from("internal evidence ".repeat(1000));
  const i = await call(ag.POST, req("POST", "/api/orgs/support/uploads", { cookie, query: { orgId: A.oid }, body: { ticketId: tid, filename: "evidence.txt", size: data.length, internal: true } }));
  assert.equal(i.status, 200, J(i.body));
  await call(agc.PUT, req("PUT", `/api/orgs/support/uploads/${i.body.uploadId}`, { cookie, query: { orgId: A.oid, index: "0" }, raw: data }), { id: i.body.uploadId });
  const d = await call(agc.POST, req("POST", `/api/orgs/support/uploads/${i.body.uploadId}`, { cookie, query: { orgId: A.oid } }), { id: i.body.uploadId });
  assert.equal(d.status, 200, J(d.body));
  assert.equal((await sc.supportAttachments.findOne({ ticketId: t.ticket._id, filename: "evidence.txt" })).visibility, "INTERNAL");
  const custView = J((await (await import("../src/lib/support/tickets.js")).getTicketForCustomer({ orgId: A.oid, user: alice.user, ticketId: tid, settings: A.settings })).attachments);
  assert.ok(!custView.includes("evidence.txt"), "an internal attachment is invisible to the customer");
  const plainInit = await call(ag.POST, req("POST", "/api/orgs/support/uploads", { cookie: `${SESSION_COOKIE}=${await cookieFor(A.plain.email)}`, query: { orgId: A.oid }, body: { ticketId: tid, filename: "x.txt", size: 10 } }));
  assert.equal(plainInit.status, 403, "no support access, no uploads");

  // a support API key bound to alice
  const { createSupportApiKey } = await import("../src/lib/support/apiKeys.js");
  const key = await createSupportApiKey({ orgId: A.oid, label: "up", scopes: ["attachments:write", "tickets:read"], customerEmail: A.alice.email, actorEmail: A.owner.email });
  const pi = await load("pubInit", "../src/app/api/public/v1/support/uploads/route.js"); const pc = await load("pubChunk", "../src/app/api/public/v1/support/uploads/[id]/route.js");
  const auth = { authorization: `Bearer ${key.rawKey}` }; const pdata = Buffer.from("api upload ".repeat(500));
  const pinit = await call(pi.POST, req("POST", "/api/public/v1/support/uploads", { headers: auth, body: { ticketId: tid, filename: "api.txt", size: pdata.length } }));
  assert.equal(pinit.status, 200, J(pinit.body));
  await call(pc.PUT, req("PUT", `/api/public/v1/support/uploads/${pinit.body.uploadId}`, { headers: auth, query: { index: "0" }, raw: pdata }), { id: pinit.body.uploadId });
  assert.equal((await call(pc.POST, req("POST", `/api/public/v1/support/uploads/${pinit.body.uploadId}`, { headers: auth }), { id: pinit.body.uploadId })).status, 200);
  const other = await createSupportApiKey({ orgId: A.oid, label: "bob", scopes: ["attachments:write"], customerEmail: A.bob.email, actorEmail: A.owner.email });
  assert.equal((await call(pi.POST, req("POST", "/api/public/v1/support/uploads", { headers: { authorization: `Bearer ${other.rawKey}` }, body: { ticketId: tid, filename: "x.txt", size: 10 } }))).status, 404, "bob's key cannot attach to alice's ticket");
  assert.equal((await call(pi.POST, req("POST", "/api/public/v1/support/uploads", { body: { ticketId: tid, filename: "x.txt", size: 10 } }))).status, 401);
});

// ================================================================================================== SSO
test("SSO: a real OIDC login (PKCE, signed RS256 token) opens a session for a CRM contact only", async () => {
  __resetSsoCaches();
  const s = await updateSettings({ orgId: A.oid, patch: { sso: { enabled: true, issuer: idpState.base, clientId: "client-1", label: "Acme SSO" } }, actorEmail: A.owner.email });
  assert.ok(!s.error, s.error);
  assert.equal((await startSso({ orgId: A.oid, settings: (await getSettings(A.oid)), slug: A.slug })).status, 503, "no client secret yet: not offered");
  assert.ok(!(await setSsoClientSecret({ orgId: A.oid, secret: "s3cret-value", actorEmail: A.owner.email })).error);
  const st = await getSettings(A.oid); st.portalSlug = A.slug;
  const pub = (await load("agent", "../src/lib/support/settings.js")).publicSettings(st);
  assert.equal(pub.sso.clientSecretSet, true); assert.ok(!J(pub).includes("s3cret-value"), "the client secret is never returned");
  const cfg = await (await load("pa", "../src/lib/support/portalApi.js")).handlePortal({ method: "GET", path: ["config"], query: {}, body: {}, req: req("GET", `/api/portal/${A.slug}/config`), org: { orgId: A.orgId, settings: st, portalSlug: A.slug }, ip: "1" });
  assert.deepEqual(cfg.sso, { enabled: true, label: "Acme SSO" });

  const start = await startSso({ orgId: A.oid, settings: st, slug: A.slug }); assert.ok(!start.error, start.error);
  const { code, state } = login(start.url, { email: A.alice.email });
  const done = await callback(A.slug, code, state);
  assert.equal(done.status, 302); assert.match(done.location, new RegExp(`/portal/${A.slug}$`)); assert.match(done.cookie, /^inaya_portal_session=/);
  const me = await getPortalUser({ req: { headers: new Headers({ cookie: done.cookie }) }, orgId: A.oid });
  assert.equal(me.email, A.alice.email); assert.equal(String(me.contactId), String(A.alice.id), "linked to her CRM contact");
  assert.ok(await c.orgActivity.findOne({ orgId: A.orgId, action: "PORTAL_SIGNED_IN", "metadata.via": "sso" }));

  // the same code and state cannot be replayed
  const replay = await callback(A.slug, code, state); assert.match(replay.location, /sso_error=failed/); assert.equal(replay.cookie, "");
  // a stranger who is not a CRM contact is not let in (SSO proves identity, not entitlement)
  const s2 = login((await startSso({ orgId: A.oid, settings: st, slug: A.slug })).url, { email: "stranger@elsewhere.example" });
  const r2 = await callback(A.slug, s2.code, s2.state); assert.match(r2.location, /sso_error=/); assert.equal(r2.cookie, "");
  assert.equal(await sc.supportPortalUsers.countDocuments({ orgId: A.orgId, email: "stranger@elsewhere.example" }), 0);
});

test("SSO rejects tampered, mismatched and unsafe tokens", async () => {
  const st = await getSettings(A.oid); st.portalSlug = A.slug;
  const attempt = async (opts) => { const { url } = await startSso({ orgId: A.oid, settings: st, slug: A.slug }); const l = login(url, { email: A.alice.email, ...opts }); return callback(A.slug, l.code, l.state); };
  const rejected = (r) => { assert.equal(r.status, 302); assert.match(r.location, /sso_error=/); assert.equal(r.cookie, ""); };
  rejected(await attempt({ tokenOpts: { key: "other" } }));                       // signed with a key the provider never published
  rejected(await attempt({ tokenOpts: { alg: "none" } }));                        // unsigned
  rejected(await attempt({ tokenOpts: { alg: "HS256" } }));                       // algorithm confusion with the client secret
  rejected(await attempt({ overrides: { aud: "someone-else" } }));               // issued for another application
  rejected(await attempt({ overrides: { iss: "https://evil.example" } }));        // wrong issuer
  rejected(await attempt({ overrides: { exp: Math.floor(Date.now() / 1000) - 3600 } })); // expired
  rejected(await attempt({ nonceOverride: "not-my-nonce" }));                     // bound to a different attempt
  rejected(await attempt({ overrides: { email_verified: false } }));              // provider did not verify the address
  rejected(await attempt({ overrides: { email: undefined } }));                   // no email at all
  // state issued for org A cannot be finished against org B
  await updateSettings({ orgId: B.oid, patch: { sso: { enabled: true, issuer: idpState.base, clientId: "client-1" } }, actorEmail: B.owner.email });
  await setSsoClientSecret({ orgId: B.oid, secret: "s3cret-value", actorEmail: B.owner.email });
  const { url } = await startSso({ orgId: A.oid, settings: st, slug: A.slug }); const l = login(url, { email: B.alice.email });
  rejected(await callback(B.slug, l.code, l.state));
  // domain allow-list
  await updateSettings({ orgId: A.oid, patch: { sso: { allowedDomains: ["customer.example"] } }, actorEmail: A.owner.email });
  const st2 = await getSettings(A.oid); st2.portalSlug = A.slug;
  const okDomain = login((await startSso({ orgId: A.oid, settings: st2, slug: A.slug })).url, { email: A.bob.email });
  assert.match((await callback(A.slug, okDomain.code, okDomain.state)).cookie, /^inaya_portal_session=/, "an allowed domain is accepted");
  await updateSettings({ orgId: A.oid, patch: { sso: { allowedDomains: ["only-this.example"] } }, actorEmail: A.owner.email });
  const st3 = await getSettings(A.oid); st3.portalSlug = A.slug;
  const blocked = login((await startSso({ orgId: A.oid, settings: st3, slug: A.slug })).url, { email: A.alice.email });
  rejected(await callback(A.slug, blocked.code, blocked.state));
  await updateSettings({ orgId: A.oid, patch: { sso: { allowedDomains: [] } }, actorEmail: A.owner.email });
  assert.ok(await c.orgActivity.findOne({ orgId: A.orgId, action: "PORTAL_SSO_REJECTED" }), "rejections are audited");
  // verifyIdToken rejects a malformed token outright
  await assert.rejects(() => verifyIdToken("a.b", { issuer: idpState.base, clientId: "client-1", nonce: "n", jwksUri: `${idpState.base}/jwks` }), /malformed/);
  // the issuer must be https (loopback http is only allowed under test mode)
  delete process.env.WORKFLOW_HTTP_TEST_ALLOW_LOCAL;
  assert.ok((await updateSettings({ orgId: A.oid, patch: { sso: { issuer: "http://idp.example.com" } }, actorEmail: A.owner.email })).error);
  process.env.WORKFLOW_HTTP_TEST_ALLOW_LOCAL = "1";
  await updateSettings({ orgId: A.oid, patch: { sso: { enabled: false } }, actorEmail: A.owner.email });
  const off = await startSso({ orgId: A.oid, settings: await getSettings(A.oid), slug: A.slug }); assert.equal(off.status, 404, "disabled means unavailable");
});

// ========================================================================================= Resend inbound
const secret = () => process.env.RESEND_WEBHOOK_SECRET;
const svixHeaders = (body, { key = secret(), ts = Math.floor(Date.now() / 1000), id = "msg_test1" } = {}) => ({ "svix-id": id, "svix-timestamp": String(ts), "svix-signature": `v1,${createHmac("sha256", Buffer.from(key.replace(/^whsec_/, ""), "base64")).update(`${id}.${ts}.${body}`).digest("base64")}` });
const AUTH_OK = [{ name: "Authentication-Results", value: "mx.resend.test; dkim=pass header.d=customer.example; spf=pass; dmarc=pass" }];

test("Resend webhook signatures (Svix): valid accepted; wrong secret, stale, tampered and missing rejected", () => {
  const body = J({ type: "email.received", data: { email_id: "em_1" } }); const h = svixHeaders(body);
  const base = { id: h["svix-id"], timestamp: h["svix-timestamp"], signature: h["svix-signature"], rawBody: body, secret: secret() };
  assert.equal(verifySvix(base), true);
  assert.equal(verifySvix({ ...base, secret: `whsec_${Buffer.from("other").toString("base64")}` }), false);
  assert.equal(verifySvix({ ...base, rawBody: body + " " }), false);
  assert.equal(verifySvix({ ...base, now: Date.now() + 3600_000 }), false, "stale");
  assert.equal(verifySvix({ ...base, signature: "" }), false); assert.equal(verifySvix({ ...base, id: "" }), false);
  assert.equal(verifySvix({ ...base, signature: `v1,${Buffer.from("x").toString("base64")} ${h["svix-signature"]}` }), true, "several signatures may be listed (key rotation)");
  assert.deepEqual(authFromHeaders(AUTH_OK), { dkim: "pass", spf: "pass", dmarc: "pass" });
  assert.equal(authFromHeaders({ "X-SES-DKIM-VERDICT": "PASS" }).dkim, "pass");
  assert.deepEqual(authFromHeaders([]), { dkim: "none", spf: "none", dmarc: "none" });
  assert.equal(normHeaders({ "Message-ID": "<a@b>" })["message-id"], "<a@b>");
});

test("Resend inbound: routed by portal address, threaded by signed reply address, sender-checked, attachments scanned", async () => {
  const to = `${A.slug}@in.support.test`;
  const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(64, 2)]);
  const mails = {};
  const fetchers = { get: async (path) => { if (mails[path]) return mails[path]; throw new Error(`no stub for ${path}`); }, download: async (url) => new Response(url.endsWith("eicar") ? Buffer.from(EICAR_TEST_STRING) : png) };
  const ev = (id, meta = {}) => ({ type: "email.received", data: { email_id: id, to: [to], ...meta } });
  const add = (id, mail) => { mails[`/emails/receiving/${id}`] = { to: [to], ...mail }; };

  add("em_new001", { from: `Alice <${A.alice.email}>`, subject: "Drive not syncing", text: "My drive stopped syncing this morning.", message_id: "<n1@customer.example>", headers: AUTH_OK, attachments: [{ id: "at1", filename: "screenshot.png", size: png.length, download_url: "https://files.resend.test/a/shot" }, { id: "at2", filename: "note.txt", size: 68, download_url: "https://files.resend.test/a/eicar" }] });
  const r1 = await handleReceived({ event: ev("em_new001"), fetchers });
  assert.equal(r1.action, "TICKET_CREATED", J(r1));
  const ticket = await loadTicket(A.oid, r1.ticketId);
  assert.equal(ticket.channel, "EMAIL"); assert.equal(ticket.requester.email, A.alice.email);
  const files = await sc.supportAttachments.find({ ticketId: ticket._id }).toArray();
  assert.deepEqual(files.map((f) => f.filename), ["screenshot.png"], "the clean image was stored; the EICAR file was refused");
  const audit = await c.orgActivity.findOne({ orgId: A.orgId, action: "TICKET_ATTACHMENT_BLOCKED", "metadata.filename": "note.txt" });
  assert.ok(audit, "the refused attachment is audited");
  assert.equal((await handleReceived({ event: ev("em_new001"), fetchers })).duplicate, true, "the same Message-ID is not processed twice");

  // reply through the signed reply address
  const settings = { ...(await getSettings(A.oid)), portalSlug: A.slug };
  assert.equal(supportAddressOf(settings), to, "with an inbound domain, the address needs no per-organization setup");
  const replyTo = await replyToAddress({ orgId: A.oid, settings, ticket });
  assert.match(replyTo, new RegExp(`^${A.slug}\\+tkt-\\d+-[0-9a-f]{12}@in\\.support\\.test$`));
  assert.ok(await getInboundSecret(A.oid), "the signing secret was created on demand");
  add("em_rep0002", { from: A.alice.email, to: [replyTo], subject: "Re: Drive not syncing", text: "Update: it works after a restart.\n\nOn Mon Support wrote:\n> old", message_id: "<r1@customer.example>", headers: [...AUTH_OK, { name: "In-Reply-To", value: "<x@y>" }] });
  const r2 = await handleReceived({ event: ev("em_rep0002", { to: [replyTo] }), fetchers });
  assert.equal(r2.action, "REPLY_ADDED", J(r2));
  const msgs = await sc.supportMessages.find({ ticketId: ticket._id }).sort({ createdAt: 1 }).toArray();
  assert.ok(msgs.at(-1).body.startsWith("Update: it works") && !msgs.at(-1).body.includes("old"));

  // someone else with the right reply address, and a spoofed sender, are quarantined
  add("em_bob0003", { from: A.bob.email, to: [replyTo], subject: "Re: x", text: "hijack", message_id: "<b1@customer.example>", headers: AUTH_OK });
  assert.equal((await handleReceived({ event: ev("em_bob0003", { to: [replyTo] }), fetchers })).reason, "SENDER_NOT_PARTICIPANT");
  add("em_spf0004", { from: A.alice.email, to: [replyTo], subject: "Re: x", text: "spoof", message_id: "<s1@customer.example>", headers: [{ name: "Authentication-Results", value: "mx; dkim=fail; spf=fail; dmarc=fail" }] });
  assert.equal((await handleReceived({ event: ev("em_spf0004", { to: [replyTo] }), fetchers })).reason, "SENDER_NOT_AUTHENTICATED");
  add("em_noh0005", { from: A.alice.email, subject: "No auth evidence", text: "hello", message_id: "<h1@customer.example>", headers: [] });
  assert.equal((await handleReceived({ event: ev("em_noh0005"), fetchers })).status, "QUARANTINED", "no authentication evidence is treated as failed");
  assert.equal(await sc.supportMessages.countDocuments({ ticketId: ticket._id }), msgs.length, "nothing hostile was appended");

  // not addressed to any portal, or the wrong domain
  add("em_zzz0006", { from: A.alice.email, to: ["nobody-here@in.support.test"], subject: "x", text: "y", message_id: "<z@x>", headers: AUTH_OK });
  assert.equal((await handleReceived({ event: ev("em_zzz0006", { to: ["nobody-here@in.support.test"] }), fetchers })).reason, "NO_MATCHING_PORTAL");
  add("em_dom0007", { from: A.alice.email, to: [`${A.slug}@other-domain.test`], subject: "x", text: "y", message_id: "<d@x>", headers: AUTH_OK });
  assert.equal((await handleReceived({ event: ev("em_dom0007", { to: [`${A.slug}@other-domain.test`] }), fetchers })).reason, "NO_MATCHING_PORTAL", "only the platform's inbound domain routes mail");
  assert.equal((await handleReceived({ event: { type: "email.received", data: { email_id: "../../evil" } }, fetchers })).reason, "NO_EMAIL_ID");
  // another organization's customer writing to A's address is only ever quarantined
  add("em_oth0008", { from: B.alice.email, subject: "Wrong tenant", text: "hi", message_id: "<o@x>", headers: AUTH_OK });
  assert.equal((await handleReceived({ event: ev("em_oth0008"), fetchers })).status, "QUARANTINED");
});

test("Resend webhook route: only signed requests, only email.received, and it says when it is not configured", async () => {
  const m = await load("resendRoute", "../src/app/api/support/inbound-email/resend/route.js");
  const post = (body, headers) => call(m.POST, new NextRequest("http://localhost/api/support/inbound-email/resend", { method: "POST", headers: { "content-type": "application/json", ...headers }, body }));
  const body = J({ type: "email.delivered", data: {} });
  assert.equal((await post(body, {})).status, 401);
  assert.equal((await post(body, svixHeaders(body, { key: `whsec_${Buffer.from("wrong").toString("base64")}` }))).status, 401);
  assert.equal((await post(body, svixHeaders(body, { ts: Math.floor(Date.now() / 1000) - 7200 }))).status, 401);
  const ignored = await post(body, svixHeaders(body)); assert.equal(ignored.status, 200); assert.equal(ignored.body.status, "IGNORED");
  const saved = process.env.RESEND_WEBHOOK_SECRET; delete process.env.RESEND_WEBHOOK_SECRET;
  assert.equal((await post(body, svixHeaders(body, { key: saved }))).status, 503, "unconfigured: refuses instead of accepting anything");
  process.env.RESEND_WEBHOOK_SECRET = saved;
});

// ============================================================================ administrator status and email test
test("administrators see what is actually switched on; only they can run the email test", async () => {
  const m = await load("agentRoute", "../src/app/api/orgs/support/[[...path]]/route.js");
  const as = async (method, path, who) => call(m[method], req(method, `/api/orgs/support/${path}`, { cookie: `${SESSION_COOKIE}=${await cookieFor(who)}`, query: { orgId: A.oid }, body: method === "POST" ? { orgId: A.oid } : undefined }), { path: path.split("/") });
  const st = await as("GET", "settings/status", A.manager.email);
  assert.equal(st.status, 200, J(st.body));
  assert.equal(st.body.portalUrl, `http://localhost:3000/portal/${A.slug}`);
  assert.equal(st.body.email.inbound.resendWebhookConfigured, true); assert.equal(st.body.email.inbound.inboundDomain, "in.support.test");
  assert.equal(st.body.email.inbound.replyAddress, `${A.slug}@in.support.test`);
  assert.equal(st.body.scanning.builtIn, true); assert.ok(Array.isArray(st.body.scanning.engines)); assert.match(st.body.scanning.note, /built-in/i);
  assert.equal(st.body.attachments.maxBytes, 25 * 1024 * 1024);
  assert.ok(!J(st.body).includes(process.env.RESEND_WEBHOOK_SECRET) && !J(st.body).includes(process.env.RESEND_API_KEY || "\u0000"), "no secret in the status");
  assert.equal((await as("GET", "settings/status", A.agent.email)).status, 403);
  const te = await as("POST", "settings/test-email", A.manager.email);
  assert.ok([200, 502].includes(te.status), J(te.body));
  if (te.status === 502) assert.match(te.body.error, /not configured|refused/i); else assert.equal(te.body.sent, true);
  assert.equal((await as("POST", "settings/test-email", A.agent.email)).status, 403);
  const ssoTest = await as("POST", "settings/sso-test", A.manager.email);
  assert.ok([200, 400, 502].includes(ssoTest.status));
});
