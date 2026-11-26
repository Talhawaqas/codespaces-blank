// test/inaya-connect.test.mjs -- Inaya Connect SOW acceptance on the TEST database with a fake Meta transport, a
// scripted model and an in-memory document store: entitlement, manual connection + webhook verification, signature and
// tenant routing, de-duplication, delivery statuses, opt-out, staff linking, business assistant, customer hand-over,
// email-code verification, 24-hour rule, inbox actions, document intake/quarantine, tenant isolation, disconnect.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import * as C from "../src/lib/connect/core.js";
import * as N from "../src/lib/connect/connection.js";
import * as W from "../src/lib/connect/webhook.js";
import * as P from "../src/lib/connect/process.js";
import * as I from "../src/lib/connect/inbox.js";
import { __setGraphTransport } from "../src/lib/connect/graph.js";
import { __setModel } from "../src/lib/connect/assistant.js";
import { __setDocStore, __setBillClassifier } from "../src/lib/connect/intake.js";
const classified = []; __setBillClassifier(async ({ mime }) => { classified.push(mime); return false; });
import { runCustomerTool } from "../src/lib/connect/tools.js";

delete process.env.RESEND_API_KEY; // never send real email from tests
const orgId = new ObjectId(); const ORG = String(orgId); const orgB = new ObjectId(); const ORGB = String(orgB);
const PNID = `9${Date.now()}`; const SECRET = "a".repeat(32); const TOKEN = `EAA${"x".repeat(80)}`;
const owner = { role: "owner", email: "owner@ic.example" }; const staff = { role: "member", email: "staff@ic.example" }; const ownerB = { role: "owner", email: "owner@icb.example" };
const STAFF_PHONE = "923001112233"; const CUST_PHONE = "923004445566"; const STRANGER = "447700900123";
const sent = []; let nextId = 0; let c;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
const ok = (r, msg) => { assert.ok(!r?.error, `${msg || "call"} failed: ${r?.error}`); return r; };
const sign = (raw, s = SECRET) => `sha256=${createHmac("sha256", s).update(raw).digest("hex")}`;
const inbound = (from, extra) => { const id = `wamid.${++nextId}.${Date.now()}`; return { id, body: { object: "whatsapp_business_account", entry: [{ id: "waba", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: PNID }, contacts: [{ wa_id: from, profile: { name: "Tester" } }], messages: [{ id, from, timestamp: String(Math.floor(Date.now() / 1000)), ...extra }] } }] }] } }; };
async function deliver(from, extra, secret = SECRET) { const m = inbound(from, extra); const raw = JSON.stringify(m.body); const r = await W.receiveEvents({ headers: { "x-hub-signature-256": sign(raw, secret) }, rawBody: raw }); return { ...r, id: m.id, raw }; }
const say = async (from, text) => { const r = await deliver(from, { type: "text", text: { body: text } }); await P.processPending({ orgId: ORG }); return r; };
const lastTo = (n) => [...sent].reverse().find((s) => s.to === n)?.text;

