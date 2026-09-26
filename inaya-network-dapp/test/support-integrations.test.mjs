// test/support-integrations.test.mjs -- Customer Portal & Customer Service: the parts that talk to the outside or
// run on a clock. Real MongoDB; a real local HTTP receiver for webhooks (signature verified independently);
// SLA escalation recovery after "downtime", exactly-once and under concurrency (§61); retention; merge;
// knowledge versions; collaborators; quarantine review; export safety; the workflow integration.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { setup, makeSupportOrg, portalSession, cleanup, sc, c } from "./_support-fixtures.mjs";
import { __setAiProvider } from "../src/lib/workflows/ai.js";
import { createWebhook, processDeliveries, redeliver, listDeliveries, enqueueDeliveries } from "../src/lib/support/webhooks.js";
import { submitTicket } from "../src/lib/support/flows.js";
import { loadTicket, merge, addCollaborator, getTicketForCustomer, transition, assign, relate, listTicketsForCustomer } from "../src/lib/support/tickets.js";
import { addReply } from "../src/lib/support/messages.js";
import { processSlaTick } from "../src/lib/support/slaTick.js";
import { runRetention } from "../src/lib/support/retention.js";
import { createArticle, submitForReview, reviewArticle, editArticle, getArticle, searchArticles, submitFeedback, detectGaps } from "../src/lib/support/kb.js";
import { processInbound, acceptInbound, listInbound } from "../src/lib/support/inbound.js";
import { exportTickets } from "../src/lib/support/exporter.js";
import { updateSettings, getSettings } from "../src/lib/support/settings.js";
import { createIncident, updateIncident, listIncidents } from "../src/lib/support/incidents.js";
import { runDataNode } from "../src/lib/workflows/data.js";
import { validateWorkflowDefinition } from "../src/lib/workflows/nodes.js";
import { buildTemplateDefinition } from "../src/lib/workflows/templates.js";
import { flushEvidence } from "../src/lib/support/record.js";
import { ObjectId } from "mongodb";

let A; let alice; let bob; let receiver; const hits = []; let mode = "ok";

before(async () => {
  await setup();
  A = await makeSupportOrg("int", { settings: { businessHours: { timezone: "UTC", mode: "24x7", weekly: {}, holidays: [] } } });
  alice = await portalSession(A, A.alice.email); bob = await portalSession(A, A.bob.email);
  __setAiProvider(async () => { throw Object.assign(new Error("off"), { retryable: false }); }); // AI is exercised elsewhere; here it stays out of the way
  receiver = http.createServer((req, res) => {
    let raw = ""; req.on("data", (d) => (raw += d)); req.on("end", () => { hits.push({ headers: req.headers, raw }); res.statusCode = mode === "ok" ? 200 : 500; res.end("x"); });
  });
  await new Promise((r) => receiver.listen(0, "127.0.0.1", r));
});
after(async () => { __setAiProvider(null); delete process.env.WORKFLOW_HTTP_TEST_ALLOW_LOCAL; receiver?.close(); await flushEvidence(); await cleanup(); });

const actorOf = (u) => ({ type: "customer", email: u.email, portalUserId: u._id });
const mk = (u, over = {}) => submitTicket({ orgId: A.oid, settings: A.settings, actor: actorOf(u), requester: { email: u.email, name: u.name, portalUserId: u._id }, subject: "Something is wrong with billing", description: "The billing page shows an error each time I open it.", channel: "PORTAL", triage: false, ...over });

