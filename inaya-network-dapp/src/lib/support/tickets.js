// src/lib/support/tickets.js
//
// SOW §7, §8, §12-§14, §23, §43, §48, §52: the ticket engine. Every change to a ticket goes through
// mutate(): an optimistic-concurrency update (`version`), so two agents (or an agent and a customer reply
// arriving together) can never silently overwrite each other; a lost race re-reads and re-applies once or
// twice, then reports a conflict. Status changes are validated against the lifecycle, drive the SLA clock,
// and are written to the audit chain. Customers only ever see the projections at the bottom of this file:
// public messages, customer-safe statuses, and nothing internal.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { getSupportCollections, ensureSupportIndexes } from "./db.js";
import { fail, nowIso, normEmail, isEmail, toPlainText, STATUSES, OPEN_STATUSES, RESOLVED_STATUSES, PRIORITIES, PRIORITY_RANK, CHANNELS, allowedTransitions, similarity } from "./common.js";
import { supportPerms } from "./access.js";
import { ensureDefaults, routeTicket, pickAssignee, escalationTarget } from "./queues.js";
import { makeCalendar, selectPolicy, startSla, onStatusChange, onFirstResponse, evaluateSla, nextCheckTime } from "./sla.js";
import { findContactByEmail, getProfile, invoicesForContact, invoiceView, customerContext } from "./customers.js";
import { audit, emit, link } from "./record.js";
import { notifyStaff, notifyCustomer, portalUrl, emailBody } from "./notify.js";

const MAX_SUBJECT = 200; const MAX_BODY = 20000;