before(async () => {
  await ensureOrgIndexes(); c = await getOrgCollections(); const now = new Date().toISOString();
  await c.orgs.insertOne({ _id: orgId, name: "IC Traders", plan: "business", features: { FEATURE_INAYA_CONNECT: true }, createdAt: now });
  await c.orgs.insertOne({ _id: orgB, name: "IC Other", plan: "business", features: { FEATURE_INAYA_CONNECT: true }, createdAt: now });
  await c.orgMembers.insertMany([{ ...owner, orgId, status: "active", createdAt: now }, { ...staff, orgId, status: "active", createdAt: now }, { ...ownerB, orgId: orgB, status: "active", createdAt: now }]);
  await c.departments.insertOne({ orgId, name: "Main", createdAt: now });
  const cust = (await c.crmContacts.insertOne({ orgId, name: "Sara", email: "sara@cust.example", phone: "+92 300 4445566", deletedAt: null, createdAt: now })).insertedId;
  await c.salesOrders.insertOne({ orgId, contactId: cust, orderNumber: "SO-IC-1", status: "CONFIRMED", total: 1200, currency: "PKR", deletedAt: null, createdAt: now });
  await c.salesOrders.insertOne({ orgId, contactId: new ObjectId(), orderNumber: "SO-IC-OTHER", status: "CONFIRMED", total: 99, currency: "PKR", deletedAt: null, createdAt: now });
  __setGraphTransport(async ({ url, method, body, raw }) => {
    if (raw) return { buffer: PNG, contentType: "image/png" };
    if (method === "GET" && /fields=display_phone_number/.test(url)) return { display_phone_number: "+92 300 0000000", verified_name: "IC Traders", quality_rating: "GREEN" };
    if (method === "GET" && /\/media-/.test(url)) return { url: "https://lookaside.example/media", mime_type: "image/png", file_size: PNG.length };
    if (method === "POST" && /subscribed_apps/.test(url)) return { success: true };
    if (method === "POST" && body?.status === "read") return { success: true };
    if (method === "POST" && body?.type === "text") { const id = `wamid.out.${++nextId}`; sent.push({ to: body.to, text: body.text.body, id }); return { messages: [{ id }] }; }
    throw new Error(`unexpected graph call ${method} ${url}`);
  });
  __setDocStore({ mem: new Map(), async put({ key, buffer }) { this.mem.set(key, buffer); return { versionId: null }; }, async get({ key }) { return this.mem.get(key) || null; } });
});
after(async () => {
  try { const { db } = c; for (const n of (await db.listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name)) { try { await db.collection(n).deleteMany({ orgId: { $in: [orgId, orgB] } }); } catch { /* ignore */ } } await c.orgs.deleteMany({ _id: { $in: [orgId, orgB] } }); } catch { /* best effort */ }
  await (await mongoClientPromise).close();
});

test("entitlement: explicit grant, plan gate, kill switch, admin-only connection", async () => {
  assert.equal(C.entitledFromOrg({ plan: "starter" }, { FEATURE_INAYA_CONNECT: "on" }), false);
  assert.equal(C.entitledFromOrg({ plan: "business" }, { FEATURE_INAYA_CONNECT: "on" }), true);
  assert.equal(C.entitledFromOrg({ plan: "business" }, {}), false, "hidden until released");
  assert.equal(C.entitledFromOrg({ plan: "business", features: { FEATURE_INAYA_CONNECT: true } }, { FEATURE_INAYA_CONNECT: "off" }), false, "kill switch");
  assert.equal(await C.connectEntitled(ORG), true);
  assert.ok((await N.connect({ orgId: ORG, membership: staff, actorEmail: staff.email, input: {} })).error, "members can't connect");
});

let verifyToken;
test("manual connection: validation, Meta probe, secrets encrypted, verify handshake, one company per number", async () => {
  assert.ok((await N.connect({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { phoneNumberId: PNID, wabaId: "3183828638", appSecret: "short", accessToken: TOKEN } })).error);
  const r = ok(await N.connect({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { phoneNumberId: PNID, wabaId: "3183828638", appSecret: SECRET, accessToken: TOKEN } }), "connect");
  verifyToken = r.webhook.verifyToken; assert.equal(r.connection.wabaSubscribed, true, "account linked to the app"); assert.match(verifyToken, /^icv_/); assert.equal(r.connection.status, "PENDING_WEBHOOK");
  const raw = await (await C.ccol()).findOne({ orgId, kind: C.K.conn });
  assert.ok(!JSON.stringify(raw).includes(SECRET) && !JSON.stringify(raw).includes(TOKEN), "secrets never stored in clear");
  assert.equal(JSON.stringify(await N.connectionStatus({ orgId: ORG, membership: owner })).includes("Encrypted"), false, "secrets never returned");
  const taken = await N.connect({ orgId: ORGB, membership: ownerB, actorEmail: ownerB.email, input: { phoneNumberId: PNID, wabaId: "3183828638", appSecret: SECRET, accessToken: TOKEN } });
  assert.equal(taken.code, "NUMBER_TAKEN");
  assert.equal((await W.verifyChallenge({ "hub.mode": "subscribe", "hub.verify_token": "icv_wrongwrongwrongwrongwrong", "hub.challenge": "123" })).status, 403);
  const early = await deliver(STRANGER, { type: "text", text: { body: "early" } }, "c".repeat(32));
  assert.equal(early.status, 401, "unsigned events never activate a pending number");
  const v = await W.verifyChallenge({ "hub.mode": "subscribe", "hub.verify_token": verifyToken, "hub.challenge": "chal42" });
  assert.equal(v.status, 200); assert.equal(v.text, "chal42");
  assert.equal((await N.connectionStatus({ orgId: ORG, membership: owner })).connection.status, "ACTIVE");
  ok(await N.rotateVerifyToken({ orgId: ORG, membership: owner, actorEmail: owner.email }));
  assert.equal((await N.connectionStatus({ orgId: ORG, membership: owner })).connection.status, "ACTIVE", "rotating the token doesn't pause a live number");
});