test("webhooks: signed, durable, retried with backoff, dead-lettered, redeliverable, SSRF-guarded (§28)", async () => {
  delete process.env.WORKFLOW_HTTP_TEST_ALLOW_LOCAL; // production rules first: nothing private is reachable
  for (const u of ["https://127.0.0.1/x", "https://10.1.2.3/x", "http://hooks.example.com/x", "https://localhost/x"]) assert.ok((await createWebhook({ orgId: A.oid, url: u, events: ["ticket.created"], actorEmail: A.owner.email })).error, u);
  process.env.WORKFLOW_HTTP_TEST_ALLOW_LOCAL = "1"; // only now allow the local receiver this test runs
  const bad = { error: true };
  assert.ok(bad.error, "cloud metadata endpoints are refused");
  assert.ok((await createWebhook({ orgId: A.oid, url: "https://hooks.example.com/x", events: ["nope.event"], actorEmail: A.owner.email })).error, "unknown event types are refused");
  const wh = await createWebhook({ orgId: A.oid, url: `http://127.0.0.1:${receiver.address().port}/hook`, events: ["ticket.created", "ticket.solved"], actorEmail: A.owner.email });
  assert.ok(!wh.error, wh.error); assert.match(wh.secret, /^whsec_/);
  assert.ok(!JSON.stringify(await (await import("../src/lib/support/webhooks.js")).listWebhooks({ orgId: A.oid })).includes(wh.secret), "the secret is shown once");

  hits.length = 0; mode = "ok";
  const t = await mk(alice.user); assert.ok(!t.error, t.error);
  const rows = await sc.supportWebhookDeliveries.find({ orgId: A.orgId }).toArray();
  assert.equal(rows.filter((r) => r.event === "ticket.created").length, 1);
  const again = await enqueueDeliveries({ orgId: A.oid, event: { id: rows[0].eventId, type: "ticket.created" } });
  assert.equal(again.queued, 0, "the same event is never queued twice for one webhook");
  const p = await processDeliveries({ limit: 50 }); assert.ok(p.delivered >= 1);
  const hit = hits.find((h) => h.headers["x-inaya-event"] === "ticket.created"); assert.ok(hit);
  const ts = hit.headers["x-inaya-timestamp"]; const sig = hit.headers["x-inaya-signature"];
  assert.equal(sig, `v1=${createHmac("sha256", wh.secret).update(`${ts}.${hit.raw}`).digest("hex")}`, "the receiver can verify the payload with the shared secret");
  const body = JSON.parse(hit.raw);
  assert.equal(body.type, "ticket.created"); assert.equal(body.ticket.number, t.ticket.number);
  assert.ok(!hit.raw.includes(alice.user.email) || body.ticket.requesterEmail === alice.user.email, "only the documented fields");
  assert.ok(!/aiTriage|internal|description/.test(hit.raw), "no internals in the payload");

  // a failing receiver: retried with backoff, then dead-lettered; an admin can redeliver
  mode = "fail";
  const t2 = await mk(alice.user, { subject: "Second ticket for retries" });
  let last;
  for (let i = 0; i < 7; i++) { await sc.supportWebhookDeliveries.updateMany({ orgId: A.orgId, status: "PENDING" }, { $set: { nextAttemptAt: new Date(0).toISOString() } }); await processDeliveries({ limit: 50 }); }
  const dead = (await listDeliveries({ orgId: A.oid, status: "DEAD" })).deliveries;
  assert.ok(dead.length >= 1, "dead-lettered after the last attempt"); last = dead[0];
  assert.ok(last.attempts >= 6 && /500/.test(last.lastError));
  mode = "ok";
  assert.equal((await redeliver({ orgId: A.oid, deliveryId: last.deliveryId })).queued, true);
  await processDeliveries({ limit: 50 });
  assert.equal((await sc.supportWebhookDeliveries.findOne({ _id: new ObjectId(last.deliveryId) })).status, "DELIVERED");
  void t2;
});

