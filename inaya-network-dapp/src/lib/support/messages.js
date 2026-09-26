// src/lib/support/messages.js
//
// SOW §10.4, §12.3, §20, §11.2: public replies and internal notes.
//
//   PUBLIC replies are what the customer sees (portal + email); INTERNAL notes are stored with visibility
//   "INTERNAL" and are excluded by every customer-facing projection (tickets.js) and by the agent view for
//   anyone without the create_notes permission. Message bodies are stored as plain text.
//   A first public reply by an agent stops the first-response clock; a customer reply resumes a paused clock
//   and reopens a solved ticket (inside the reopen window); a reply on a CLOSED ticket is refused with a clear
//   path to a follow-up request. Outbound customer emails carry safe threading headers.

import { toObjectId, getOrgCollections } from "../orgs.js";
import { getSupportCollections } from "./db.js";
import { fail, nowIso, normEmail, isEmail, toPlainText, stripQuotedReply } from "./common.js";
import { mutate, loadTicket, transition, reopen, calOf, customerAccessFilter, oidOf } from "./tickets.js";
import { onFirstResponse, evaluateSla } from "./sla.js";
import { audit, emit } from "./record.js";
import { notifyStaff, notifyCustomer, portalUrl, emailBody, outboundMessageId, replyToAddress } from "./notify.js";
import { supportPerms } from "./access.js";

const MAX_BODY = 20000;

/** Is this customer allowed to write on this ticket? (requester, or a collaborator with reply rights.) */
export function customerMayReply(ticket, email) {
  const e = normEmail(email);
  if (ticket.requester?.email === e) return true;
  return (ticket.collaborators || []).some((c) => c.email === e && c.canReply);
}

async function lastHeaderId(ticket) {
  const { supportMessages } = await getSupportCollections();
  const m = await supportMessages.findOne({ orgId: ticket.orgId, ticketId: ticket._id, visibility: "PUBLIC", messageIdHeader: { $type: "string" } }, { sort: { createdAt: -1 }, projection: { messageIdHeader: 1 } });
  return m?.messageIdHeader || null;
}

/**
 * Adds a PUBLIC reply. author = { type: customer|agent|api|email|ai, email, name?, portalUserId? }.
 * `viaEmail` = { messageId, inReplyTo } for inbound email. `setStatus` (agent only) moves the ticket after the reply.
 */
export async function addReply({ orgId, settings, ticketId, author, body, setStatus = null, viaEmail = null, aiGenerated = false }) {
  const ticket0 = await loadTicket(orgId, ticketId);
  if (!ticket0) return fail("Ticket not found.", 404);
  const isCustomer = author.type === "customer" || author.type === "email";
  let text = toPlainText(viaEmail ? stripQuotedReply(toPlainText(body, MAX_BODY * 2)) : body, MAX_BODY);
  if (!text) return fail("A message is required.");
  if (isCustomer && !customerMayReply(ticket0, author.email)) return fail("Ticket not found.", 404);
  if (ticket0.status === "CLOSED" || ticket0.status === "CANCELLED") return fail(isCustomer ? "This request is closed. Please open a follow-up request and we will link it to this one." : "A closed ticket cannot be replied to. Reopen it first.", 409, { reasonCode: "TICKET_CLOSED" });
  if (ticket0.mergedInto) return fail("This ticket was merged into another; reply there.", 409, { reasonCode: "MERGED" });
  const { supportMessages } = await getSupportCollections();
  const msg = { orgId: ticket0.orgId, ticketId: ticket0._id, visibility: "PUBLIC", kind: "REPLY", author: { type: author.type, email: normEmail(author.email), name: author.name || null, portalUserId: author.portalUserId ? toObjectId(author.portalUserId) : null }, body: text, attachments: [], createdAt: nowIso(), ...(aiGenerated ? { aiGenerated: true } : {}), ...(viaEmail ? { viaEmail: true, messageIdHeader: viaEmail.messageId || null, inReplyTo: viaEmail.inReplyTo || null } : {}) };
  msg._id = (await supportMessages.insertOne(msg)).insertedId;
  if (!isCustomer) { const { orgId: _o, ...rest } = msg; msg.messageIdHeader = outboundMessageId(settings, ticket0._id, msg._id); await supportMessages.updateOne({ _id: msg._id }, { $set: { messageIdHeader: msg.messageIdHeader } }); }

  const res = await mutate({ orgId, ticketId, fn: async (t) => {
    const set = { lastPublicActivityAt: nowIso() };
    if (isCustomer) set.lastCustomerMessageAt = nowIso();
    else {
      if (!t.firstResponseAt && t.sla !== undefined) { set.firstResponseAt = nowIso(); if (t.sla) { const sla = onFirstResponse(t.sla, { cal: calOf(t, settings) }); set.sla = sla; set.slaState = evaluateSla(sla, { cal: calOf(t, settings), settings }).state; } }
      if (!t.assigneeEmail && author.type === "agent") set.assigneeEmail = normEmail(author.email);
    }
    return { set };
  } });
  if (res.error) return res;
  let ticket = res.ticket;

  // status effects
  if (isCustomer) {
    if (ticket.status === "SOLVED") { const r = await reopen({ orgId, settings, ticketId, actor: { type: "customer", email: author.email }, reason: "Customer replied" }); if (!r.error) ticket = r.ticket; }
    else if (ticket.status === "WAITING_FOR_CUSTOMER") { const r = await transition({ orgId, settings, ticketId, to: "OPEN", actor: { type: "customer", email: author.email }, reason: "Customer replied" }); if (!r.error) ticket = r.ticket; }
  } else {
    if (ticket.status === "NEW") { const r = await transition({ orgId, settings, ticketId, to: "OPEN", actor: { type: author.type, email: author.email }, reason: "First reply" }); if (!r.error) ticket = r.ticket; }
    if (setStatus && setStatus !== ticket.status) { const r = await transition({ orgId, settings, ticketId, to: setStatus, actor: { type: author.type, email: author.email }, reason: "Set with reply" }); if (r.error) return { ...r, message: messageOut(msg), ticket }; ticket = r.ticket; }
  }

  await audit({ orgId, ticketId: ticket._id, action: isCustomer ? "TICKET_CUSTOMER_REPLIED" : "TICKET_REPLIED", actorEmail: author.email, metadata: { number: ticket.number, via: viaEmail ? "email" : author.type, ai: !!aiGenerated, firstResponse: !isCustomer && !ticket0.firstResponseAt } });
  await emit({ orgId, type: isCustomer ? "ticket.customer_replied" : "ticket.replied", ticket, actor: author.email, data: { messageId: String(msg._id), via: viaEmail ? "email" : author.type }, customerVisible: false });

  if (isCustomer) {
    await notifyStaff({ orgId, emails: ticket.assigneeEmail ? [ticket.assigneeEmail] : null, title: `Customer replied on ${ticket.number}`, body: text.slice(0, 200), ticket, dedupeKey: `support:custreply:${msg._id}` });
  } else if (!ticket.requester?.unverified) {
    const inReplyTo = await lastHeaderId({ ...ticket, _id: ticket._id });
    const headers = { "Message-ID": msg.messageIdHeader, ...(inReplyTo && inReplyTo !== msg.messageIdHeader ? { "In-Reply-To": inReplyTo, References: inReplyTo } : {}) };
    const replyTo = await replyToAddress({ orgId, settings, ticket });
    const recipients = [ticket.requester.email, ...(ticket.collaborators || []).map((c) => c.email)];
    for (const to of [...new Set(recipients)]) {
      await notifyCustomer({ orgId, settings, to: { email: to, portalUserId: to === ticket.requester.email ? ticket.requester.portalUserId : null }, type: "ticket_reply", ticket, title: `New reply on ${ticket.number}`, body: text.slice(0, 300), dedupeKey: `support:reply:${msg._id}:${to}`, email: { subject: `[${ticket.number}] ${ticket.subject}`, ...emailBody({ heading: `New reply on ${ticket.number}`, message: text, linkUrl: portalUrl(settings, `?ticket=${ticket._id}`), linkLabel: "View the conversation", footer: replyTo ? "You can reply directly to this email." : "" }), headers, replyTo: replyTo || undefined } });
    }
  }
  return { message: messageOut(msg), ticket, firstResponse: !isCustomer && !ticket0.firstResponseAt };
}