test("webhook: bad signature and unknown numbers rejected; duplicates stored once; statuses never go backwards", async () => {
  const bad = await deliver(STRANGER, { type: "text", text: { body: "hi" } }, "b".repeat(32));
  assert.equal(bad.status, 401); assert.equal(bad.body.rejected, 1);
  const unknown = { object: "whatsapp_business_account", entry: [{ changes: [{ value: { metadata: { phone_number_id: "111111" }, messages: [{ id: "wamid.x", from: STRANGER, type: "text", text: { body: "x" } }] } }] }] };
  const rawU = JSON.stringify(unknown); assert.equal((await W.receiveEvents({ headers: { "x-hub-signature-256": sign(rawU) }, rawBody: rawU })).status, 401);
  const d = await deliver(STRANGER, { type: "text", text: { body: "hello" } }); assert.equal(d.body.messages, 1); assert.deepEqual(d.orgIds, [ORG]);
  const again = await W.receiveEvents({ headers: { "x-hub-signature-256": sign(d.raw) }, rawBody: d.raw }); assert.equal(again.body.duplicates, 1);
  assert.equal(await (await C.ccol()).countDocuments({ orgId, kind: C.K.msg, waMessageId: d.id }), 1);
  await P.processPending({ orgId: ORG });
  const out = sent.at(-1); assert.ok(out, "greeting / hand-over reply sent");
  const st = (s) => { const b = { object: "whatsapp_business_account", entry: [{ changes: [{ value: { metadata: { phone_number_id: PNID }, statuses: [{ id: out.id, status: s, recipient_id: STRANGER, pricing: { billable: s === "sent", category: "service" } }] } }] }] }; const raw = JSON.stringify(b); return W.receiveEvents({ headers: { "x-hub-signature-256": sign(raw) }, rawBody: raw }); };
  await st("read"); await st("delivered");
  assert.equal((await (await C.ccol()).findOne({ orgId, kind: C.K.msg, waMessageId: out.id })).status, "read", "delivered after read doesn't regress");
});

test("customer assistant off: hand-over to a person, AI stays silent until resumed", async () => {
  const conv = await (await C.ccol()).findOne({ orgId, kind: C.K.conv, number: STRANGER });
  assert.equal(conv.mode, "HUMAN");
  const before = sent.length; await say(STRANGER, "anyone there?"); assert.equal(sent.length, before, "no AI reply in HUMAN mode");
});