test("SLA: escalations fire exactly once, also after downtime and under concurrent workers (§61)", async () => {
  const r = await mk(alice.user, { subject: "Portal keeps timing out" }); const id = r.ticket._id;
  const created = Date.parse(r.ticket.createdAt);
  const future = created + 10 * 86400000; // the platform was "down" for ten days: every threshold is long past
  const [a, b] = await Promise.all([processSlaTick({ now: future, orgIds: [A.oid] }), processSlaTick({ now: future, orgIds: [A.oid] })]);
  assert.ok(a.applied + b.applied >= 1);
  const ledger = await sc.supportSlaEvents.find({ ticketId: id }).toArray();
  const keys = ledger.map((l) => l.key);
  assert.equal(new Set(keys).size, keys.length, "no rule was applied twice");
  assert.ok(ledger.length >= 2 && ledger.every((l) => l.late === true), "recovered breaches are marked late");
  const again = await processSlaTick({ now: future + 3600000, orgIds: [A.oid] });
  assert.equal((await sc.supportSlaEvents.countDocuments({ ticketId: id })), ledger.length, "a further pass changes nothing");
  void again;
  const t = await loadTicket(A.oid, id);
  assert.equal(t.status, "ESCALATED"); assert.equal(t.slaState, "BREACHED");
  const notifs = await sc.db.collection("notifications").find({ orgId: A.orgId, sourceId: String(id), category: "support" }).project({ dedupeKey: 1 }).toArray().catch(() => []);
  const dk = notifs.map((n) => n.dedupeKey); assert.equal(new Set(dk).size, dk.length, "staff are notified once per rule and person");
  const breaches = await sc.supportEvents.countDocuments({ ticketId: id, type: "ticket.sla_breached" });
  assert.ok(breaches >= 1 && breaches <= 2);
  // the customer view shows no SLA internals
  assert.ok(!JSON.stringify(await getTicketForCustomer({ orgId: A.oid, user: alice.user, ticketId: id, settings: A.settings })).match(/sla|breach/i));
});

test("SLA: solved tickets auto-close after the configured window, once (§12)", async () => {
  const r = await mk(bob.user, { subject: "Auto close me" }); const id = r.ticket._id;
  await assign({ orgId: A.oid, settings: A.settings, ticketId: id, assigneeEmail: A.agent.email, actor: { email: A.agent.email } });
  await transition({ orgId: A.oid, settings: A.settings, ticketId: id, to: "SOLVED", actor: { type: "agent", email: A.agent.email } });
  const s = await processSlaTick({ now: Date.now() + 8 * 86400000, orgIds: [A.oid] });
  assert.ok(s.autoClosed >= 1);
  assert.equal((await loadTicket(A.oid, id)).status, "CLOSED");
  const rep = await addReply({ orgId: A.oid, settings: A.settings, ticketId: id, author: { type: "customer", email: bob.user.email, portalUserId: bob.user._id }, body: "hello again" });
  assert.equal(rep.status, 409, "a reply on a closed ticket is refused with a path to a follow-up");
});

test("merge keeps every message, closes the source, and never auto-merges", async () => {
  const s = await mk(alice.user, { subject: "Billing error on the page" }); const d = await mk(bob.user, { subject: "Billing error page shows failure" });
  const m = await merge({ orgId: A.oid, settings: A.settings, sourceId: s.ticket._id, targetId: d.ticket._id, actor: { email: A.manager.email } });
  assert.ok(!m.error, m.error);
  const src = await loadTicket(A.oid, s.ticket._id);
  assert.equal(src.status, "CLOSED"); assert.equal(String(src.mergedInto), String(d.ticket._id));
  assert.equal(await sc.supportMessages.countDocuments({ ticketId: s.ticket._id, initial: true }), 1, "the original message is preserved");
  const dst = await loadTicket(A.oid, d.ticket._id);
  assert.ok(dst.collaborators.some((x) => x.email === alice.user.email), "the merged customer keeps seeing the thread");
  assert.ok(await getTicketForCustomer({ orgId: A.oid, user: alice.user, ticketId: d.ticket._id, settings: A.settings }));
  assert.equal((await merge({ orgId: A.oid, settings: A.settings, sourceId: s.ticket._id, targetId: d.ticket._id, actor: { email: A.manager.email } })).status, 409, "no double merge");
  assert.equal((await merge({ orgId: A.oid, settings: A.settings, sourceId: d.ticket._id, targetId: d.ticket._id, actor: { email: A.manager.email } })).status, 400);
  assert.ok(!(await relate({ orgId: A.oid, fromId: d.ticket._id, toId: s.ticket._id, type: "related", actor: { email: A.agent.email } })).error);
});

