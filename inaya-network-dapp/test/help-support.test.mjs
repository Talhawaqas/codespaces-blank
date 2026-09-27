// Help & Support: Inaya's own users raise tickets to Inaya's own support desk (real database, real ticket pipeline). Outbound email is intercepted, never sent.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { getOrgCollections, ensureOrgIndexes, createSession } from "../src/lib/orgs.js";
import { updateSettings } from "../src/lib/support/settings.js";
import { getSupportCollections } from "../src/lib/support/db.js";
import { POST as ticketPost } from "../src/app/api/help/ticket/route.js";
import { GET as configGet } from "../src/app/api/help/config/route.js";
import clientPromise from "../src/lib/mongodb.js";

const RUN = randomBytes(3).toString("hex"); const created = []; const emails = [];
const realFetch = globalThis.fetch;
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || "re_test_key";
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://api.resend.com/")) { emails.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); }
  return realFetch(url, init);
};
after(async () => {
  globalThis.fetch = realFetch; delete process.env.INAYA_SUPPORT_ORG_ID; delete process.env.INAYA_SUPPORT_NOTIFY_EMAIL;
  try {
    const c = await getOrgCollections();
    for (const n of (await c.db.listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name)) { try { await c.db.collection(n).deleteMany({ orgId: { $in: created } }); } catch { /* ignore */ } }
    await c.orgs.deleteMany({ _id: { $in: created } });
    await c.db.collection("sessions").deleteMany({ email: new RegExp(`^help-${RUN}`) }); await c.db.collection("rate_limit_hits").deleteMany({ key: new RegExp(`^help-${RUN}`) });
  } catch { /* best effort */ }
  try { await (await clientPromise).close(); } catch { /* ignore */ }
});

const req = (body, token) => new NextRequest("http://localhost/api/help/ticket", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) });
let deskId; let memberEmail; let memberToken; let memberOrgId; let outsiderEmail; let outsiderToken;
const valid = (o = {}) => ({ subject: "I cannot download a file", description: "Downloading my report fails with an error after a few seconds.", category: "Storage", ...o });

test("setup: Inaya's support desk, a user's own organization, and two signed-in users", async () => {
  await ensureOrgIndexes(); const c = await getOrgCollections(); const now = new Date().toISOString();
  deskId = (await c.orgs.insertOne({ name: `help-${RUN}-inaya-support`, createdAt: now })).insertedId; created.push(deskId);
  await c.departments.insertOne({ orgId: deskId, name: "Support", createdAt: now });
  const u = await updateSettings({ orgId: String(deskId), patch: { portalEnabled: true, portalSlug: `help${RUN}desk`, signup: "open" }, actorEmail: `help-${RUN}-admin@example.com` });
  assert.ok(!u.error, JSON.stringify(u));
  memberOrgId = (await c.orgs.insertOne({ name: `help-${RUN}-customer-co`, createdAt: now })).insertedId; created.push(memberOrgId);
  memberEmail = `help-${RUN}-member@example.com`; outsiderEmail = `help-${RUN}-outsider@example.com`;
  await c.orgMembers.insertOne({ orgId: memberOrgId, email: memberEmail, role: "member", departmentIds: [], status: "active", createdAt: now });
  memberToken = (await createSession(memberEmail)).sessionToken; outsiderToken = (await createSession(outsiderEmail)).sessionToken;
  process.env.INAYA_SUPPORT_ORG_ID = String(deskId); process.env.INAYA_SUPPORT_NOTIFY_EMAIL = "support@inayanetwork.com";
});

test("config: public, reports the portal path, and never the organization id", async () => {
  const body = await (await configGet()).json();
  assert.deepEqual(body, { enabled: true, portalPath: `/portal/help${RUN}desk` });
  const saved = process.env.INAYA_SUPPORT_ORG_ID; delete process.env.INAYA_SUPPORT_ORG_ID;
  assert.deepEqual(await (await configGet()).json(), { enabled: false, portalPath: null });
  process.env.INAYA_SUPPORT_ORG_ID = saved;
});

