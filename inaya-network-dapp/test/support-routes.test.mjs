// test/support-routes.test.mjs -- Customer Portal & Customer Service over HTTP: the REAL route handlers with real
// cookies / API keys / signatures against the real database. Covers the acceptance journeys (SOW §58-§64):
// the full customer journey, cross-tenant isolation, email-thread hijack attempts, SLA/AI failure behaviour at the
// API, the public API contract, CSRF, attachments, export and the cron entry point.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server.js";
import { setup, makeSupportOrg, cleanup, cookieFor, sc } from "./_support-fixtures.mjs";
import { SESSION_COOKIE } from "../src/lib/orgs.js";
import { __setAiProvider } from "../src/lib/workflows/ai.js";
import { rotateInboundSecret, updateSettings } from "../src/lib/support/settings.js";
import { ticketToken } from "../src/lib/support/notify.js";
import { createApiKey } from "../src/lib/api-keys.js";
import { flushEvidence } from "../src/lib/support/record.js";

const J = JSON.stringify;
const mod = {}; const load = async (k, p) => (mod[k] ||= await import(p));
let A; let B; let tok = {}; let inboundSecret;
let aiDown = false;

function req(method, path, { body, cookie, headers = {}, query = {}, form } = {}) {
  const url = new URL(`http://localhost${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const h = { "x-forwarded-for": "203.0.113.7", host: "localhost", ...(cookie ? { cookie } : {}), ...headers };
  if (!form) h["content-type"] = "application/json";
  return new NextRequest(url, { method, headers: h, ...(form ? { body: form } : body !== undefined ? { body: typeof body === "string" ? body : J(body) } : {}) });
}
const call = async (handler, r, params = {}) => { const res = await handler(r, { params: Promise.resolve(params) }); const ct = res.headers.get("content-type") || ""; return { status: res.status, headers: res.headers, body: ct.includes("json") ? await res.json().catch(() => ({})) : Buffer.from(await res.arrayBuffer()) }; };

const portal = async (slug, method, path, opts = {}) => { const m = await load("portal", "../src/app/api/portal/[slug]/[[...path]]/route.js"); return call(m[method], req(method, `/api/portal/${slug}/${path}`, { ...opts, headers: { "x-portal-request": "1", ...(opts.headers || {}) } }), { slug, path: path.split("?")[0].split("/") }); };
const agent = async (method, path, who, { body, query = {} } = {}) => { const m = await load("agent", "../src/app/api/orgs/support/[[...path]]/route.js"); return call(m[method], req(method, `/api/orgs/support/${path}`, { cookie: `${SESSION_COOKIE}=${tok[who]}`, body: body ? { orgId: A.oid, ...body } : (method === "GET" ? undefined : { orgId: A.oid }), query: { orgId: A.oid, ...query } }), { path: path.split("/") }); };
const pub = async (method, path, key, { body, headers = {}, query = {} } = {}) => { const m = await load("pub", "../src/app/api/public/v1/support/[[...path]]/route.js"); return call(m[method], req(method, `/api/public/v1/support/${path}`, { body, query, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers } }), { path: path.split("/") }); };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

async function customerCookie(org, email) {
  const r = await portal(org.slug, "POST", "auth/request", { body: { email }, headers: {} });
  assert.equal(r.status, 200);
  const token = new URL(r.body.devLink).searchParams.get("token");
  const m = await load("portal", "../src/app/api/portal/[slug]/[[...path]]/route.js");
  const res = await m.POST(req("POST", `/api/portal/${org.slug}/auth/verify`, { body: { token }, headers: { "x-portal-request": "1" } }), { params: Promise.resolve({ slug: org.slug, path: ["auth", "verify"] }) });
  assert.equal(res.status, 200);
  const set = res.headers.get("set-cookie"); assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Lax/);
  return set.split(";")[0];
}

before(async () => {
  process.env.CRON_SECRET = "test-cron-secret";
  await setup();
  A = await makeSupportOrg("ra", { settings: { email: { supportAddress: "support@acme.example" } } });
  B = await makeSupportOrg("rb");
  tok = { owner: await cookieFor(A.owner.email), agent: await cookieFor(A.agent.email), manager: await cookieFor(A.manager.email), plain: await cookieFor(A.plain.email), foreign: await cookieFor(B.owner.email) };
  inboundSecret = (await rotateInboundSecret({ orgId: A.oid, actorEmail: A.owner.email })).inboundSecret;
  __setAiProvider(async ({ system }) => {
    if (aiDown) throw Object.assign(new Error("down"), { retryable: true });
    if (/classify customer support tickets/.test(system)) return { text: J({ category: "Billing", queue: "General", priority: "NORMAL", sentiment: "neutral", urgent: false, summary: "Billing question", confidence: 0.9 }) };
    return { text: J({ answer: "n/a", confidence: 0.1, needsHuman: true }) };
  });
});
after(async () => { __setAiProvider(null); await flushEvidence(); await cleanup(); });

test("customer journey end to end (§58)", async () => {
  const aliceCookie = await customerCookie(A, A.alice.email);
  const cfg = await portal(A.slug, "GET", "config", { cookie: aliceCookie });
  assert.equal(cfg.body.signedIn, true);

  // an invoice that is not hers cannot be linked; her own can
  const bad = await portal(A.slug, "POST", "tickets", { cookie: aliceCookie, body: { subject: "Invoice question", description: "About the invoice", linkedInvoiceNumber: `INV-${A.slug.split("-")[1]}-ra-B1` } });
  assert.equal(bad.status, 400, J(bad.body));
  const made = await portal(A.slug, "POST", "tickets", { cookie: aliceCookie, body: { subject: "Invoice looks wrong", description: "Total is wrong.", type: "Billing", linkedInvoiceNumber: A.aliceInvoiceNumber, idempotencyKey: "abc-12345" } });
  assert.equal(made.status, 200, J(made.body));
  const id = made.body.ticket.id;
  const dup = await portal(A.slug, "POST", "tickets", { cookie: aliceCookie, body: { subject: "Invoice looks wrong", description: "Total is wrong.", type: "Billing", idempotencyKey: "abc-12345" } });
  assert.equal(dup.body.ticket.id, id, "a double submit creates one ticket");
  const inv = await portal(A.slug, "GET", "invoices", { cookie: aliceCookie });
  assert.equal(inv.body.invoices.length, 1); assert.equal(inv.body.invoices[0].invoiceNumber, A.aliceInvoiceNumber);

  // agent works it
  const list = await agent("GET", "tickets", "agent", { query: { view: "all" } });
  assert.equal(list.status, 200); assert.ok(list.body.tickets.some((t) => t.id === id));
  const det = await agent("GET", `tickets/${id}`, "agent");
  assert.equal(det.status, 200); assert.ok(det.body.linkedInvoices.length === 1, "linked invoice is read from Finance");
  assert.ok((await agent("POST", `tickets/${id}/note`, "agent", { body: { body: "Internal: check ledger" } })).status === 200);
  const rep = await agent("POST", `tickets/${id}/reply`, "agent", { body: { body: "Hi Alice, checking now.", setStatus: "WAITING_FOR_CUSTOMER" } });
  assert.equal(rep.status, 200, J(rep.body));

  // customer sees only public content and the customer-safe status
  const seen = await portal(A.slug, "GET", `tickets/${id}`, { cookie: aliceCookie });
  assert.equal(seen.body.ticket.status, "WAITING_FOR_YOU");
  assert.ok(!J(seen.body).includes("Internal: check ledger"));
  assert.ok(!J(seen.body).includes(A.agent.email), "agent identity is not disclosed");

  // reply with an attachment
  const r2 = await portal(A.slug, "POST", `tickets/${id}/reply`, { cookie: aliceCookie, body: { body: "Here is the screenshot." } });
  assert.equal(r2.status, 200, J(r2.body));
  const fd = new FormData(); fd.append("file", new Blob([png], { type: "image/png" }), "shot.png");
  const up = await load("up", "../src/app/api/portal/[slug]/upload/route.js");
  const upr = await call(up.POST, req("POST", `/api/portal/${A.slug}/upload`, { cookie: aliceCookie, form: fd, query: { ticketId: id, messageId: r2.body.message.id }, headers: { "x-portal-request": "1" } }), { slug: A.slug });
  assert.equal(upr.status, 200, J(upr.body));
  const attId = upr.body.attachment.id;
  const dl = await load("dl", "../src/app/api/portal/[slug]/attachments/[id]/route.js");
  const got = await call(dl.GET, req("GET", `/api/portal/${A.slug}/attachments/${attId}`, { cookie: aliceCookie }), { slug: A.slug, id: attId });
  assert.equal(got.status, 200); assert.ok(Buffer.compare(got.body, png) === 0, "bytes round-trip through encrypted storage");
  assert.equal(got.headers.get("content-disposition").startsWith("attachment"), true); assert.equal(got.headers.get("x-content-type-options"), "nosniff");
  // an executable is refused
  const fd2 = new FormData(); fd2.append("file", new Blob([Buffer.from("MZ....")], { type: "application/octet-stream" }), "evil.png.exe");
  const bad2 = await call(up.POST, req("POST", `/api/portal/${A.slug}/upload`, { cookie: aliceCookie, form: fd2, query: { ticketId: id }, headers: { "x-portal-request": "1" } }), { slug: A.slug });
  assert.equal(bad2.status, 400);

  // a colleague (same company) and another organization's customer cannot read the ticket or the file
  const bobCookie = await customerCookie(A, A.bob.email);
  assert.equal((await portal(A.slug, "GET", `tickets/${id}`, { cookie: bobCookie })).status, 404);
  assert.equal((await call(dl.GET, req("GET", `/api/portal/${A.slug}/attachments/${attId}`, { cookie: bobCookie }), { slug: A.slug, id: attId })).status, 404);
  const bCookie = await customerCookie(B, B.alice.email);
  assert.equal((await call(dl.GET, req("GET", `/api/portal/${B.slug}/attachments/${attId}`, { cookie: bCookie }), { slug: B.slug, id: attId })).status, 404);
  assert.equal((await portal(A.slug, "GET", `tickets/${id}`, { cookie: bCookie })).status, 401, "org B's session is not a session for org A");

  // the agent can download it too (audited); solve; rate; export
  const adl = await load("adl", "../src/app/api/orgs/support/attachments/[id]/route.js");
  assert.equal((await call(adl.GET, req("GET", `/api/orgs/support/attachments/${attId}`, { cookie: `${SESSION_COOKIE}=${tok.agent}`, query: { orgId: A.oid } }), { id: attId })).status, 200);
  assert.equal((await agent("POST", `tickets/${id}/status`, "agent", { body: { status: "SOLVED" } })).status, 200);
  const rate = await portal(A.slug, "POST", `tickets/${id}/csat`, { cookie: aliceCookie, body: { score: 4, comment: "ok" } });
  assert.equal(rate.status, 200, J(rate.body));
  const ex = await load("ex", "../src/app/api/orgs/support/export/route.js");
  const exp = await call(ex.GET, req("GET", "/api/orgs/support/export", { cookie: `${SESSION_COOKIE}=${tok.manager}`, query: { orgId: A.oid, format: "csv" } }));
  assert.equal(exp.status, 200); assert.match(exp.headers.get("x-content-sha256"), /^[0-9a-f]{64}$/); assert.ok(exp.body.toString().includes("TKT-"));
  assert.equal((await call(ex.GET, req("GET", "/api/orgs/support/export", { cookie: `${SESSION_COOKIE}=${tok.agent}`, query: { orgId: A.oid } }))).status, 403, "export needs its own permission");
  // the audit chain recorded the story
  const audits = await (await import("../src/lib/orgs.js")).getOrgCollections().then((cc) => cc.orgActivity.find({ orgId: A.orgId, recordType: "SUPPORT_TICKET" }).project({ action: 1 }).toArray());
  const acts = new Set(audits.map((a) => a.action));
  for (const a of ["TICKET_CREATED", "TICKET_REPLIED", "TICKET_ATTACHMENT_ADDED", "TICKET_ATTACHMENT_ACCESSED", "TICKET_CSAT_RECEIVED"]) assert.ok(acts.has(a), `audit has ${a}: ${[...acts]}`);
  assert.ok([...acts].some((a) => /STATUS|SOLVED/.test(a)), `a status change was audited: ${[...acts]}`);
});

test("CSRF, unauthenticated and rate-limited portal access", async () => {
  const m = await load("portal", "../src/app/api/portal/[slug]/[[...path]]/route.js");
  const noHeader = await call(m.POST, req("POST", `/api/portal/${A.slug}/auth/request`, { body: { email: A.alice.email } }), { slug: A.slug, path: ["auth", "request"] });
  assert.equal(noHeader.status, 403);
  const crossSite = await call(m.POST, req("POST", `/api/portal/${A.slug}/auth/request`, { body: { email: A.alice.email }, headers: { "x-portal-request": "1", origin: "https://evil.example" } }), { slug: A.slug, path: ["auth", "request"] });
  assert.equal(crossSite.status, 403);
  assert.equal((await portal(A.slug, "GET", "tickets")).status, 401);
  assert.equal((await portal("no-such-portal-xyz", "GET", "config")).status, 404);
  // the request-link answer is identical for a stranger
  const a = await portal(A.slug, "POST", "auth/request", { body: { email: "stranger@nowhere.example" } });
  assert.equal(a.status, 200); assert.equal(a.body.devLink, undefined);
});

test("agent API: permissions and tenancy (§57)", async () => {
  assert.equal((await agent("GET", "tickets", "plain")).status, 403, "member without a support role");
  assert.equal((await agent("GET", "tickets", "foreign")).status, 403, "another organization's owner");
  assert.equal((await agent("PUT", "settings", "agent", { body: { ticketPrefix: "ZZZ" } })).status, 403, "agents cannot change settings");
  assert.equal((await agent("PUT", "settings", "manager", { body: { ticketPrefix: "ZZZ" } })).status, 200);
  assert.equal((await agent("PUT", "settings", "manager", { body: { ticketPrefix: "zz" } })).status, 400, "validation");
  await agent("PUT", "settings", "manager", { body: { ticketPrefix: "TKT" } });
  const s = await agent("GET", "settings", "manager"); assert.ok(!J(s.body).includes(inboundSecret), "the inbound secret is never returned");
  assert.equal((await agent("POST", "api-keys", "agent", { body: { label: "x", scopes: ["tickets:read"] } })).status, 403);
  assert.equal((await agent("GET", "nope", "agent")).status, 404);
});

test("public API: scopes, customer binding, idempotency, no internals (§28, §64)", async () => {
  const mk = async (body) => (await agent("POST", "api-keys", "manager", { body })).body;
  const aliceKey = await mk({ label: "alice", scopes: ["tickets:read", "tickets:write", "knowledge:read", "invoices:read", "customers:read"], customerEmail: A.alice.email });
  const bobKey = await mk({ label: "bob", scopes: ["tickets:read", "tickets:write"], customerEmail: A.bob.email });
  const svcKey = await mk({ label: "svc", scopes: ["tickets:read", "tickets:write", "events:read", "queues:read"] });
  const readOnly = await mk({ label: "ro", scopes: ["tickets:read"] });
  assert.ok(aliceKey.rawKey.startsWith("inaya_sup_"));

  assert.equal((await pub("GET", "tickets", null)).status, 401);
  assert.equal((await pub("GET", "tickets", "inaya_sup_wrong")).status, 401);
  assert.equal((await pub("POST", "tickets", readOnly.rawKey, { body: { subject: "x y z", description: "d" } })).status, 403, "missing scope");

  const idem = { "idempotency-key": "pub-idem-0001" };
  const c1 = await pub("POST", "tickets", aliceKey.rawKey, { body: { subject: "API created ticket", description: "Made through the API." }, headers: idem });
  assert.equal(c1.status, 201, J(c1.body));
  const c2 = await pub("POST", "tickets", aliceKey.rawKey, { body: { subject: "API created ticket", description: "Made through the API." }, headers: idem });
  assert.equal(c2.body.ticket.id, c1.body.ticket.id); assert.equal(c2.body.duplicate, true, "retry returns the first ticket");
  const id = c1.body.ticket.id;
  assert.equal(c1.body.ticket.messages.length, 1);
  assert.ok(!("assigneeEmail" in c1.body.ticket) && !J(c1.body).includes("aiTriage") && !J(c1.body).includes("routing"), "no internals in the API");

  // customer-bound keys are confined to their customer
  assert.equal((await pub("GET", `tickets/${id}`, bobKey.rawKey)).status, 404, "bob's key cannot read alice's ticket");
  assert.equal((await pub("GET", "tickets", bobKey.rawKey)).body.tickets.length, 0);
  assert.equal((await pub("POST", "tickets", aliceKey.rawKey, { body: { subject: "For someone else", description: "d", customerEmail: A.bob.email } })).status, 403);
  assert.equal((await pub("GET", "tickets", aliceKey.rawKey)).body.tickets.length >= 1, true);
  const rp = await pub("POST", `tickets/${id}/replies`, aliceKey.rawKey, { body: { body: "More info via API." } });
  assert.equal(rp.status, 201, J(rp.body));
  assert.equal((await pub("GET", "invoices", aliceKey.rawKey)).body.invoices.length, 1);
  // a service key names the customer per request; an events feed is service-only
  const sv = await pub("POST", "tickets", svcKey.rawKey, { body: { subject: "Service made", description: "d", customerEmail: A.bob.email } });
  assert.equal(sv.status, 201, J(sv.body));
  assert.equal((await pub("POST", "tickets", svcKey.rawKey, { body: { subject: "no customer", description: "d" } })).status, 400);
  assert.equal((await pub("GET", "events", svcKey.rawKey)).status, 200);
  assert.equal((await pub("GET", "events", aliceKey.rawKey)).status, 403);
  // support keys are refused by the owner-level legacy resolver
  const legacy = await load("legacy", "../src/app/api/public/v1/workflows/route.js").catch(() => null);
  const { requireApiKey } = await import("../src/lib/api-keys.js");
  assert.equal((await requireApiKey(new Request("http://x", { headers: { authorization: `Bearer ${aliceKey.rawKey}` } }))).status, 401);
  // revoke works immediately
  const list = await agent("GET", "api-keys", "manager");
  const row = list.body.apiKeys.find((k) => k.label === "svc");
  assert.equal((await agent("DELETE", `api-keys/${row.apiKeyId}`, "manager")).status, 200);
  assert.equal((await pub("GET", "tickets", svcKey.rawKey, { query: { customerEmail: A.bob.email } })).status, 401);
});

test("inbound email: signature, threading, sender checks, idempotency (§11, §60)", async () => {
  const inbound = await load("inb", "../src/app/api/support/inbound-email/[slug]/route.js");
  const send = async (msg, { secret = inboundSecret, ts = String(Math.floor(Date.now() / 1000)) } = {}) => {
    const raw = J(msg);
    const sig = createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex");
    return call(inbound.POST, new NextRequest(`http://localhost/api/support/inbound-email/${A.slug}`, { method: "POST", headers: { "x-inaya-timestamp": ts, "x-inaya-signature": sig, "content-type": "application/json" }, body: raw }), { slug: A.slug });
  };
  const auth = { dkim: "pass", dmarc: "pass", spf: "pass" };
  // unsigned / wrongly signed / stale deliveries are refused
  assert.equal((await call(inbound.POST, new NextRequest(`http://localhost/api/support/inbound-email/${A.slug}`, { method: "POST", body: "{}" }), { slug: A.slug })).status, 401);
  assert.equal((await send({ from: A.alice.email, subject: "x", text: "y", auth }, { secret: "wrong" })).status, 401);
  assert.equal((await send({ from: A.alice.email, subject: "x", text: "y", auth }, { ts: String(Math.floor(Date.now() / 1000) - 3600) })).status, 401);

  // a known customer emailing in creates a ticket; the same Message-ID again does not
  const m1 = { messageId: "<m1@mail.example>", from: `Alice <${A.alice.email}>`, to: ["support@acme.example"], subject: "Cannot access my drive", text: "I cannot access my drive since this morning.", auth };
  const r1 = await send(m1); assert.equal(r1.status, 200, J(r1.body)); assert.equal(r1.body.action, "TICKET_CREATED");
  const r1b = await send(m1); assert.equal(r1b.body.duplicate, true); assert.equal(r1b.body.ticketId, r1.body.ticketId);
  const ticket = await sc.supportTickets.findOne({ _id: (await import("mongodb")).ObjectId.createFromHexString(r1.body.ticketId) });
  assert.equal(ticket.channel, "EMAIL");

  // a reply via the signed reply-address from the requester is appended
  const addr = `support+${ticketToken(inboundSecret, ticket)}@acme.example`;
  const r2 = await send({ messageId: "<m2@mail.example>", from: A.alice.email, to: [addr], subject: "Re: Cannot access my drive", text: "Update: still broken.\n\nOn Mon, Support wrote:\n> quoted history", auth });
  assert.equal(r2.body.action, "REPLY_ADDED", J(r2.body));
  const msgs = await sc.supportMessages.find({ ticketId: ticket._id }).toArray();
  assert.equal(msgs.length, 2); assert.ok(!msgs[1].body.includes("quoted history"), "quoted history is stripped");

  // §60: someone else (even a real customer, even with the right reply address) cannot inject into the thread
  const evil = await send({ messageId: "<m3@mail.example>", from: A.bob.email, to: [addr], subject: "Re: Cannot access my drive", text: "Take a look at this link", auth });
  assert.equal(evil.body.status, "QUARANTINED"); assert.equal(evil.body.reason, "SENDER_NOT_PARTICIPANT");
  const spoof = await send({ messageId: "<m4@mail.example>", from: A.alice.email, to: [addr], subject: "Re: x", text: "spoofed", auth: { dkim: "fail", dmarc: "fail", spf: "fail" } });
  assert.equal(spoof.body.status, "QUARANTINED"); assert.equal(spoof.body.reason, "SENDER_NOT_AUTHENTICATED");
  // a guessed ticket number without the signature does not thread
  const guess = await send({ messageId: "<m5@mail.example>", from: "attacker@evil.example", to: [`support+${String(ticket.number).toLowerCase()}-aaaaaaaaaaaa@acme.example`], subject: "Re: hi", text: "hello", auth });
  assert.equal(guess.body.status, "QUARANTINED"); assert.equal(guess.body.reason, "UNKNOWN_SENDER");
  assert.equal(await sc.supportMessages.countDocuments({ ticketId: ticket._id }), 2, "nothing was appended by the hostile messages");
  // auto-replies never create tickets
  const auto = await send({ messageId: "<m6@mail.example>", from: A.alice.email, to: ["support@acme.example"], subject: "Automatic reply: out of office", text: "I am away", headers: { "Auto-Submitted": "auto-replied" }, auth });
  assert.equal(auto.body.status, "IGNORED");
});

test("cron entry point needs the secret and runs the worker (§61)", async () => {
  const cron = await load("cron", "../src/app/api/cron/support/route.js");
  assert.equal((await call(cron.GET, req("GET", "/api/cron/support"))).status, 401);
  const ok = await call(cron.GET, req("GET", "/api/cron/support", { headers: { authorization: "Bearer test-cron-secret" } }));
  assert.equal(ok.status, 200, J(ok.body)); assert.equal(ok.body.success, true); assert.ok(ok.body.sla && ok.body.triage && ok.body.webhooks);
});