const messageOut = (m) => ({ id: String(m._id), visibility: m.visibility, kind: m.kind, body: m.body, createdAt: m.createdAt, author: { type: m.author?.type, email: m.author?.email } });

const MENTION_RE = /@([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/** Adds an INTERNAL note (never visible to customers). Mentioned colleagues are notified and start following. */
export async function addNote({ orgId, settings, ticketId, author, body }) {
  const ticket0 = await loadTicket(orgId, ticketId);
  if (!ticket0) return fail("Ticket not found.", 404);
  const text = toPlainText(body, MAX_BODY);
  if (!text) return fail("A note is required.");
  const { supportMessages } = await getSupportCollections();
  const msg = { orgId: ticket0.orgId, ticketId: ticket0._id, visibility: "INTERNAL", kind: "NOTE", author: { type: "agent", email: normEmail(author.email), name: author.name || null }, body: text, attachments: [], createdAt: nowIso() };
  msg._id = (await supportMessages.insertOne(msg)).insertedId;
  const mentions = [...new Set([...text.matchAll(MENTION_RE)].map((m) => normEmail(m[1])))].slice(0, 10);
  let mentioned = [];
  if (mentions.length) {
    const { orgMembers } = await getOrgCollections();
    const members = await orgMembers.find({ orgId: ticket0.orgId, email: { $in: mentions }, status: "active" }).toArray();
    mentioned = members.filter((m) => supportPerms(m).has("view_tickets")).map((m) => m.email);
  }
  const res = await mutate({ orgId, ticketId, fn: async (t) => (mentioned.length ? { set: { followers: [...new Set([...(t.followers || []), ...mentioned])] } } : { set: {} }) });
  await audit({ orgId, ticketId: ticket0._id, action: "TICKET_NOTE_ADDED", actorEmail: author.email, metadata: { number: ticket0.number, mentions: mentioned.length } });
  await emit({ orgId, type: "ticket.note_added", ticket: res.ticket || ticket0, actor: author.email, data: { messageId: String(msg._id) }, customerVisible: false });
  if (mentioned.length) await notifyStaff({ orgId, emails: mentioned.filter((e) => e !== normEmail(author.email)), title: `You were mentioned on ${ticket0.number}`, body: text.slice(0, 200), ticket: ticket0, dedupeKey: `support:mention:${msg._id}` });
  const followers = (res.ticket?.followers || []).filter((e) => e !== normEmail(author.email) && !mentioned.includes(e));
  if (followers.length) await notifyStaff({ orgId, emails: followers, title: `New internal note on ${ticket0.number}`, body: text.slice(0, 200), ticket: ticket0, dedupeKey: `support:note:${msg._id}` });
  return { message: messageOut(msg), mentioned };
}