test("opt-out: STOP suppresses replies, START restores them", async () => {
  await say(STRANGER, "STOP"); assert.match(lastTo(STRANGER), /won't get any more messages/);
  const conv = await (await C.ccol()).findOne({ orgId, kind: C.K.conv, number: STRANGER });
  const r = await I.reply({ orgId: ORG, membership: owner, actorEmail: owner.email, convId: String(conv._id), text: "hello?" }); assert.equal(r.code, "OPTED_OUT");
  await say(STRANGER, "START"); ok(await I.reply({ orgId: ORG, membership: owner, actorEmail: owner.email, convId: String(conv._id), text: "Hi, how can we help?" }), "reply after START");
});

test("staff linking + business assistant (read-only, scoped by membership)", async () => {
  const code = ok(await P.createLinkCode({ orgId: ORG, membership: staff, email: staff.email }));
  assert.equal(code.waLink, `https://wa.me/923000000000?text=LINK%20${code.code}`, "one-tap link opens WhatsApp on the company number");
  await say(STAFF_PHONE, "LINK 000000"); assert.match(lastTo(STAFF_PHONE), /isn't valid/);
  await say(STAFF_PHONE, `LINK ${code.code}`); assert.match(lastTo(STAFF_PHONE), /Linked/);
  await (await C.ccol()).updateOne({ orgId, kind: C.K.conv, number: STAFF_PHONE }, { $set: { mode: "HUMAN" } }); // an earlier customer hand-over must not silence staff
  let seen = null; __setModel(async (p) => { seen = p; return { text: "Today: 3 sales, PKR 4,500 net (Asia/Karachi).", functionCalls: [] }; });
  await say(STAFF_PHONE, "how much did we sell today?");
  assert.match(lastTo(STAFF_PHONE), /3 sales/);
  const names = seen.config.tools[0].functionDeclarations.map((t) => t.name);
  assert.ok(names.includes("sales_summary") && !names.some((n) => /^propose_/.test(n)), "read-only toolset");
  assert.match(JSON.stringify(seen.contents.at(-1)), /untrusted_whatsapp_message/);
  assert.equal((await P.listLinks({ orgId: ORG })).length, 1);
});

test("customer assistant: FAQ without verification, email code before personal records, own records only", async () => {
  ok(await C.saveSettings({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { customerAssistant: true } }));
  __setModel(async (p) => (/order/i.test(JSON.stringify(p.contents.at(-1))) && !/VERIFIED:/.test(p.config.systemInstruction) ? { text: "VERIFY_NEEDED", functionCalls: [] } : { text: "We're open 9 to 6.", functionCalls: [] }));
  await say(CUST_PHONE, "what are your hours?"); assert.match(lastTo(CUST_PHONE), /open 9 to 6/);
  await say(CUST_PHONE, "where is my order?"); assert.match(lastTo(CUST_PHONE), /6-digit code to s•••@cust\.example/);
  await say(CUST_PHONE, "111111"); assert.match(lastTo(CUST_PHONE), /isn't right/);
  const cc = await C.ccol(); const otp = await cc.findOne({ orgId, kind: C.K.otp, number: CUST_PHONE }); assert.equal(otp.attempts, 1);
  await cc.updateOne({ _id: otp._id }, { $set: { codeHash: createHash("sha256").update(`${ORG}:${CUST_PHONE}:424242`).digest("hex") } });
  await say(CUST_PHONE, "424242"); assert.match(lastTo(CUST_PHONE), /verified/);
  const conv = await cc.findOne({ orgId, kind: C.K.conv, number: CUST_PHONE }); assert.ok(conv.verifiedContactId);
  assert.equal((await runCustomerTool("my_orders", {}, { orgId: ORG, contactId: null })).needVerification, true);
  const mine = await runCustomerTool("my_orders", {}, { orgId: ORG, contactId: String(conv.verifiedContactId) });
  assert.deepEqual(mine.orders.map((o) => o.number), ["SO-IC-1"], "only the verified customer's own orders");
  __setModel(async () => ({ text: "", functionCalls: [{ name: "talk_to_a_person", args: { reason: "complaint" } }], candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "talk_to_a_person", args: { reason: "complaint" } } }] } }] }));
  await say(CUST_PHONE, "I want to complain"); assert.equal((await cc.findOne({ _id: conv._id })).mode, "HUMAN");
});

