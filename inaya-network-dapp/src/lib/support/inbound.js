// src/lib/support/inbound.js
//
// SOW §11, §42, §55, §60: email as a first-class intake channel, built so a message can NEVER be injected into
// somebody else's ticket.
//
//   1. The delivery is authenticated: HMAC-SHA256 over `${timestamp}.${rawBody}` with a per-organization secret,
//      within a 5-minute window (a forwarder in front of any mail provider signs it).
//   2. Idempotent: a unique ledger on (organization, Message-ID) means the same email delivered twice yields one
//      ticket / one reply, and the second delivery returns the first result.
//   3. Threading NEVER trusts the subject line or a guessed ticket number. A message joins a ticket only through
//      (a) a reply address whose signature (an HMAC only this server can make) verifies, or (b) In-Reply-To /
//      References headers that match a Message-ID we stored for that ticket.
//   4. Even then the SENDER must be a participant (the requester, or a collaborator who may reply) and the mail
//      must pass sender authentication (DMARC or DKIM) when the organization requires it. A stranger who replies
//      to a real thread is not appended: the message goes to a QUARANTINE list for an agent, and the event is
//      audited.
//   5. A new ticket is created only for a known customer (a CRM contact) with an authenticated mail; unknown
//      senders are quarantined (or created as clearly-marked unverified tickets if the organization chooses).
//   6. Auto-replies and bulk mail are recognised and ignored, so two auto-responders cannot loop.
//   7. HTML is reduced to plain text; quoted reply history is dropped; attachments pass the same policy checks
//      as portal uploads.

import { toObjectId } from "../orgs.js";
import { getSupportCollections, ensureSupportIndexes } from "./db.js";
import { fail, nowIso, normEmail, isEmail, parseAddress, sha256, hmacHex, safeEqualHex, toPlainText } from "./common.js";
import { getInboundSecret } from "./settings.js";
import { findContactByEmail } from "./customers.js";
import { createTicket, loadTicket, loadTicketByNumber, resolveMerged, relate } from "./tickets.js";
import { addReply, addNote } from "./messages.js";
import { addAttachment } from "./attachments.js";
import { ticketToken, notifyStaff } from "./notify.js";
import { audit, emit } from "./record.js";

const WINDOW_MS = 5 * 60 * 1000;

export async function verifyInboundSignature({ orgId, rawBody, timestamp, signature }) {
  const secret = await getInboundSecret(orgId);
  if (!secret) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts * 1000) > WINDOW_MS) return false;
  return safeEqualHex(signature, hmacHex(secret, `${timestamp}.${rawBody}`));
}

const TOKEN_RE = /\+([a-z]{2,8}-\d{3,9})-([A-Za-z0-9_-]{12})@/i;

function isAutoReply(m) {
  const h = Object.fromEntries(Object.entries(m.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v).toLowerCase()]));
  if (h["auto-submitted"] && h["auto-submitted"] !== "no") return true;
  if (["bulk", "junk", "list"].includes(h.precedence)) return true;
  if (h["x-auto-response-suppress"] || h["list-id"] || h["x-autoreply"] || h["x-autorespond"]) return true;
  if (/^(out of office|automatic reply|auto:|autoreply|undeliverable|delivery status notification)/i.test(String(m.subject || "").trim())) return true;
  return false;
}
const authPasses = (a) => a?.dmarc === "pass" || a?.dkim === "pass";

async function findThread({ orgId, message, secret }) {
  const { supportMessages } = await getSupportCollections();
  const addrs = [...(message.to || []), ...(message.cc || [])].map((x) => String(x));
  for (const a of addrs) {
    const m = a.match(TOKEN_RE);
    if (!m || !secret) continue;
    const t = await loadTicketByNumber(orgId, m[1]);
    if (t && safeEqualHex(Buffer.from(ticketToken(secret, t).split("-").slice(-1)[0]).toString("hex"), Buffer.from(m[2]).toString("hex"))) return { ticket: t, via: "reply-address" };
  }
  const ids = [message.inReplyTo, ...(Array.isArray(message.references) ? message.references : String(message.references || "").split(/\s+/))].map((x) => String(x || "").trim()).filter(Boolean);
  if (ids.length) {
    const found = await supportMessages.findOne({ orgId: toObjectId(orgId), messageIdHeader: { $in: ids } });
    if (found) { const t = await loadTicket(orgId, found.ticketId); if (t) return { ticket: t, via: "headers" }; }
  }
  return null;
}