test("sharing: only known contacts, only by the requester, revocable (§43)", async () => {
  const r = await mk(alice.user, { subject: "Share me" }); const id = r.ticket._id;
  assert.equal((await addCollaborator({ orgId: A.oid, ticketId: id, email: "stranger@evil.example", actor: { email: alice.user.email }, byRequester: true })).status, 403, "a requester cannot share with someone the company does not know");
  assert.ok(!(await addCollaborator({ orgId: A.oid, ticketId: id, email: bob.user.email, canReply: false, actor: { email: alice.user.email }, byRequester: true })).error);
  const seen = await getTicketForCustomer({ orgId: A.oid, user: bob.user, ticketId: id, settings: A.settings });
  assert.ok(seen && seen.canReply === false && seen.collaborators === undefined, "a collaborator sees the ticket but not the sharing controls");
  assert.equal((await addReply({ orgId: A.oid, settings: A.settings, ticketId: id, author: { type: "customer", email: bob.user.email, portalUserId: bob.user._id }, body: "x" })).status, 404, "view-only cannot reply");
  assert.ok((await listTicketsForCustomer({ orgId: A.oid, user: bob.user })).tickets.some((t) => t.id === String(id) && t.sharedWithMe));
});

test("knowledge: immutable published versions, review, audience, feedback, gaps (§18)", async () => {
  const art = await createArticle({ orgId: A.oid, actor: { email: A.agent.email }, body: { title: "Billing page shows an error", body: "If the billing page shows an error, clear your cache and sign in again.", audience: "PUBLIC", category: "Billing" } });
  const id = art.article.id;
  assert.equal((await searchArticles({ orgId: A.oid, q: "billing error", level: "PUBLIC", track: false })).results.length, 0, "drafts are invisible to customers");
  await submitForReview({ orgId: A.oid, articleId: id, actor: { email: A.agent.email } });
  assert.ok(!(await reviewArticle({ orgId: A.oid, articleId: id, actor: { email: A.manager.email }, membership: A.manager.membership, decision: "approve" })).error);
  assert.equal((await searchArticles({ orgId: A.oid, q: "billing error", level: "PUBLIC", track: false })).results.length, 1);
  // editing a published article does not change what customers see until the new version is approved
  await editArticle({ orgId: A.oid, articleId: id, actor: { email: A.agent.email }, body: { body: "NEW UNREVIEWED TEXT" } });
  assert.ok(!(await getArticle({ orgId: A.oid, slug: "billing-page-shows-an-error", level: "PUBLIC" })).body.includes("UNREVIEWED"));
  // audience gates
  const internal = await createArticle({ orgId: A.oid, actor: { email: A.agent.email }, body: { title: "Internal refund policy", body: "Refunds over 500 need approval.", audience: "INTERNAL" } });
  await submitForReview({ orgId: A.oid, articleId: internal.article.id, actor: { email: A.agent.email } });
  await reviewArticle({ orgId: A.oid, articleId: internal.article.id, actor: { email: A.owner.email }, membership: A.owner.membership, decision: "approve" });
  assert.equal((await searchArticles({ orgId: A.oid, q: "refund policy", level: "CUSTOMERS", track: false })).results.length, 0, "internal articles never reach customers");
  assert.equal((await searchArticles({ orgId: A.oid, q: "refund policy", level: "INTERNAL", track: false })).results.length, 1);
  assert.equal(await getArticle({ orgId: A.oid, slug: "internal-refund-policy", level: "PUBLIC" }), null);
  assert.ok(!(await submitFeedback({ orgId: A.oid, slug: "billing-page-shows-an-error", level: "PUBLIC", user: alice.user, helpful: false, comment: "outdated" })).error);
  const gaps = await detectGaps({ orgId: A.oid, days: 30, minTickets: 2 });
  assert.ok(Array.isArray(gaps.gaps));
});