test("inbox: take over, note, assign, resume, ticket, 24-hour rule, tenant isolation", async () => {
  const cc = await C.ccol(); const conv = await cc.findOne({ orgId, kind: C.K.conv, number: CUST_PHONE }); const id = String(conv._id);
  const list = ok(await I.listConversations({ orgId: ORG, membership: owner })); assert.ok(list.conversations.some((x) => x.id === id));
  ok(await I.setMode({ orgId: ORG, membership: owner, actorEmail: owner.email, convId: id, action: "note", note: "VIP" }));
  ok(await I.setMode({ orgId: ORG, membership: owner, actorEmail: owner.email, convId: id, action: "assign", assignee: staff.email }));
  assert.ok((await I.setMode({ orgId: ORG, membership: owner, actorEmail: owner.email, convId: id, action: "assign", assignee: "nobody@x.example" })).error);
  const t = ok(await I.setMode({ orgId: ORG, membership: owner, actorEmail: owner.email, convId: id, action: "ticket" }), "ticket"); assert.ok(t.ticketId);
  const g = ok(await I.getConversation({ orgId: ORG, membership: owner, convId: id })); assert.ok(g.messages.some((m) => m.note));
  assert.equal(sent.some((s) => s.text === "VIP"), false, "notes are never sent");
  ok(await I.setMode({ orgId: ORG, membership: owner, actorEmail: owner.email, convId: id, action: "resume_ai" }));
  assert.ok((await I.getConversation({ orgId: ORG, membership: staff, convId: id })).error, "members without a support role can't read the inbox");
  assert.ok((await I.getConversation({ orgId: ORGB, membership: ownerB, convId: id })).error, "another company can't read it");
  await cc.updateMany({ orgId, kind: C.K.msg, direction: "in", from: CUST_PHONE }, { $set: { at: new Date(Date.now() - 25 * 3600000).toISOString() } });
  assert.equal((await I.reply({ orgId: ORG, membership: owner, actorEmail: owner.email, convId: id, text: "late" })).code, "OUTSIDE_WINDOW");
});

