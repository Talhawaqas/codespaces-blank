// test/ai-cross-org.test.mjs
//
// AI Security §14 gap: cross-organization isolation specific to the AI paths. The attacker is the
// OWNER of org A (the most privileged identity in A), and every attempt targets org B's data:
//   - the AI routes called with org B's id and org A's session -> never 200
//   - the tool dispatcher (what the model can call) running as org A -> never surfaces B's records
//   - AI action requests belonging to B can't be listed, reviewed or cancelled through A
// A positive control (A's own data IS visible to A) proves the negative results aren't vacuous.
//
// Run: GEMINI_API_KEY= GROQ_API_KEY= node --import ./test/_next-loader.mjs \
//        --env-file=.env.local --test --test-force-exit test/ai-cross-org.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { NextRequest } from "next/server.js";
import { getOrgCollections, ensureOrgIndexes, createSession, SESSION_COOKIE } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { buildBusinessContext, runBusinessTool } from "../src/lib/ai-business-tools.js";

for (const k of ["GEMINI_API_KEY", "GROQ_API_KEY", "GOOGLE_API_KEY"]) process.env[k] = "";

const RUN = randomUUID().slice(0, 8);
const SECRET_B = `SECRETB${RUN}`;
const NOW = new Date().toISOString();
let c, orgA, orgB, ownerA, ownerB, tokenA, aReq, bReq;

before(async () => {
  await ensureOrgIndexes();
  c = await getOrgCollections();
  orgA = new ObjectId();
  orgB = new ObjectId();
  ownerA = `xorg-a-${RUN}@example.com`;
  ownerB = `xorg-b-${RUN}@example.com`;
  for (const [id, name, owner] of [[orgA, "A", ownerA], [orgB, "B", ownerB]]) {
    await c.orgs.insertOne({ _id: id, name: `xorg-${name}-${RUN}`, createdAt: NOW });
    await c.orgMembers.insertOne({ orgId: id, email: owner, role: "owner", status: "active", createdAt: NOW });
    const dept = await c.departments.insertOne({ orgId: id, name: `Dept-${name}`, createdAt: NOW });
    const contact = await c.crmContacts.insertOne({ orgId: id, departmentId: dept.insertedId, name: name === "B" ? `${SECRET_B} Contact` : `Alpha Contact ${RUN}`, type: "CUSTOMER", email: `c-${name}@example.com`, company: name === "B" ? `${SECRET_B} Corp` : "Alpha Corp", createdAt: NOW });
    await c.invoices.insertOne({ orgId: id, departmentId: dept.insertedId, contactId: contact.insertedId, invoiceNumber: name === "B" ? `INV-${SECRET_B}` : `INV-A-${RUN}`, status: "DRAFT", total: 100, currency: "USD", createdAt: NOW });
  }
  bReq = (await c.aiActionRequests.insertOne({
    orgId: orgB, assistantSurface: "business", toolName: "propose_invoice_decision", targetRecordType: "INVOICE", targetRecordId: new ObjectId(),
    proposedAction: "send", requestedContextSummary: `${SECRET_B} secret request`, status: "PENDING_APPROVAL", requestedByEmail: ownerB, requestedAt: NOW,
  })).insertedId;
  tokenA = (await createSession(ownerA)).sessionToken;
});

after(async () => {
  const ids = [orgA, orgB];
  for (const k of ["orgs", "orgMembers", "departments", "crmContacts", "invoices", "aiActionRequests", "orgActivity", "aiSecurityChecks"]) {
    try { await c[k].deleteMany(k === "orgs" ? { _id: { $in: ids } } : { orgId: { $in: ids } }); } catch { /* ignore */ }
  }
  await (await mongoClientPromise).close();
});

const request = (url, { method = "GET", body, cookie = true } = {}) =>
  new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}`, ...(cookie ? { cookie: `${SESSION_COOKIE}=${tokenA}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

const ctxFor = async (orgId, email) => buildBusinessContext({ orgId, membership: { role: "owner", orgId, email }, email });

// ---------------------------------------------------------------- AI routes

const ROUTES = [
  { name: "business-chat", mod: "../src/app/api/ai/business-chat/route.js", body: (id) => ({ orgId: id, messages: [{ role: "user", content: "show contacts" }] }) },
  { name: "os-chat", mod: "../src/app/api/ai/os-chat/route.js", body: (id) => ({ orgId: id, messages: [{ role: "user", content: "show contacts" }] }) },
  { name: "voice-session", mod: "../src/app/api/ai/voice-session/route.js", body: (id) => ({ orgId: id, currentView: "home" }) },
  { name: "voice-tool-relay", mod: "../src/app/api/ai/voice-tool-relay/route.js", body: (id) => ({ orgId: id, toolName: "list_contacts", args: {}, currentView: "home" }) },
];