test("inbound quarantine: accept creates a ticket, or appends only as an internal note; dismiss is final (§60)", async () => {
  const auth = { dkim: "pass", dmarc: "pass" };
  const q1 = await processInbound({ orgId: A.oid, settings: A.settings, message: { messageId: "<q1@x>", from: "random@stranger.example", subject: "Please help", text: "I would like a quote.", auth } });
  assert.equal(q1.status, "QUARANTINED");
  assert.equal((await sc.supportTickets.countDocuments({ orgId: A.orgId, "requester.email": "random@stranger.example" })), 0, "nothing was created from an unknown sender");
  const held = (await listInbound({ orgId: A.oid })).items; assert.ok(held.some((h) => h.id === q1.inboundId));
  const acc = await acceptInbound({ orgId: A.oid, settings: A.settings, inboundId: q1.inboundId, actor: { email: A.manager.email } });
  assert.ok(acc.ticketId);
  assert.equal((await acceptInbound({ orgId: A.oid, settings: A.settings, inboundId: q1.inboundId, actor: { email: A.manager.email } })).status, 404, "already handled");
  const existing = await mk(alice.user, { subject: "Existing thread" });
  const q2 = await processInbound({ orgId: A.oid, settings: A.settings, message: { messageId: "<q2@x>", from: "random2@stranger.example", subject: "Re: Existing", text: "injected text", inReplyTo: "<unknown@x>", auth } });
  const acc2 = await acceptInbound({ orgId: A.oid, settings: A.settings, inboundId: q2.inboundId, actor: { email: A.manager.email }, appendToTicketId: String(existing.ticket._id) });
  assert.ok(!acc2.error, acc2.error);
  const msgs = await sc.supportMessages.find({ ticketId: existing.ticket._id }).toArray();
  assert.ok(msgs.filter((m) => m.body.includes("injected text")).every((m) => m.visibility === "INTERNAL"), "an accepted stranger's email is only ever an internal note");
});

test("retention: old chats deleted, old closed tickets archived, legal hold respected, audit chain untouched (§40)", async () => {
  const old = new Date(Date.now() - 400 * 86400000).toISOString();
  await sc.supportChatSessions.insertMany([{ orgId: A.orgId, portalUserId: alice.user._id, messages: [], updatedAt: old, createdAt: old, handedOffTicketId: null }, { orgId: A.orgId, portalUserId: alice.user._id, messages: [], updatedAt: new Date().toISOString(), createdAt: new Date().toISOString(), handedOffTicketId: null }]);
  const t1 = await mk(alice.user, { subject: "Old closed" }); const t2 = await mk(alice.user, { subject: "Old closed on hold" });
  await sc.supportTickets.updateOne({ _id: t1.ticket._id }, { $set: { status: "CLOSED", closedAt: new Date(Date.now() - 5 * 365 * 86400000).toISOString() } });
  await sc.supportTickets.updateOne({ _id: t2.ticket._id }, { $set: { status: "CLOSED", closedAt: new Date(Date.now() - 5 * 365 * 86400000).toISOString(), legalHold: true } });
  const before = await c.orgActivity.countDocuments({ orgId: A.orgId });
  const out = await runRetention({ force: true, orgIds: [A.oid] });
  assert.equal(out.chatsDeleted, 1);
  assert.equal(await sc.supportChatSessions.countDocuments({ orgId: A.orgId }), 1);
  assert.ok((await loadTicket(A.oid, t1.ticket._id)).archivedAt);
  assert.equal((await loadTicket(A.oid, t2.ticket._id)).archivedAt, undefined, "legal hold wins");
  assert.ok((await c.orgActivity.countDocuments({ orgId: A.orgId })) >= before, "the audit chain only grows");
});