async function quarantine({ orgId, inboundId, reason, message, ticket = null }) {
  const { supportInbound } = await getSupportCollections();
  await supportInbound.updateOne({ _id: inboundId }, { $set: { status: "QUARANTINED", reason, ticketId: ticket?._id || null, held: { fromEmail: parseAddress(message.from).email, fromName: parseAddress(message.from).name, subject: toPlainText(message.subject, 200), text: toPlainText(message.text || message.html || "", 20000), attachmentsHeld: (message.attachments || []).length, receivedAt: message.receivedAt || nowIso() }, updatedAt: nowIso() } });
  await audit({ orgId, ticketId: ticket?._id || null, action: "EMAIL_QUARANTINED", actorEmail: parseAddress(message.from).email, metadata: { reason, ticket: ticket?.number || null } });
  await emit({ orgId, type: "email.quarantined", ticket, data: { reason }, actor: parseAddress(message.from).email });
  await notifyStaff({ orgId, emails: null, title: "An inbound email needs review", body: `Reason: ${reason}. From: ${parseAddress(message.from).email}`, dedupeKey: `support:quarantine:${inboundId}`, severity: "warning" });
  return { status: "QUARANTINED", reason };
}

async function attach({ orgId, settings, ticket, messageId, message, senderEmail }) {
  const results = [];
  for (const a of (message.attachments || []).slice(0, settings.attachments.maxPerMessage || 5)) {
    let buffer; try { buffer = Buffer.from(String(a.contentBase64 || ""), "base64"); } catch { continue; }
    const r = await addAttachment({ orgId, settings, ticketId: ticket._id, messageId, file: { filename: a.filename, buffer }, uploader: { type: "email", email: senderEmail }, visibility: "PUBLIC" });
    results.push(r.error ? { filename: a.filename, rejected: r.error } : { filename: a.filename, id: r.attachment.id });
  }
  return results;
}

/**
 * Processes one already-authenticated inbound delivery. Returns { status, ticketId?, reason?, duplicate? }.
 * message = { messageId, from, to[], cc[], subject, text, html, inReplyTo, references, headers, attachments[], auth:{spf,dkim,dmarc}, receivedAt }
 */
export async function processInbound({ orgId, settings, message }) {
  await ensureSupportIndexes();
  const { supportInbound } = await getSupportCollections();
  const oid = toObjectId(orgId);
  const sender = parseAddress(message.from);
  if (!isEmail(sender.email)) return fail("The message has no valid sender.", 400);
  const raw = `${message.text || ""}${message.html || ""}`;
  if (raw.length > settings.email.maxBytes) return fail("The message is too large.", 413);
  const messageId = String(message.messageId || `synthetic:${sha256(`${sender.email}|${message.subject}|${message.text}`)}`).slice(0, 300);
  let inbound;
  try {
    inbound = { orgId: oid, messageId, status: "PROCESSING", createdAt: nowIso() };
    inbound._id = (await supportInbound.insertOne(inbound)).insertedId;
  } catch (err) {
    if (err?.code === 11000) { const ex = await supportInbound.findOne({ orgId: oid, messageId }); return { status: ex?.status || "PROCESSING", ticketId: ex?.ticketId ? String(ex.ticketId) : null, reason: ex?.reason || null, duplicate: true }; }
    throw err;
  }
  const finish = async (fields) => { await supportInbound.updateOne({ _id: inbound._id }, { $set: { ...fields, updatedAt: nowIso() } }); return { ...fields, ticketId: fields.ticketId ? String(fields.ticketId) : null, inboundId: String(inbound._id) }; };

  if (isAutoReply(message)) return finish({ status: "IGNORED", reason: "AUTO_REPLY" });
  const authOk = !settings.email.requireAuthResults || authPasses(message.auth);
  const secret = await getInboundSecret(orgId);
  const thread = await findThread({ orgId, message, secret });

  if (thread) {
    const ticket = await resolveMerged(orgId, thread.ticket);
    const participant = ticket.requester?.email === sender.email || (ticket.collaborators || []).some((c) => c.email === sender.email && c.canReply);
    if (!participant || !authOk) { const q = await quarantine({ orgId, inboundId: inbound._id, reason: !participant ? "SENDER_NOT_PARTICIPANT" : "SENDER_NOT_AUTHENTICATED", message, ticket }); return finish({ ...q, ticketId: ticket._id }); }
    const r = await addReply({ orgId, settings, ticketId: ticket._id, author: { type: "email", email: sender.email, name: sender.name }, body: message.text || message.html || "", viaEmail: { messageId, inReplyTo: message.inReplyTo || null } });
    if (r.error && r.reasonCode === "TICKET_CLOSED") {
      const created = await createTicket({ orgId, settings, actor: { type: "email", email: sender.email, name: sender.name }, requester: { email: ticket.requester.email, name: ticket.requester.name, portalUserId: ticket.requester.portalUserId }, subject: message.subject || `Follow-up to ${ticket.number}`, description: toPlainText(message.text || message.html || "", 20000) || "(no text)", channel: "EMAIL", type: ticket.type, category: ticket.category, emailMeta: { messageId, inReplyTo: message.inReplyTo } });
      if (created.error) return finish({ status: "FAILED", reason: created.error });
      await relate({ orgId, fromId: created.ticket._id, toId: ticket._id, type: "follow_up", actor: { email: sender.email } });
      return finish({ status: "PROCESSED", ticketId: created.ticket._id, action: "FOLLOW_UP_CREATED" });
    }
    if (r.error) return finish({ status: "FAILED", reason: r.error, ticketId: ticket._id });
    const att = await attach({ orgId, settings, ticket, messageId: r.message.id, message, senderEmail: sender.email });
    return finish({ status: "PROCESSED", ticketId: ticket._id, action: "REPLY_ADDED", threadedBy: thread.via, attachments: att });
  }

  // no thread: a NEW ticket, only for someone we can identify
  const contact = await findContactByEmail(orgId, sender.email);
  if (!contact && settings.email.unknownSenders !== "create_unverified") { const q = await quarantine({ orgId, inboundId: inbound._id, reason: "UNKNOWN_SENDER", message }); return finish(q); }
  if (!authOk) { const q = await quarantine({ orgId, inboundId: inbound._id, reason: "SENDER_NOT_AUTHENTICATED", message }); return finish(q); }
  const created = await createTicket({ orgId, settings, actor: { type: "email", email: sender.email, name: sender.name }, requester: { email: sender.email, name: sender.name }, subject: message.subject || "(no subject)", description: toPlainText(message.text || message.html || "", 20000) || "(no text)", channel: "EMAIL", unverified: !contact, emailMeta: { messageId, inReplyTo: message.inReplyTo }, idempotencyKey: `email:${messageId}` });
  if (created.error) return finish({ status: "FAILED", reason: created.error });
  const { supportMessages } = await getSupportCollections();
  const first = await supportMessages.findOne({ orgId: oid, ticketId: created.ticket._id, initial: true });
  const att = first ? await attach({ orgId, settings, ticket: created.ticket, messageId: first._id, message, senderEmail: sender.email }) : [];
  return finish({ status: "PROCESSED", ticketId: created.ticket._id, action: "TICKET_CREATED", attachments: att });
}