test("an anonymous visitor cannot file a ticket; without a configured desk the answer is a clear 503 and nothing is created", async () => {
  assert.equal((await ticketPost(req(valid()))).status, 401);
  const saved = process.env.INAYA_SUPPORT_ORG_ID; delete process.env.INAYA_SUPPORT_ORG_ID;
  const r = await ticketPost(req(valid(), memberToken)); assert.equal(r.status, 503); assert.equal((await r.json()).reasonCode, "NOT_CONFIGURED");
  process.env.INAYA_SUPPORT_ORG_ID = saved;
  const { supportTickets } = await getSupportCollections(); assert.equal(await supportTickets.countDocuments({ orgId: deskId }), 0);
});

test("a signed-in member's request becomes a ticket in Inaya's desk, from the VERIFIED email, with their organization as context and a copy to the support mailbox", async () => {
  emails.length = 0;
  const res = await ticketPost(req(valid({ orgId: String(memberOrgId), email: "someone.else@example.com", requester: { email: "boss@example.com" }, description: "Report fails. <script>alert(1)</script>" }), memberToken));
  assert.equal(res.status, 201); const out = await res.json();
  assert.match(out.ticketNumber, /-\d+$/); assert.equal(out.portalPath, `/portal/help${RUN}desk`); assert.equal(out.customerOrganization, `help-${RUN}-customer-co`);
  const { supportTickets } = await getSupportCollections();
  const t = await supportTickets.findOne({ orgId: deskId, number: out.ticketNumber });
  assert.ok(t, "the ticket exists in Inaya's support desk"); assert.equal(t.requester.email, memberEmail, "requester is the signed-in account, whatever the request body claims");
  assert.ok(t.tags.includes("inaya-app")); assert.ok(t.tags.some((x) => x.startsWith("org:help-")));
  assert.equal(await supportTickets.countDocuments({ orgId: memberOrgId }), 0, "nothing is created in the user's own organization");
  const mailbox = (m) => m.to === "support@inayanetwork.com" && m.subject.startsWith("[Support ");
  const mail = emails.find((m) => mailbox(m) && m.subject.includes(out.ticketNumber)); assert.ok(mail, "the support mailbox is notified");
  assert.equal(mail.to, "support@inayanetwork.com"); assert.equal(mail.reply_to, memberEmail, "replying from the mailbox reaches the requester");
  assert.ok(!mail.html.includes("<script>"), "the requester's text is escaped in the email"); assert.ok(mail.html.includes("&lt;script&gt;"));
});

test("organization context is honored only for an organization the user belongs to", async () => {
  const res = await ticketPost(req(valid({ orgId: String(memberOrgId) }), outsiderToken)); const out = await res.json();
  assert.equal(res.status, 201); assert.equal(out.customerOrganization, null, "a non-member cannot attach someone else's organization");
  const { supportTickets } = await getSupportCollections(); const t = await supportTickets.findOne({ orgId: deskId, number: out.ticketNumber });
  assert.ok(!t.tags.some((x) => x.startsWith("org:")));
});

test("a repeated submission (double click, retry) creates one ticket and one email", async () => {
  emails.length = 0; const key = `idem-${RUN}`;
  const a = await (await ticketPost(req(valid({ subject: "Double click test", idempotencyKey: key }), memberToken))).json();
  const bRes = await ticketPost(req(valid({ subject: "Double click test", idempotencyKey: key }), memberToken)); const b = await bRes.json();
  assert.equal(b.ticketNumber, a.ticketNumber); assert.equal(b.duplicate, true); assert.equal(bRes.status, 200);
  assert.equal(emails.filter((m) => m.to === "support@inayanetwork.com" && m.subject.includes(a.ticketNumber)).length, 1, "one copy to the support mailbox, not two");
});

test("validation and limits: short text is refused, oversized bodies are refused, the sixth request in an hour is rate limited", async () => {
  assert.equal((await ticketPost(req(valid({ subject: "x" }), outsiderToken))).status, 400);
  assert.equal((await ticketPost(req(valid({ description: "short" }), outsiderToken))).status, 400);
  assert.equal((await ticketPost(req("{not json", outsiderToken))).status, 400);
  assert.equal((await ticketPost(req(JSON.stringify(valid({ description: "x".repeat(40000) })), outsiderToken))).status, 413);
  const codes = []; for (let i = 0; i < 6; i++) codes.push((await ticketPost(req(valid({ subject: `Rate limit ${i}` }), outsiderToken))).status);
  assert.equal(codes.at(-1), 429, `rate limited: ${codes}`);
});