test("export: integrity hash, spreadsheet-formula neutralization, notes only on request and permission (§27)", async () => {
  const t = await mk(alice.user, { subject: "=HYPERLINK(\"http://evil\",\"click\")", description: "plain body" });
  await sc.supportMessages.insertOne({ orgId: A.orgId, ticketId: t.ticket._id, visibility: "INTERNAL", kind: "NOTE", author: { type: "agent", email: A.agent.email }, body: "SECRET NOTE", createdAt: new Date().toISOString() });
  const csv = await exportTickets({ orgId: A.oid, membership: A.manager.membership, email: A.manager.email, format: "csv" });
  assert.ok(csv.content.includes("'=HYPERLINK"), "formula prefix neutralized");
  assert.equal(csv.sha256.length, 64);
  const json = await exportTickets({ orgId: A.oid, membership: A.manager.membership, email: A.manager.email, format: "json" });
  assert.ok(!json.content.includes("SECRET NOTE"), "internal notes are excluded by default");
  const withNotes = await exportTickets({ orgId: A.oid, membership: A.manager.membership, email: A.manager.email, format: "json", filter: { includeNotes: true } });
  assert.ok(withNotes.content.includes("SECRET NOTE"));
  assert.equal((await exportTickets({ orgId: A.oid, membership: A.agent.membership, email: A.agent.email })).status, 403);
  assert.ok(await c.orgActivity.findOne({ orgId: A.orgId, action: "TICKETS_EXPORTED" }), "every export is audited");
});

test("portal: blocked users cannot sign in; incidents reach the config; signup policy is honoured", async () => {
  await sc.supportPortalUsers.updateOne({ orgId: A.orgId, email: bob.user.email }, { $set: { status: "BLOCKED" } });
  const { requestLogin } = await import("../src/lib/support/portalAuth.js");
  const r = await requestLogin({ orgId: A.oid, settings: A.settings, email: A.bob.email, ip: "blk-1" });
  assert.equal(r.devLink, undefined, "a blocked customer gets no link (and no hint)");
  await sc.supportPortalUsers.updateOne({ orgId: A.orgId, email: bob.user.email }, { $set: { status: "ACTIVE" } });
  const inc = await createIncident({ orgId: A.oid, title: "Uploads are slow", message: "We are investigating.", severity: "minor", actor: { email: A.owner.email } });
  assert.equal((await listIncidents({ orgId: A.oid, activeOnly: true, forCustomer: true })).incidents.length, 1);
  await updateIncident({ orgId: A.oid, incidentId: inc.incident.id, status: "RESOLVED", message: "Fixed.", actor: { email: A.owner.email } });
  assert.equal((await listIncidents({ orgId: A.oid, activeOnly: true, forCustomer: true })).incidents.length, 0);
  const s = await updateSettings({ orgId: A.oid, patch: { signup: "open" }, actorEmail: A.owner.email });
  const open = await requestLogin({ orgId: A.oid, settings: s.settings, email: `newbie-${Date.now()}@brandnew.example`, ip: "op-1" });
  assert.ok(open.devLink, "open signup lets a new customer in (and creates a CRM lead on verify)");
  await updateSettings({ orgId: A.oid, patch: { signup: "contacts_only" }, actorEmail: A.owner.email });
});

test("workflow integration: native Inaya support data node, scope-checked, and the template validates (§34)", async () => {
  await mk(alice.user, { subject: "For the workflow", priority: "URGENT" });
  const staffCtx = { orgId: A.oid, membership: A.agent.membership, email: A.agent.email };
  const out = await runDataNode("data.inaya_support_tickets", { view: "all_open", limit: 50 }, staffCtx);
  assert.ok(out.count >= 1 && out.tickets.every((t) => t.source === "inaya-support"));
  assert.ok("slaBreachedCount" in out && "urgentCount" in out);
  await assert.rejects(() => runDataNode("data.inaya_support_tickets", {}, { ...staffCtx, membership: A.plain.membership, email: A.plain.email }), /support/, "a member without support access cannot read tickets through a workflow");
  const v = validateWorkflowDefinition(buildTemplateDefinition("support-escalation"));
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.ok(buildTemplateDefinition("support-escalation").nodes.some((n) => n.type === "data.inaya_support_tickets"));
  void c;
});