// ----------------------------------------------------------- quarantine management (agents)
export async function listInbound({ orgId, status = "QUARANTINED", limit = 50 }) {
  const { supportInbound } = await getSupportCollections();
  const rows = await supportInbound.find({ orgId: toObjectId(orgId), status }).sort({ createdAt: -1 }).limit(Math.min(limit, 200)).toArray();
  return { items: rows.map((r) => ({ id: String(r._id), status: r.status, reason: r.reason || null, from: r.held?.fromEmail || null, subject: r.held?.subject || null, preview: String(r.held?.text || "").slice(0, 300), ticketId: r.ticketId ? String(r.ticketId) : null, createdAt: r.createdAt })) };
}

/** An agent decides a quarantined message IS legitimate: it becomes a new (or appended) ticket. Audited. */
export async function acceptInbound({ orgId, settings, inboundId, actor, appendToTicketId = null }) {
  const { supportInbound } = await getSupportCollections();
  let row; try { row = await supportInbound.findOne({ _id: toObjectId(inboundId), orgId: toObjectId(orgId), status: "QUARANTINED" }); } catch { row = null; }
  if (!row) return fail("That message is not in quarantine.", 404);
  const held = row.held;
  let result;
  if (appendToTicketId) {
    const t = await loadTicket(orgId, appendToTicketId);
    if (!t) return fail("Ticket not found.", 404);
    // appended as an INTERNAL note: the sender was not a verified participant, so it must not appear in the customer's thread
    result = await addNote({ orgId, settings, ticketId: t._id, author: { email: actor.email }, body: `Quarantined email accepted by ${actor.email}. Sender: ${held.fromEmail}

${held.text}` });
    if (!result.error) result.ticket = t;
  } else {
    result = await createTicket({ orgId, settings, actor: { type: "agent", email: actor.email, staff: true }, requester: { email: held.fromEmail, name: held.fromName }, subject: held.subject || "(no subject)", description: held.text || "(no text)", channel: "EMAIL", unverified: !(await findContactByEmail(orgId, held.fromEmail)) });
  }
  if (result.error) return result;
  await supportInbound.updateOne({ _id: row._id }, { $set: { status: "PROCESSED", acceptedBy: actor.email, ticketId: result.ticket?._id || row.ticketId, updatedAt: nowIso() } });
  await audit({ orgId, ticketId: result.ticket?._id || null, action: "EMAIL_QUARANTINE_ACCEPTED", actorEmail: actor.email, metadata: { from: held.fromEmail } });
  return { ticketId: result.ticket ? String(result.ticket._id) : null };
}
export async function dismissInbound({ orgId, inboundId, actor }) {
  const { supportInbound } = await getSupportCollections();
  let r; try { r = await supportInbound.findOneAndUpdate({ _id: toObjectId(inboundId), orgId: toObjectId(orgId), status: "QUARANTINED" }, { $set: { status: "DISMISSED", dismissedBy: actor.email, updatedAt: nowIso() } }); } catch { r = null; }
  if (!r) return fail("That message is not in quarantine.", 404);
  await audit({ orgId, action: "EMAIL_QUARANTINE_DISMISSED", actorEmail: actor.email, metadata: { from: r.held?.fromEmail } });
  return { dismissed: true };
}