test("documents: unknown sender quarantined; staff file stored for review, de-duplicated, routed by a person", async () => {
  await deliver(STRANGER, { type: "image", image: { id: "media-1", mime_type: "image/png" } }); await P.processPending({ orgId: ORG });
  const cc = await C.ccol(); assert.equal((await cc.findOne({ orgId, kind: C.K.doc, from: STRANGER })).status, "QUARANTINED");
  await deliver(STAFF_PHONE, { type: "image", image: { id: "media-2", mime_type: "image/png", caption: "site photo" } }); await P.processPending({ orgId: ORG });
  const doc = await cc.findOne({ orgId, kind: C.K.doc, from: STAFF_PHONE }); assert.equal(doc.status, "SAVED"); assert.match(doc.storage.key, /^Inaya Connect\/\d{4}-\d\d\/D-/); assert.match(lastTo(STAFF_PHONE), /saved in Inaya \(reference D-.*emailed you/);
  const own = ok(await I.listDocuments({ orgId: ORG, membership: staff })); assert.ok(own.documents.length >= 1 && own.documents.every((x) => x.senderEmail === staff.email), "staff see only their own files");
  ok(await I.documentFile({ orgId: ORG, membership: staff, docId: String(doc._id) }), "the sender can open their file");
  const q = await cc.findOne({ orgId, kind: C.K.doc, from: STRANGER }); assert.ok((await I.documentFile({ orgId: ORG, membership: owner, docId: String(q._id) })).error, "quarantined files never open");
  await deliver(STAFF_PHONE, { type: "image", image: { id: "media-3", mime_type: "image/png" } }); await P.processPending({ orgId: ORG });
  assert.ok(classified.length >= 1, "photos without a bill caption are checked by content");
  assert.match(lastTo(STAFF_PHONE), /already have this document/);
  const f = ok(await I.documentFile({ orgId: ORG, membership: owner, docId: String(doc._id) })); assert.equal(f.buffer.length, PNG.length);
  assert.ok((await I.decideDocument({ orgId: ORG, membership: owner, actorEmail: owner.email, docId: String(doc._id), action: "filed" })).error, "filing needs a note");
  ok(await I.decideDocument({ orgId: ORG, membership: owner, actorEmail: owner.email, docId: String(doc._id), action: "filed", note: "Projects › Site A" }));
  assert.ok((await I.decideDocument({ orgId: ORG, membership: owner, actorEmail: owner.email, docId: String(doc._id), action: "reject" })).error, "decided once");
});

test("usage, activity and disconnect (secrets wiped, events rejected afterwards)", async () => {
  const u = ok(await I.usage({ orgId: ORG, membership: owner })); assert.ok(u.inbound > 5 && u.outbound > 3); assert.match(u.estimate.note, /Estimate only/);
  const ev = ok(await I.events({ orgId: ORG, membership: owner })); assert.ok(ev.events.some((e) => e.type === "webhook_event" && e.outcome === "rejected_signature"));
  assert.ok(!JSON.stringify(ev).includes(CUST_PHONE), "activity masks numbers");
  ok(await N.disconnect({ orgId: ORG, membership: owner, actorEmail: owner.email, reason: "test" }));
  const raw = await (await C.ccol()).findOne({ orgId, kind: C.K.conn }); assert.ok(!raw.appSecretEncrypted && !raw.accessTokenEncrypted && !raw.waKey);
  assert.equal((await deliver(CUST_PHONE, { type: "text", text: { body: "hi" } })).status, 401);
  ok(await N.connect({ orgId: ORGB, membership: ownerB, actorEmail: ownerB.email, input: { phoneNumberId: PNID, wabaId: "3183828638", appSecret: SECRET, accessToken: TOKEN } }), "freed number can move to another company");
});

test("sales question without Point of Sale: answered from invoices issued, finance roles only", async () => {
  const { runOpsTool } = await import("../src/lib/connect/tools.js");
  const now = new Date();
  await c.invoices.insertMany([
    { orgId, invoiceNumber: "IC-1", total: 1000, currency: "PKR", status: "SENT", issueDate: now.toISOString(), deletedAt: null, createdAt: now.toISOString() },
    { orgId, invoiceNumber: "IC-2", total: 500, currency: "PKR", status: "PAID", issueDate: now, deletedAt: null, createdAt: now.toISOString() },
    { orgId, invoiceNumber: "IC-3", total: 999, currency: "PKR", status: "DRAFT", issueDate: now.toISOString(), deletedAt: null, createdAt: now.toISOString() },
  ]);
  const r = await runOpsTool("sales_summary", { period: "today" }, { orgId: ORG, membership: owner });
  assert.equal(r.source, "invoices"); assert.equal(r.invoicesIssued, 2); assert.deepEqual(r.byCurrency.PKR, { invoices: 2, total: 1500, paid: 500, unpaid: 1000 });
  assert.ok((await runOpsTool("sales_summary", { period: "today" }, { orgId: ORG, membership: staff })).error, "plain members don't get sales figures");
});

test("a bill from linked staff reaches AI Bookkeeper as a draft (caption or content)", async () => {
  // reconnect (the disconnect test freed the number; another company holds it now) on a fresh number for this check
  const PN2 = `8${Date.now()}`; const cc = await C.ccol();
  await cc.deleteMany({ orgId, kind: C.K.conn });
  ok(await N.connect({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { phoneNumberId: PN2, wabaId: "3183828638", appSecret: SECRET, accessToken: TOKEN } }), "reconnect");
  await cc.updateOne({ orgId, kind: C.K.conn, status: { $ne: "DISCONNECTED" } }, { $set: { status: "ACTIVE" } });
  const bill = Buffer.concat([PNG, Buffer.from(`bill ${Date.now()}`)]);
  __setGraphTransport(async ({ url, method, body, raw }) => {
    if (raw) return { buffer: bill, contentType: "image/png" };
    if (method === "GET" && /\/media-/.test(url)) return { url: "https://lookaside.example/media", mime_type: "image/png", file_size: bill.length };
    if (method === "POST" && body?.type === "text") { const id = `wamid.out.${++nextId}`; sent.push({ to: body.to, text: body.text.body, id }); return { messages: [{ id }] }; }
    return { success: true };
  });
  __setBillClassifier(async () => true); // no caption: recognised from the image
  const m = { id: `wamid.bk.${Date.now()}`, from: STAFF_PHONE, type: "image", image: { id: "media-bk", mime_type: "image/png" } };
  const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ value: { metadata: { phone_number_id: PN2 }, messages: [m] } }] }] });
  assert.equal((await W.receiveEvents({ headers: { "x-hub-signature-256": sign(raw) }, rawBody: raw })).status, 200);
  await P.processPending({ orgId: ORG });
  const doc = await cc.findOne({ orgId, kind: C.K.doc, waMessageId: m.id });
  assert.equal(doc.status, "ROUTED", `routed to Bookkeeper (got ${doc.status}, billCheck ${doc.billCheck})`); assert.ok(doc.bookkeeperDocumentId, "Bookkeeper document id recorded");
  assert.match(lastTo(STAFF_PHONE), /accounts team will review/);
});