for (const r of ROUTES) {
  test(`${r.name}: org A's owner cannot use org B's id (403), and an unauthenticated caller gets 401`, async () => {
    const { POST } = await import(r.mod);
    const crossOrg = await POST(request("/api/ai/x", { method: "POST", body: r.body(String(orgB)) }));
    assert.equal(crossOrg.status, 403, `${r.name} must refuse another org's id`);
    const text = await crossOrg.text();
    assert.ok(!text.includes(SECRET_B), "the refusal must not leak anything about org B");

    const anon = await POST(request("/api/ai/x", { method: "POST", body: r.body(String(orgA)), cookie: false }));
    assert.equal(anon.status, 401, `${r.name} must require a session`);
  });
}

// ---------------------------------------------------------------- tool dispatcher

test("positive control: the same tools do surface org A's own data to org A", async () => {
  const ctx = await ctxFor(orgA, ownerA);
  const contacts = await runBusinessTool("list_contacts", {}, ctx);
  assert.ok(contacts.count >= 1 && JSON.stringify(contacts).includes(`Alpha Contact ${RUN}`));
  const invoices = await runBusinessTool("list_invoices", {}, ctx);
  assert.ok(JSON.stringify(invoices).includes(`INV-A-${RUN}`));
});

test("list tools running as org A never return org B's records, even when searching for them by name", async () => {
  const ctx = await ctxFor(orgA, ownerA);
  const everything = await Promise.all([
    runBusinessTool("list_contacts", {}, ctx),
    runBusinessTool("list_contacts", { search: SECRET_B }, ctx),
    runBusinessTool("list_contacts", { search: "Corp", limit: 25 }, ctx),
    runBusinessTool("list_invoices", {}, ctx),
    runBusinessTool("list_deals", {}, ctx),
    runBusinessTool("list_documents", {}, ctx),
    runBusinessTool("list_departments", {}, ctx),
    runBusinessTool("get_activity", {}, ctx),
  ]);
  for (const result of everything) assert.ok(!JSON.stringify(result).includes(SECRET_B), "org B's data must never appear in org A's tool output");
  assert.equal(everything[1].count, 0);
});

test("a tool argument can't smuggle another org's id: orgId / departmentId overrides are ignored", async () => {
  const ctx = await ctxFor(orgA, ownerA);
  const result = await runBusinessTool("list_contacts", { orgId: String(orgB), departmentName: "Dept-B", search: SECRET_B }, ctx);
  assert.equal(result.count, 0);
  assert.ok(!JSON.stringify(result).includes(SECRET_B));
});

test("propose_* tools can't target org B's records from org A", async () => {
  const ctx = await ctxFor(orgA, ownerA);
  const result = await runBusinessTool("propose_invoice_decision", { invoiceNumber: `INV-${SECRET_B}`, action: "send" }, ctx);
  assert.equal(result.notFound, true);
  assert.equal(await c.aiActionRequests.countDocuments({ orgId: orgA }), 0, "nothing was proposed in org A for a B record");
});

// ---------------------------------------------------------------- AI action requests

test("org A's owner can't list org B's AI action requests", async () => {
  const { GET } = await import("../src/app/api/orgs/ai-actions/route.js");
  const res = await GET(request(`/api/orgs/ai-actions?orgId=${orgB}`));
  assert.equal(res.status, 403);
  assert.ok(!(await res.text()).includes(SECRET_B));

  const own = await GET(request(`/api/orgs/ai-actions?orgId=${orgA}`));
  assert.equal(own.status, 200);
  assert.ok(!(await own.text()).includes(SECRET_B), "A's own list contains none of B's requests");
});

test("org A's owner can't review or cancel org B's request, by claiming B's org or by claiming A's org with B's request id", async () => {
  const { POST: review } = await import("../src/app/api/orgs/ai-actions/[requestId]/review/route.js");
  const { POST: cancel } = await import("../src/app/api/orgs/ai-actions/[requestId]/cancel/route.js");
  const params = { params: { requestId: String(bReq) } };

  for (const handler of [review, cancel]) {
    const asB = await handler(request("/api/x", { method: "POST", body: { orgId: String(orgB), decision: "approve" } }), params);
    assert.equal(asB.status, 403);
    const asA = await handler(request("/api/x", { method: "POST", body: { orgId: String(orgA), decision: "approve" } }), params);
    assert.equal(asA.status, 404, "B's request does not exist from inside org A");
  }
  const still = await c.aiActionRequests.findOne({ _id: bReq });
  assert.equal(still.status, "PENDING_APPROVAL", "the request was not changed");
});

test("org A's owner can't read org B's AI security events or policy", async () => {
  const { GET: events } = await import("../src/app/api/orgs/ai-security/events/route.js");
  const res = await events(request(`/api/orgs/ai-security/events?orgId=${orgB}`));
  assert.equal(res.status, 403);
  const { GET: policy } = await import("../src/app/api/orgs/ai-security/policy/route.js");
  const pres = await policy(request(`/api/orgs/ai-security/policy?orgId=${orgB}`));
  assert.equal(pres.status, 403);
});