// -------------------------------------------------------------------------- helpers
async function nextSeq(orgId) {
  const { supportCounters } = await getSupportCollections();
  const r = await supportCounters.findOneAndUpdate({ _id: `ticket:${orgId}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" });
  return r.seq;
}

export const readKey = (email) => normEmail(email).replace(/\./g, "%2E");
export const oidOf = (id) => { try { return toObjectId(id); } catch { return null; } };

export async function loadTicket(orgId, ticketId) {
  const id = oidOf(ticketId);
  if (!id) return null;
  const { supportTickets } = await getSupportCollections();
  return supportTickets.findOne({ _id: id, orgId: toObjectId(orgId), deletedAt: null });
}
export async function loadTicketByNumber(orgId, number) {
  const { supportTickets } = await getSupportCollections();
  return supportTickets.findOne({ orgId: toObjectId(orgId), number: String(number).toUpperCase(), deletedAt: null });
}

/** Follows merge links to the ticket that now holds the conversation. */
export async function resolveMerged(orgId, ticket) {
  let t = ticket; let hops = 0;
  while (t?.mergedInto && hops++ < 5) { const n = await loadTicket(orgId, t.mergedInto); if (!n) break; t = n; }
  return t;
}

/** Optimistic-concurrency update. `fn(ticket)` returns { set?, unset?, push?, pull? } or { error, status }. */
export async function mutate({ orgId, ticketId, fn, attempts = 4 }) {
  const { supportTickets } = await getSupportCollections();
  for (let i = 0; i < attempts; i++) {
    const t = await loadTicket(orgId, ticketId);
    if (!t) return fail("Ticket not found.", 404);
    const change = await fn(t);
    if (change?.error) return change;
    if (!change) return { ticket: t, unchanged: true };
    // any change to the SLA record makes the scheduler look at this ticket again on its next pass
    if (change.set && change.set.sla !== undefined && change.set.slaNextCheckAt === undefined) change.set.slaNextCheckAt = null;
    const update = { $set: { ...(change.set || {}), updatedAt: nowIso() }, $inc: { version: 1 } };
    if (change.unset) update.$unset = change.unset;
    if (change.push) update.$push = change.push;
    if (change.pull) update.$pull = change.pull;
    if (change.addToSet) update.$addToSet = change.addToSet;
    const r = await supportTickets.updateOne({ _id: t._id, orgId: t.orgId, version: t.version }, update);
    if (r.matchedCount) return { ticket: await loadTicket(orgId, ticketId), previous: t };
  }
  return fail("The ticket was changed by someone else at the same time. Reload and try again.", 409, { reasonCode: "CONFLICT" });
}

export function calOf(ticket, settings) { return makeCalendar(settings, ticket.slaCalOverride || null); }
export async function slaViewOf(ticket, settings, now = Date.now()) { return ticket?.sla ? evaluateSla(ticket.sla, { cal: calOf(ticket, settings), settings, now }) : null; }

// ------------------------------------------------------------------- priority policy
/** Server-side priority (SOW §7.3). A customer's own choice is recorded but never decides. */
export function computePriority({ channel, type, tier, requested, actorIsStaff }) {
  if (actorIsStaff && PRIORITIES.includes(requested)) return { priority: requested, source: "AGENT" };
  let p = "NORMAL";
  if (["Security", "Incident"].includes(type)) p = "HIGH";
  if (tier === "ENTERPRISE" && PRIORITY_RANK[p] < PRIORITY_RANK.HIGH) p = PRIORITIES[PRIORITY_RANK[p] + 1];
  return { priority: p, source: "POLICY" };
}

// ----------------------------------------------------------------------------- create
/**
 * Creates a ticket. `actor` = { type: customer|agent|api|email|ai, email, name?, portalUserId?, staff?: bool }.
 * `requester` = { email, name?, portalUserId? }. Returns { ticket, duplicate? } or { error }.
 */
export async function createTicket({ orgId, settings, actor, requester, subject, description, type = "Other", category = "General", priority, channel = "PORTAL", idempotencyKey = null, assigneeEmail = null, queueId = null, tags = [], customFields = {}, linkedInvoiceNumber = null, chatHandoff = null, unverified = false, emailMeta = null, triage = true }) {
  await ensureSupportIndexes(); await ensureDefaults(orgId);
  const subj = toPlainText(subject, MAX_SUBJECT).replace(/\s+/g, " ");
  const desc = toPlainText(description, MAX_BODY);
  if (subj.length < 3) return fail("A subject of at least 3 characters is required.");
  if (!desc) return fail("A description is required.");
  if (!CHANNELS.includes(channel)) return fail("Unknown channel.");
  const reqEmail = normEmail(requester?.email);
  if (!isEmail(reqEmail)) return fail("A valid requester email is required.");
  const t = settings.ticketTypes.includes(type) ? type : "Other";
  const cat = settings.categories.includes(category) ? category : "General";
  const { supportTickets, supportMessages } = await getSupportCollections();
  const oid = toObjectId(orgId);
  if (idempotencyKey) { const ex = await supportTickets.findOne({ orgId: oid, idempotencyKey }); if (ex) return { ticket: ex, duplicate: true }; }

  const contact = unverified ? null : await findContactByEmail(orgId, reqEmail);
  const profile = await getProfile(orgId, reqEmail);
  const tier = profile?.tier || null;
  const pr = computePriority({ channel, type: t, tier, requested: priority, actorIsStaff: !!actor?.staff });
  const routeInput = { type: t, category: cat, priority: pr.priority, channel, tier, subject: subj, text: desc };
  let queue; let routeReason = "explicit";
  if (queueId) { const { supportQueues } = await getSupportCollections(); queue = await supportQueues.findOne({ _id: toObjectId(queueId), orgId: oid, active: { $ne: false } }); }
  if (!queue) { const r = await routeTicket({ orgId, settings, ticket: routeInput }); queue = r.queue; routeReason = r.reason; }
  let assignee = null; let assignReason = null;
  if (assigneeEmail) { assignee = normEmail(assigneeEmail); assignReason = "explicit"; }
  else { const a = await pickAssignee({ orgId, queue, ticket: { ...routeInput, requester: { email: reqEmail } } }); assignee = a.assigneeEmail; assignReason = a.reason; }

  const { supportSlaPolicies } = await getSupportCollections();
  const policies = await supportSlaPolicies.find({ orgId: oid }).toArray();
  const policy = (queue?.defaultSlaPolicyId && policies.find((p) => String(p._id) === String(queue.defaultSlaPolicyId))) || selectPolicy(policies, { type: t, priority: pr.priority, tier, queueId: queue?._id });
  const status = assignee ? "OPEN" : "NEW";
  const now = Date.now();
  const sla = policy ? startSla({ policy, status, now, settings }) : null;
  const seq = await nextSeq(orgId);
  const number = `${settings.ticketPrefix}-${1000 + seq}`;

  // a linked invoice must belong to the requester's own CRM contact (for customers) or exist in the org (for staff)
  const linkedInvoiceIds = [];
  if (linkedInvoiceNumber) {
    const { invoices } = await getOrgCollections();
    const q = { orgId: oid, invoiceNumber: String(linkedInvoiceNumber).slice(0, 40), deletedAt: null };
    if (!actor?.staff) { if (!contact) return fail("That invoice could not be found on your account."); q.contactId = contact._id; }
    const inv = await invoices.findOne(q);
    if (!inv) return fail("That invoice could not be found on your account.");
    linkedInvoiceIds.push(inv._id);
  }

  const doc = {
    orgId: oid, seq, number, subject: subj, description: desc, channel, type: t, category: cat, priority: pr.priority, prioritySource: pr.source, requestedPriority: PRIORITIES.includes(priority) ? priority : null,
    priorityRank: PRIORITY_RANK[pr.priority], status, queueId: queue?._id || null, teamId: queue?.teamId || null, assigneeEmail: assignee, routing: { reason: routeReason, assign: assignReason },
    requester: { email: reqEmail, name: requester?.name || contact?.name || null, portalUserId: requester?.portalUserId ? toObjectId(requester.portalUserId) : null, contactId: contact?._id || null, unverified: !!unverified },
    collaborators: [], followers: [], tags: (Array.isArray(tags) ? tags : []).slice(0, 20).map((x) => String(x).slice(0, 30)), customFields: customFields && typeof customFields === "object" ? customFields : {},
    linkedInvoiceIds, sla, slaCalOverride: queue?.businessHours || policy?.businessHours || null, slaState: sla ? evaluateSla(sla, { cal: makeCalendar(settings, queue?.businessHours || policy?.businessHours || null), settings, now }).state : null,
    aiTriage: { state: settings.ai.triageEnabled && triage ? "PENDING" : "SKIPPED", attempts: 0 }, chatHandoff: chatHandoff || null,
    createdAt: nowIso(), updatedAt: nowIso(), firstResponseAt: null, solvedAt: null, closedAt: null, lastPublicActivityAt: nowIso(), lastCustomerMessageAt: actor?.type === "agent" ? null : nowIso(), reopenCount: 0,
    mergedInto: null, version: 1, deletedAt: null, agentReadAt: {}, ...(idempotencyKey ? { idempotencyKey } : {}),
  };
  try { doc._id = (await supportTickets.insertOne(doc)).insertedId; } catch (err) { if (err?.code === 11000 && idempotencyKey) { const ex = await supportTickets.findOne({ orgId: oid, idempotencyKey }); if (ex) return { ticket: ex, duplicate: true }; } throw err; }
  const msg = { orgId: oid, ticketId: doc._id, visibility: "PUBLIC", kind: "REPLY", author: { type: actor?.type || "customer", email: normEmail(actor?.email || reqEmail), name: actor?.name || requester?.name || null, portalUserId: requester?.portalUserId ? toObjectId(requester.portalUserId) : null }, body: desc, attachments: [], createdAt: doc.createdAt, initial: true, ...(emailMeta ? { messageIdHeader: emailMeta.messageId || null, inReplyTo: emailMeta.inReplyTo || null, viaEmail: true } : {}) };
  await supportMessages.insertOne(msg);

  await audit({ orgId, ticketId: doc._id, action: "TICKET_CREATED", actorEmail: actor?.email || reqEmail, newState: status, metadata: { number, channel, type: t, priority: pr.priority, queue: queue?.name, routing: routeReason, assignedTo: assignee || null, slaPolicy: policy?.name || null, ...(actor?.staff ? {} : {}) } });
  const ev = await emit({ orgId, type: "ticket.created", ticket: doc, actor: actor?.email || reqEmail, data: { channel, queue: queue?.name || null } });
  link({ orgId, ticketId: doc._id, type: "REFERENCES", targetType: "SUPPORT_QUEUE", targetId: queue?._id || doc._id, note: `routed to ${queue?.name || "queue"} (${routeReason})` });
  for (const invId of linkedInvoiceIds) link({ orgId, ticketId: doc._id, type: "REFERENCES", targetType: "INVOICE", targetId: invId, note: "linked invoice" });
  if (contact) link({ orgId, ticketId: doc._id, type: "SOURCED_FROM", targetType: "CRM_CONTACT", targetId: contact._id, note: "requester" });

  // notifications: staff first (they act), then the customer's confirmation
  if (assignee) await notifyStaff({ orgId, emails: [assignee], title: `New ticket ${number} assigned to you`, body: subj, ticket: doc, dedupeKey: `support:assigned:${doc._id}:create` });
  else await notifyStaff({ orgId, emails: queue?.eligibleAgents?.length ? queue.eligibleAgents : null, title: `New ticket ${number} in ${queue?.name || "queue"}`, body: subj, ticket: doc, dedupeKey: `support:new:${doc._id}` });
  if (actor?.type !== "agent") await notifyCustomer({ orgId, settings, to: { email: reqEmail, portalUserId: requester?.portalUserId }, type: "ticket_created", ticket: doc, title: `We received your request ${number}`, body: subj, dedupeKey: `support:created:${doc._id}`, email: settings.portalSlug || settings.email?.supportAddress ? { subject: `[${number}] We received your request`, ...emailBody({ heading: `We received your request ${number}`, message: `Thank you for contacting us. We will reply as soon as we can.\n\nSubject: ${subj}`, linkUrl: portalUrl(settings, `?ticket=${doc._id}`) }), headers: { "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" } } : null });
  return { ticket: doc, event: ev };
}

// --------------------------------------------------------------------------- transitions
/** Changes status. `actor` = { type, email }. Returns { ticket } or { error }. */
export async function transition({ orgId, settings, ticketId, to, actor, reason = null, allowReopen = false }) {
  if (!STATUSES.includes(to)) return fail("Unknown status.");
  const res = await mutate({ orgId, ticketId, fn: async (t) => {
    if (t.status === to) return null;
    const ok = allowedTransitions(t.status, settings).includes(to);
    if (!ok) return fail(`A ${t.status} ticket cannot move to ${to}.`, 409, { reasonCode: "BAD_TRANSITION" });
    const now = Date.now();
    const cal = calOf(t, settings);
    const sla = t.sla ? onStatusChange(t.sla, { from: t.status, to, cal, policy: null, settings, now }) : null;
    const set = { status: to, sla, slaState: sla ? evaluateSla(sla, { cal, settings, now }).state : null, lastStatusChangeAt: nowIso() };
    if (to === "SOLVED") set.solvedAt = nowIso();
    if (to === "CLOSED") set.closedAt = nowIso();
    if (t.status === "SOLVED" && to === "OPEN") { set.solvedAt = null; set.reopenCount = (t.reopenCount || 0) + 1; }
    return { set };
  } });
  if (res.error || res.unchanged) return res;
  const { ticket, previous } = res;
  await audit({ orgId, ticketId: ticket._id, action: "TICKET_STATUS_CHANGED", actorEmail: actor?.email || "system", previousState: previous.status, newState: to, metadata: { reason, source: actor?.type || "system", number: ticket.number } });
  const customerVisible = true;
  await emit({ orgId, type: to === "SOLVED" ? "ticket.solved" : to === "CLOSED" ? "ticket.closed" : previous.status === "SOLVED" && to === "OPEN" ? "ticket.reopened" : to === "ESCALATED" ? "ticket.escalated" : "ticket.status_changed", ticket, actor: actor?.email || "system", data: { from: previous.status, to, reason }, customerVisible });
  if (to === "SOLVED" || to === "CLOSED") link({ orgId, ticketId: ticket._id, type: "PROVEN_BY", targetType: "SUPPORT_RESOLUTION", targetId: ticket._id, note: `${to.toLowerCase()} by ${actor?.type || "system"}` });
  if (actor?.type !== "customer" && !previous.requester?.unverified) {
    if (to === "SOLVED") await notifyCustomer({ orgId, settings, to: { email: ticket.requester.email, portalUserId: ticket.requester.portalUserId }, type: "ticket_solved", ticket, title: `Your request ${ticket.number} was solved`, body: "If it isn't fully resolved, reply to reopen it. We would also value your feedback.", dedupeKey: `support:solved:${ticket._id}:${ticket.solvedAt}`, email: { subject: `[${ticket.number}] Your request was solved`, ...emailBody({ heading: `Your request ${ticket.number} was solved`, message: "If it isn't fully resolved, just reply and we will reopen it. You can also rate the help you received in the portal.", linkUrl: portalUrl(settings, `?ticket=${ticket._id}`) }) } });
    else if (to === "WAITING_FOR_CUSTOMER") await notifyCustomer({ orgId, settings, to: { email: ticket.requester.email, portalUserId: ticket.requester.portalUserId }, type: "ticket_reply_requested", ticket, title: `We need a reply on ${ticket.number}`, body: "The support team is waiting for your answer.", dedupeKey: `support:waiting:${ticket._id}:${ticket.version}`, email: { subject: `[${ticket.number}] We need your reply`, ...emailBody({ heading: `We need your reply on ${ticket.number}`, message: "The support team is waiting for more information from you.", linkUrl: portalUrl(settings, `?ticket=${ticket._id}`) }) } });
  }
  return { ticket };
}

/** Reopens a SOLVED ticket, or a CLOSED one inside the reopen window (policy in settings). */
export async function reopen({ orgId, settings, ticketId, actor, reason = "Customer reopened" }) {
  const t = await loadTicket(orgId, ticketId);
  if (!t) return fail("Ticket not found.", 404);
  if (t.status === "SOLVED") return transition({ orgId, settings, ticketId, to: "OPEN", actor, reason });
  if (t.status === "CLOSED") {
    const days = settings.reopenWindowDays;
    if (Date.now() - Date.parse(t.closedAt || t.updatedAt) > days * 86400000) return fail(`This request was closed more than ${days} days ago. Please open a new request; we will link it to this one.`, 409, { reasonCode: "REOPEN_WINDOW_PASSED" });
    const { supportTickets } = await getSupportCollections();
    const res = await mutate({ orgId, ticketId, fn: async (x) => {
      if (x.status !== "CLOSED") return fail("Only a closed or solved ticket can be reopened.", 409);
      const now = Date.now(); const cal = calOf(x, settings);
      const sla = x.sla ? onStatusChange(x.sla, { from: "SOLVED", to: "OPEN", cal, policy: null, settings, now }) : null;
      return { set: { status: "OPEN", sla, slaState: sla ? evaluateSla(sla, { cal, settings, now }).state : null, closedAt: null, solvedAt: null, reopenCount: (x.reopenCount || 0) + 1 } };
    } });
    if (res.error) return res;
    await audit({ orgId, ticketId: t._id, action: "TICKET_REOPENED", actorEmail: actor?.email, previousState: "CLOSED", newState: "OPEN", metadata: { reason } });
    await emit({ orgId, type: "ticket.reopened", ticket: res.ticket, actor: actor?.email, data: { from: "CLOSED", reason }, customerVisible: true });
    return { ticket: res.ticket };
  }
  return fail("Only a closed or solved ticket can be reopened.", 409);
}

// ----------------------------------------------------------------------------- assignment
async function assertAssignable(orgId, email) {
  const { orgMembers } = await getOrgCollections();
  const m = await orgMembers.findOne({ orgId: toObjectId(orgId), email: normEmail(email), status: "active" });
  return m && supportPerms(m).has("view_tickets") ? m : null;
}

/** Assigns / unassigns / moves queue. The SLA clock is NOT touched by reassignment (SOW §9.3). */
export async function assign({ orgId, settings, ticketId, assigneeEmail, queueId, teamId, actor }) {
  let target = undefined;
  if (assigneeEmail !== undefined && assigneeEmail !== null) { const m = await assertAssignable(orgId, assigneeEmail); if (!m) return fail("That person is not an active member with support access."); target = normEmail(assigneeEmail); }
  let queue = null;
  if (queueId) { const { supportQueues } = await getSupportCollections(); queue = await supportQueues.findOne({ _id: oidOf(queueId) || undefined, orgId: toObjectId(orgId), active: { $ne: false } }); if (!queue) return fail("Queue not found.", 404); }
  const res = await mutate({ orgId, ticketId, fn: async (t) => {
    if (RESOLVED_STATUSES.includes(t.status)) return fail("A solved or closed ticket cannot be reassigned.", 409);
    const set = {};
    if (assigneeEmail !== undefined) { set.assigneeEmail = target || null; if (target && t.status === "NEW") { set.status = "OPEN"; if (t.sla) { const now = Date.now(); const cal = calOf(t, settings); const sla = onStatusChange(t.sla, { from: "NEW", to: "OPEN", cal, policy: null, settings, now }); set.sla = sla; set.slaState = evaluateSla(sla, { cal, settings, now }).state; } } }
    if (queue) { set.queueId = queue._id; set.teamId = queue.teamId || null; }
    if (teamId !== undefined) set.teamId = teamId ? oidOf(teamId) : null;
    return { set: { ...set, lastAssignedAt: nowIso() } };
  } });
  if (res.error || res.unchanged) return res;
  const { ticket, previous } = res;
  await audit({ orgId, ticketId: ticket._id, action: "TICKET_ASSIGNED", actorEmail: actor?.email, previousState: previous.assigneeEmail || null, newState: ticket.assigneeEmail || null, metadata: { queueFrom: previous.queueId ? String(previous.queueId) : null, queueTo: ticket.queueId ? String(ticket.queueId) : null, number: ticket.number } });
  await emit({ orgId, type: "ticket.assigned", ticket, actor: actor?.email, data: { from: previous.assigneeEmail || null, to: ticket.assigneeEmail || null } });
  link({ orgId, ticketId: ticket._id, type: "REFERENCES", targetType: "SUPPORT_ASSIGNMENT", targetId: ticket._id, note: `assigned to ${ticket.assigneeEmail || "nobody"} by ${actor?.email || "system"}` });
  if (ticket.assigneeEmail && ticket.assigneeEmail !== previous.assigneeEmail && ticket.assigneeEmail !== normEmail(actor?.email)) await notifyStaff({ orgId, emails: [ticket.assigneeEmail], title: `Ticket ${ticket.number} was assigned to you`, body: ticket.subject, ticket, dedupeKey: `support:assigned:${ticket._id}:${ticket.version}` });
  return { ticket };
}

/** Changes priority. The SLA policy is re-selected and the targets change; consumed time is kept. */
export async function setPriority({ orgId, settings, ticketId, priority, actor }) {
  if (!PRIORITIES.includes(priority)) return fail("priority must be LOW, NORMAL, HIGH or URGENT.");
  const { supportSlaPolicies } = await getSupportCollections();
  const policies = await supportSlaPolicies.find({ orgId: toObjectId(orgId) }).toArray();
  const res = await mutate({ orgId, ticketId, fn: async (t) => {
    if (t.priority === priority) return null;
    const profile = await getProfile(orgId, t.requester.email);
    const policy = selectPolicy(policies, { type: t.type, priority, tier: profile?.tier || null, queueId: t.queueId });
    const set = { priority, priorityRank: PRIORITY_RANK[priority], prioritySource: "AGENT" };
    if (t.sla && policy) { const sla = JSON.parse(JSON.stringify(t.sla)); sla.targets = { firstResponseMin: policy.firstResponseMin, resolutionMin: policy.resolutionMin }; sla.policyId = String(policy._id); sla.policyName = policy.name; sla.escalations = policy.escalations || sla.escalations; set.sla = sla; set.slaState = evaluateSla(sla, { cal: calOf(t, settings), settings }).state; }
    return { set };
  } });
  if (res.error || res.unchanged) return res;
  await audit({ orgId, ticketId: res.ticket._id, action: "TICKET_PRIORITY_CHANGED", actorEmail: actor?.email, previousState: res.previous.priority, newState: priority, metadata: { number: res.ticket.number, slaPolicy: res.ticket.sla?.policyName || null } });
  await emit({ orgId, type: "ticket.priority_changed", ticket: res.ticket, actor: actor?.email, data: { from: res.previous.priority, to: priority } });
  return { ticket: res.ticket };
}

export async function setTags({ orgId, ticketId, add = [], remove = [], actor }) {
  const clean = (l) => (Array.isArray(l) ? l : []).map((x) => String(x).trim().slice(0, 30)).filter(Boolean);
  const res = await mutate({ orgId, ticketId, fn: async (t) => { const set = new Set(t.tags || []); clean(remove).forEach((x) => set.delete(x)); clean(add).forEach((x) => set.add(x)); if (set.size > 30) return fail("At most 30 tags per ticket."); return { set: { tags: [...set] } }; } });
  if (res.error || res.unchanged) return res;
  await audit({ orgId, ticketId: res.ticket._id, action: "TICKET_TAGS_CHANGED", actorEmail: actor?.email, metadata: { add: clean(add), remove: clean(remove) } });
  return { ticket: res.ticket };
}

export async function follow({ orgId, ticketId, email, on = true }) {
  const res = await mutate({ orgId, ticketId, fn: async (t) => ({ set: { followers: on ? [...new Set([...(t.followers || []), normEmail(email)])] : (t.followers || []).filter((e) => e !== normEmail(email)) } }) });
  return res.error ? res : { ticket: res.ticket };
}

export async function setSlaPolicy({ orgId, settings, ticketId, policyId, actor }) {
  const { supportSlaPolicies } = await getSupportCollections();
  const p = await supportSlaPolicies.findOne({ _id: oidOf(policyId) || undefined, orgId: toObjectId(orgId), active: { $ne: false } });
  if (!p) return fail("SLA policy not found.", 404);
  const res = await mutate({ orgId, ticketId, fn: async (t) => { if (!t.sla) return fail("This ticket has no SLA."); const sla = JSON.parse(JSON.stringify(t.sla)); sla.targets = { firstResponseMin: p.firstResponseMin, resolutionMin: p.resolutionMin }; sla.policyId = String(p._id); sla.policyName = p.name; sla.escalations = p.escalations || sla.escalations; return { set: { sla, slaState: evaluateSla(sla, { cal: calOf(t, settings), settings }).state, slaManual: true } }; } });
  if (res.error) return res;
  await audit({ orgId, ticketId: res.ticket._id, action: "TICKET_SLA_CHANGED", actorEmail: actor?.email, metadata: { policy: p.name, previous: res.previous.sla?.policyName || null } });
  return { ticket: res.ticket };
}

// ----------------------------------------------------------------------------- relationships
export const RELATION_TYPES = ["duplicate", "parent", "child", "related", "follow_up", "incident"];

export async function relate({ orgId, fromId, toId, type, actor }) {
  if (!RELATION_TYPES.includes(type)) return fail(`type must be one of ${RELATION_TYPES.join(", ")}.`);
  const a = await loadTicket(orgId, fromId); const b = await loadTicket(orgId, toId);
  if (!a || !b) return fail("Ticket not found.", 404);
  if (String(a._id) === String(b._id)) return fail("A ticket cannot be related to itself.");
  const { supportRelations } = await getSupportCollections();
  const exists = await supportRelations.findOne({ orgId: a.orgId, $or: [{ fromTicketId: a._id, toTicketId: b._id, type }, { fromTicketId: b._id, toTicketId: a._id, type }] });
  if (exists) return { relation: { relationId: String(exists._id), type }, duplicate: true };
  const r = await supportRelations.insertOne({ orgId: a.orgId, fromTicketId: a._id, toTicketId: b._id, type, createdBy: actor?.email || "system", createdAt: nowIso() });
  await audit({ orgId, ticketId: a._id, action: "TICKET_RELATED", actorEmail: actor?.email, metadata: { type, to: b.number } });
  await emit({ orgId, type: "ticket.related", ticket: a, actor: actor?.email, data: { type, to: b.number } });
  link({ orgId, ticketId: a._id, type: "RELATES_TO", targetType: "SUPPORT_TICKET_REF", targetId: b._id, note: `${type}: ${b.number}` });
  return { relation: { relationId: String(r.insertedId), type } };
}

/** Related tickets, both directions, as agent-safe summaries. */
export async function relatedTickets({ orgId, ticketId }) {
  const { supportRelations, supportTickets } = await getSupportCollections();
  const id = oidOf(ticketId);
  const rels = await supportRelations.find({ orgId: toObjectId(orgId), $or: [{ fromTicketId: id }, { toTicketId: id }] }).toArray();
  const ids = rels.map((r) => (String(r.fromTicketId) === String(id) ? r.toTicketId : r.fromTicketId));
  const ts = new Map((await supportTickets.find({ _id: { $in: ids }, orgId: toObjectId(orgId) }).project({ number: 1, subject: 1, status: 1 }).toArray()).map((t) => [String(t._id), t]));
  return rels.map((r) => { const other = ts.get(String(String(r.fromTicketId) === String(id) ? r.toTicketId : r.fromTicketId)); return { relationId: String(r._id), type: r.type, direction: String(r.fromTicketId) === String(id) ? "out" : "in", ticket: other ? { id: String(other._id), number: other.number, subject: other.subject, status: other.status } : null }; });
}

/** Duplicate candidates: same requester or similar subject in the recent window. Deterministic; never auto-merges. */
export async function duplicateCandidates({ orgId, ticket, limit = 5 }) {
  const { supportTickets } = await getSupportCollections();
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const rows = await supportTickets.find({ orgId: toObjectId(orgId), _id: { $ne: ticket._id }, createdAt: { $gte: since }, status: { $nin: ["CANCELLED"] }, mergedInto: null, deletedAt: null }).sort({ createdAt: -1 }).limit(300).project({ number: 1, subject: 1, description: 1, status: 1, "requester.email": 1 }).toArray();
  return rows.map((r) => ({ id: String(r._id), number: r.number, subject: r.subject, status: r.status, sameRequester: r.requester?.email === ticket.requester?.email, score: Math.round(similarity(`${ticket.subject} ${ticket.description}`, `${r.subject} ${r.description}`) * 100) / 100 })).filter((r) => r.score >= 0.35 || (r.sameRequester && r.score >= 0.2)).sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Merge (SOW §48). Never automatic. The source is CLOSED and points at the target; no message, audit entry or
 * attachment is deleted; the customer of the source sees a continuity note and can follow the target.
 */
export async function merge({ orgId, settings, sourceId, targetId, actor }) {
  const src = await loadTicket(orgId, sourceId); const dst = await loadTicket(orgId, targetId);
  if (!src || !dst) return fail("Ticket not found.", 404);
  if (String(src._id) === String(dst._id)) return fail("A ticket cannot be merged into itself.");
  if (src.mergedInto) return fail("That ticket was already merged.", 409);
  if (dst.mergedInto || RESOLVED_STATUSES.includes(dst.status)) return fail("The target ticket must be open and not itself merged.", 409);
  const { supportMessages } = await getSupportCollections();
  const closed = await mutate({ orgId, ticketId: src._id, fn: async (t) => { if (t.mergedInto) return fail("That ticket was already merged.", 409); const now = Date.now(); const cal = calOf(t, settings); const sla = t.sla ? onStatusChange(t.sla, { from: t.status, to: "CLOSED", cal, policy: null, settings, now }) : null; return { set: { status: "CLOSED", closedAt: nowIso(), mergedInto: dst._id, sla, slaState: sla ? "COMPLETED" : null } }; } });
  if (closed.error) return closed;
  await supportMessages.insertOne({ orgId: dst.orgId, ticketId: dst._id, visibility: "INTERNAL", kind: "SYSTEM", author: { type: "system" }, body: `Merged from ${src.number} ("${src.subject}") by ${actor?.email || "system"}. The original conversation is preserved on ${src.number}.`, attachments: [], createdAt: nowIso() });
  await supportMessages.insertOne({ orgId: src.orgId, ticketId: src._id, visibility: "PUBLIC", kind: "SYSTEM", author: { type: "system" }, body: `This request was merged into ${dst.number}. Please continue the conversation there.`, attachments: [], createdAt: nowIso() });
  const { supportRelations } = await getSupportCollections();
  await supportRelations.insertOne({ orgId: src.orgId, fromTicketId: src._id, toTicketId: dst._id, type: "merged_into", createdBy: actor?.email || "system", createdAt: nowIso() });
  // the surviving ticket keeps the source requester as a collaborator so that person keeps seeing the thread
  if (src.requester.email !== dst.requester.email) await mutate({ orgId, ticketId: dst._id, fn: async (t) => ((t.collaborators || []).some((c) => c.email === src.requester.email) ? null : { push: { collaborators: { email: src.requester.email, canReply: true, addedBy: actor?.email || "system", addedAt: nowIso(), viaMerge: src.number } } }) });
  await audit({ orgId, ticketId: src._id, action: "TICKET_MERGED", actorEmail: actor?.email, previousState: src.status, newState: "CLOSED", metadata: { into: dst.number, sourceNumber: src.number } });
  await audit({ orgId, ticketId: dst._id, action: "TICKET_MERGE_TARGET", actorEmail: actor?.email, metadata: { from: src.number } });
  await emit({ orgId, type: "ticket.merged", ticket: dst, actor: actor?.email, data: { source: src.number, target: dst.number } });
  link({ orgId, ticketId: dst._id, type: "DERIVED_FROM", targetType: "SUPPORT_TICKET_REF", targetId: src._id, note: `merged ${src.number}` });
  return { source: closed.ticket, target: await loadTicket(orgId, dst._id) };
}

// ------------------------------------------------------------------- collaborators (SOW §43)
/** The requester (or staff) shares a ticket with another person. The person must be a CRM contact of this org. */
export async function addCollaborator({ orgId, ticketId, email, canReply = false, actor, byRequester = false }) {
  const e = normEmail(email);
  if (!isEmail(e)) return fail("A valid email is required.");
  const contact = await findContactByEmail(orgId, e);
  if (!contact && byRequester) return fail("That person is not a known contact of this company, so the ticket cannot be shared with them. Ask support to add them.", 403);
  const res = await mutate({ orgId, ticketId, fn: async (t) => { if (e === t.requester.email) return fail("The requester already has access."); if ((t.collaborators || []).length >= 10) return fail("At most 10 collaborators per ticket."); if ((t.collaborators || []).some((c) => c.email === e)) return { set: { collaborators: t.collaborators.map((c) => (c.email === e ? { ...c, canReply: !!canReply } : c)) } }; return { push: { collaborators: { email: e, canReply: !!canReply, addedBy: actor?.email, addedAt: nowIso(), contactId: contact?._id || null } } }; } });
  if (res.error) return res;
  await audit({ orgId, ticketId: res.ticket._id, action: "TICKET_SHARED", actorEmail: actor?.email, metadata: { with: e, canReply: !!canReply } });
  await emit({ orgId, type: "ticket.shared", ticket: res.ticket, actor: actor?.email, data: { with: e, canReply: !!canReply } });
  return { ticket: res.ticket };
}
export async function removeCollaborator({ orgId, ticketId, email, actor }) {
  const e = normEmail(email);
  const res = await mutate({ orgId, ticketId, fn: async (t) => ((t.collaborators || []).some((c) => c.email === e) ? { set: { collaborators: t.collaborators.filter((c) => c.email !== e) } } : null) });
  if (res.error) return res;
  await audit({ orgId, ticketId: res.ticket?._id || ticketId, action: "TICKET_SHARE_REVOKED", actorEmail: actor?.email, metadata: { with: e } });
  return { ticket: res.ticket };
}

// ------------------------------------------------------------------------------- listing
export const VIEWS = ["all_open", "unassigned", "assigned_to_me", "my_team", "new", "waiting_customer", "escalated", "sla_at_risk", "sla_breached", "high_priority", "urgent", "recently_solved", "recently_closed", "all"];

async function visibilityFilter({ orgId, membership, email }) {
  const perms = supportPerms(membership);
  if (perms.has("admin_queues") || perms.has("admin_settings")) return {}; // managers, admins, owners: everything
  const { supportQueues } = await getSupportCollections();
  const queues = await supportQueues.find({ orgId: toObjectId(orgId) }).project({ eligibleAgents: 1 }).toArray();
  const visible = queues.filter((q) => !q.eligibleAgents?.length || q.eligibleAgents.includes(normEmail(email))).map((q) => q._id);
  return { $or: [{ queueId: { $in: visible } }, { assigneeEmail: normEmail(email) }, { followers: normEmail(email) }] };
}

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Agent ticket search: number, requester, subject/description (text index), message text, tags. Internal notes only if the agent may see them. */
export async function searchTicketIds({ orgId, q, includeNotes }) {
  const { supportTickets, supportMessages } = await getSupportCollections();
  const oid = toObjectId(orgId); const term = String(q || "").trim().slice(0, 100);
  if (!term) return null;
  const ids = new Set();
  const byField = await supportTickets.find({ orgId: oid, $or: [{ number: new RegExp(`^${escRe(term)}`, "i") }, { "requester.email": new RegExp(escRe(term), "i") }, { "requester.name": new RegExp(escRe(term), "i") }, { tags: term }] }).project({ _id: 1 }).limit(200).toArray();
  byField.forEach((t) => ids.add(String(t._id)));
  try {
    const text = await supportTickets.find({ orgId: oid, $text: { $search: term } }).project({ _id: 1 }).limit(200).toArray();
    text.forEach((t) => ids.add(String(t._id)));
    const msgs = await supportMessages.find({ orgId: oid, $text: { $search: term }, ...(includeNotes ? {} : { visibility: "PUBLIC" }) }).project({ ticketId: 1 }).limit(300).toArray();
    msgs.forEach((m) => ids.add(String(m.ticketId)));
  } catch { /* text index still building: field search above still works */ }
  const { invoices } = await getOrgCollections();
  const inv = await invoices.find({ orgId: oid, invoiceNumber: new RegExp(`^${escRe(term)}`, "i") }).project({ _id: 1 }).limit(20).toArray();
  if (inv.length) (await supportTickets.find({ orgId: oid, linkedInvoiceIds: { $in: inv.map((i) => i._id) } }).project({ _id: 1 }).toArray()).forEach((t) => ids.add(String(t._id)));
  return [...ids].map((i) => toObjectId(i));
}

export async function listTickets({ orgId, settings, membership, email, view = "all_open", queueId = null, status = null, assignee = null, priority = null, q = null, limit = 50, skip = 0 }) {
  if (!supportPerms(membership).has("view_tickets")) return fail("You do not have access to support tickets.", 403);
  const { supportTickets, supportTeams } = await getSupportCollections();
  const oid = toObjectId(orgId);
  const filter = { orgId: oid, deletedAt: null, mergedInto: null };
  const vis = await visibilityFilter({ orgId, membership, email });
  const and = [vis];
  const me = normEmail(email);
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
  switch (view) {
    case "all_open": filter.status = { $in: OPEN_STATUSES }; break;
    case "unassigned": filter.status = { $in: OPEN_STATUSES }; filter.assigneeEmail = null; break;
    case "assigned_to_me": filter.status = { $in: OPEN_STATUSES }; filter.assigneeEmail = me; break;
    case "my_team": { const teams = await supportTeams.find({ orgId: oid, memberEmails: me }).project({ _id: 1 }).toArray(); filter.status = { $in: OPEN_STATUSES }; filter.teamId = { $in: teams.map((t) => t._id) }; break; }
    case "new": filter.status = "NEW"; break;
    case "waiting_customer": filter.status = "WAITING_FOR_CUSTOMER"; break;
    case "escalated": filter.status = "ESCALATED"; break;
    case "sla_at_risk": filter.status = { $in: OPEN_STATUSES }; filter.slaState = "AT_RISK"; break;
    case "sla_breached": filter.status = { $in: OPEN_STATUSES }; filter.slaState = "BREACHED"; break;
    case "high_priority": filter.status = { $in: OPEN_STATUSES }; filter.priority = { $in: ["HIGH", "URGENT"] }; break;
    case "urgent": filter.status = { $in: OPEN_STATUSES }; filter.priority = "URGENT"; break;
    case "recently_solved": filter.status = "SOLVED"; filter.solvedAt = { $gte: cutoff }; break;
    case "recently_closed": filter.status = "CLOSED"; filter.closedAt = { $gte: cutoff }; break;
    case "all": break;
    default: return fail(`view must be one of ${VIEWS.join(", ")}.`);
  }
  if (queueId) filter.queueId = oidOf(queueId) || undefined;
  if (status) filter.status = status;
  if (assignee === "none") filter.assigneeEmail = null; else if (assignee) filter.assigneeEmail = normEmail(assignee);
  if (priority) filter.priority = priority;
  if (q) { const ids = await searchTicketIds({ orgId, q, includeNotes: supportPerms(membership).has("create_notes") }); and.push({ _id: { $in: ids || [] } }); }
  const finalFilter = and.filter((x) => Object.keys(x).length).length ? { $and: [filter, ...and.filter((x) => Object.keys(x).length)] } : filter;
  const [rows, total] = await Promise.all([
    supportTickets.find(finalFilter).sort({ priorityRank: -1, updatedAt: -1 }).skip(Math.max(0, skip)).limit(Math.min(Math.max(limit, 1), 100)).project({ description: 0 }).toArray(),
    supportTickets.countDocuments(finalFilter),
  ]);
  const now = Date.now();
  return { total, tickets: rows.map((t) => agentSummary(t, settings, now, me)) };
}

export function agentSummary(t, settings, now = Date.now(), me = null) {
  const sv = t.sla ? evaluateSla(t.sla, { cal: calOf(t, settings), settings, now }) : null;
  return {
    id: String(t._id), number: t.number, subject: t.subject, status: t.status, priority: t.priority, type: t.type, category: t.category, channel: t.channel, queueId: t.queueId ? String(t.queueId) : null, teamId: t.teamId ? String(t.teamId) : null, assigneeEmail: t.assigneeEmail || null,
    requester: { email: t.requester?.email, name: t.requester?.name || null, unverified: !!t.requester?.unverified }, tags: t.tags || [], createdAt: t.createdAt, updatedAt: t.updatedAt, firstResponseAt: t.firstResponseAt || null, solvedAt: t.solvedAt || null,
    sla: sv ? { state: sv.state, firstPct: sv.firstPct, resolutionPct: sv.resolutionPct, firstResponseDueAt: sv.firstResponseDueAt, resolutionDueAt: sv.resolutionDueAt, policy: t.sla.policyName } : null,
    unread: me ? !t.agentReadAt?.[readKey(me)] || t.agentReadAt[readKey(me)] < (t.lastPublicActivityAt || "") : false, aiTriage: t.aiTriage ? { state: t.aiTriage.state } : null, reopenCount: t.reopenCount || 0,
  };
}

// ---------------------------------------------------------------------------- detail (agent)
export async function getTicketForAgent({ orgId, settings, membership, email, ticketId }) {
  if (!supportPerms(membership).has("view_tickets")) return fail("Ticket not found.", 404);
  const t = await loadTicket(orgId, ticketId);
  if (!t) return fail("Ticket not found.", 404);
  const vis = await visibilityFilter({ orgId, membership, email });
  if (Object.keys(vis).length) { const { supportTickets } = await getSupportCollections(); const ok = await supportTickets.findOne({ $and: [{ _id: t._id }, vis] }); if (!ok) return fail("Ticket not found.", 404); }
  const perms = supportPerms(membership);
  const { supportMessages, supportEvents, supportAttachments } = await getSupportCollections();
  const seeNotes = perms.has("create_notes"); const seeInvoices = perms.has("view_invoices");
  // independent reads run together (each one is a round trip to the database)
  const [msgs, atts, events, ctx, linked, related, duplicates] = await Promise.all([
    supportMessages.find({ orgId: t.orgId, ticketId: t._id, ...(seeNotes ? {} : { visibility: "PUBLIC" }) }).sort({ createdAt: 1 }).limit(500).toArray(),
    supportAttachments.find({ orgId: t.orgId, ticketId: t._id, ...(seeNotes ? {} : { visibility: "PUBLIC" }) }).toArray(),
    supportEvents.find({ orgId: t.orgId, ticketId: t._id }).sort({ createdAt: 1 }).limit(200).toArray(),
    customerContext({ orgId, email: t.requester.email, includeInvoices: seeInvoices }),
    (async () => { if (!(seeInvoices && t.linkedInvoiceIds?.length)) return []; const { invoices } = await getOrgCollections(); return (await invoices.find({ _id: { $in: t.linkedInvoiceIds }, orgId: t.orgId }).toArray()).map(invoiceView); })(),
    relatedTickets({ orgId, ticketId: t._id }),
    duplicateCandidates({ orgId, ticket: t, limit: 3 }),
  ]);
  const sv = t.sla ? evaluateSla(t.sla, { cal: calOf(t, settings), settings }) : null;
  return {
    ticket: { ...agentSummary(t, settings, Date.now(), normEmail(email)), description: t.description, collaborators: t.collaborators || [], followers: t.followers || [], customFields: t.customFields || {}, routing: t.routing, aiTriage: t.aiTriage || null, chatHandoff: t.chatHandoff || null, sla: sv ? { ...sv, policy: t.sla.policyName, reopened: t.sla.reopened || 0 } : null, mergedInto: t.mergedInto ? String(t.mergedInto) : null, requestedPriority: t.requestedPriority, prioritySource: t.prioritySource, version: t.version },
    messages: msgs.map(messageView), attachments: atts.map(attachmentView), events: events.map((e) => ({ type: e.type, at: e.createdAt, actor: e.actor, data: e.data })), related, customer: ctx, linkedInvoices: linked, duplicates,
    permissions: [...perms],
  };
}

export const messageView = (m) => ({ id: String(m._id), visibility: m.visibility, kind: m.kind, author: { type: m.author?.type, email: m.author?.email || null, name: m.author?.name || null }, body: m.body, attachments: (m.attachments || []).map(String), createdAt: m.createdAt, initial: !!m.initial, viaEmail: !!m.viaEmail, aiGenerated: !!m.aiGenerated });
export const attachmentView = (a) => ({ id: String(a._id), filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes, visibility: a.visibility, messageId: a.messageId ? String(a.messageId) : null, uploadedBy: a.uploadedBy?.type, createdAt: a.createdAt, scan: a.scan?.status });

export async function markRead({ orgId, ticketId, email }) {
  const { supportTickets } = await getSupportCollections();
  await supportTickets.updateOne({ _id: oidOf(ticketId) || undefined, orgId: toObjectId(orgId) }, { $set: { [`agentReadAt.${readKey(email)}`]: nowIso() } });
  return { ok: true };
}

// ------------------------------------------------------------------ customer projections
/** What a customer may call the status. Internal routing states are never disclosed. */
export function customerStatus(s) {
  return ({ NEW: "OPEN", OPEN: "OPEN", IN_PROGRESS: "IN_PROGRESS", ESCALATED: "IN_PROGRESS", WAITING_FOR_INTERNAL: "IN_PROGRESS", WAITING_FOR_THIRD_PARTY: "IN_PROGRESS", WAITING_FOR_CUSTOMER: "WAITING_FOR_YOU", SOLVED: "SOLVED", CLOSED: "CLOSED", CANCELLED: "CANCELLED" })[s] || "OPEN";
}

/** Tickets a portal customer may see: their own, plus ones shared with them. */
export function customerAccessFilter(user) {
  const e = normEmail(user.email);
  const or = [{ "requester.email": e }, { "collaborators.email": e }];
  if (user._id) or.unshift({ "requester.portalUserId": user._id }); // never match on an undefined id (it would match every ticket with no portal user)
  return { $or: or };
}

export function customerListItem(t) {
  return { id: String(t._id), number: t.number, subject: t.subject, status: customerStatus(t.status), type: t.type, category: t.category, createdAt: t.createdAt, updatedAt: t.lastPublicActivityAt || t.updatedAt, solvedAt: t.solvedAt || null, canReopen: t.status === "SOLVED", sharedWithMe: false };
}

export async function listTicketsForCustomer({ orgId, user, status = null, limit = 50, skip = 0 }) {
  const { supportTickets } = await getSupportCollections();
  const filter = { $and: [{ orgId: toObjectId(orgId), deletedAt: null }, customerAccessFilter(user)] };
  if (status === "open") filter.$and.push({ status: { $in: OPEN_STATUSES } });
  else if (status === "resolved") filter.$and.push({ status: { $in: ["SOLVED", "CLOSED"] } });
  const [rows, total] = await Promise.all([supportTickets.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(Math.min(limit, 100)).project({ description: 0 }).toArray(), supportTickets.countDocuments(filter)]);
  const me = normEmail(user.email);
  const { supportMessages } = await getSupportCollections();
  const items = [];
  for (const t of rows) {
    const last = await supportMessages.findOne({ orgId: t.orgId, ticketId: t._id, visibility: "PUBLIC", kind: "REPLY" }, { sort: { createdAt: -1 }, projection: { body: 1, author: 1, createdAt: 1 } });
    items.push({ ...customerListItem(t), sharedWithMe: t.requester?.email !== me && (t.collaborators || []).some((c) => c.email === me), latestReply: last ? { at: last.createdAt, from: last.author?.type === "customer" ? "you" : "support", preview: String(last.body).slice(0, 140) } : null });
  }
  const counts = { open: 0, waiting: 0, solvedThisMonth: 0 };
  const all = await supportTickets.find({ $and: [{ orgId: toObjectId(orgId), deletedAt: null }, customerAccessFilter(user)] }).project({ status: 1, solvedAt: 1 }).limit(500).toArray();
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  for (const t of all) { if (OPEN_STATUSES.includes(t.status)) counts.open++; if (t.status === "WAITING_FOR_CUSTOMER") counts.waiting++; if (["SOLVED", "CLOSED"].includes(t.status) && (t.solvedAt || "") >= monthAgo) counts.solvedThisMonth++; }
  return { total, tickets: items, counts };
}

/** A ticket as the customer may see it. Returns null when it is not theirs: identical to "does not exist". */
export async function getTicketForCustomer({ orgId, user, ticketId, settings }) {
  const id = oidOf(ticketId);
  if (!id) return null;
  const { supportTickets, supportMessages, supportEvents, supportAttachments, supportCsat } = await getSupportCollections();
  const t = await supportTickets.findOne({ $and: [{ _id: id, orgId: toObjectId(orgId), deletedAt: null }, customerAccessFilter(user)] });
  if (!t) return null;
  const me = normEmail(user.email);
  const isRequester = t.requester?.email === me || String(t.requester?.portalUserId || "") === String(user._id);
  const collab = (t.collaborators || []).find((c) => c.email === me);
  const msgs = await supportMessages.find({ orgId: t.orgId, ticketId: t._id, visibility: "PUBLIC" }).sort({ createdAt: 1 }).limit(500).toArray();
  const atts = await supportAttachments.find({ orgId: t.orgId, ticketId: t._id, visibility: "PUBLIC" }).toArray();
  const events = await supportEvents.find({ orgId: t.orgId, ticketId: t._id, customerVisible: true }).sort({ createdAt: 1 }).limit(100).toArray();
  const csat = await supportCsat.findOne({ orgId: t.orgId, ticketId: t._id });
  return {
    id: String(t._id), number: t.number, subject: t.subject, status: customerStatus(t.status), type: t.type, category: t.category, createdAt: t.createdAt, updatedAt: t.lastPublicActivityAt || t.updatedAt, solvedAt: t.solvedAt || null,
    canReply: (isRequester || collab?.canReply) && t.status !== "CLOSED" && t.status !== "CANCELLED", canReopen: isRequester && (t.status === "SOLVED" || (t.status === "CLOSED" && Date.now() - Date.parse(t.closedAt || t.updatedAt) < settings.reopenWindowDays * 86400000)), canShare: isRequester,
    mergedInto: t.mergedInto ? (await supportTickets.findOne({ _id: t.mergedInto }, { projection: { number: 1 } }))?.number || null : null,
    messages: msgs.map((m) => ({ id: String(m._id), from: m.author?.type === "customer" ? (m.author.email === me ? "you" : "colleague") : m.author?.type === "system" ? "system" : "support", authorName: m.author?.type === "customer" ? (m.author.name || null) : m.author?.type === "system" ? null : "Support team", body: m.body, at: m.createdAt, attachments: (m.attachments || []).map(String), aiGenerated: false })),
    attachments: atts.map((a) => ({ id: String(a._id), filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes, messageId: a.messageId ? String(a.messageId) : null })),
    timeline: events.map((e) => ({ at: e.createdAt, type: e.type, to: e.data?.to ? customerStatus(e.data.to) : null })).filter((e) => e.to || ["ticket.solved", "ticket.reopened", "ticket.closed"].includes(e.type)),
    collaborators: isRequester ? (t.collaborators || []).map((c) => ({ email: c.email, canReply: !!c.canReply })) : undefined,
    satisfaction: csat ? { score: csat.score, comment: csat.comment || null } : null, canRate: settings.csat.enabled && ["SOLVED", "CLOSED"].includes(t.status) && !csat && isRequester,
    linkedInvoices: undefined,
  };
}

/** True when this staff member may see this ticket (same rule the list and detail views use). */
export async function agentCanSee({ orgId, membership, email, ticket }) {
  if (!supportPerms(membership).has("view_tickets")) return false;
  const vis = await visibilityFilter({ orgId, membership, email });
  if (!Object.keys(vis).length) return true;
  const { supportTickets } = await getSupportCollections();
  return !!(await supportTickets.findOne({ $and: [{ _id: ticket._id, orgId: ticket.orgId }, vis] }, { projection: { _id: 1 } }));
}
