// src/lib/support/notify.js
//
// SOW §20, §21: notifications.
//   - People INSIDE the organization (agents, team leads, managers) are notified through the existing
//     notification system (createNotification, unique dedupeKey), so a retry never notifies twice.
//   - CUSTOMERS are neither organization members nor wallets, so the existing system cannot address them.
//     They get the same discipline in a small store (unique dedupeKey per organization) plus an email through
//     the existing sendEmail. Preferences are honoured, except security notices, which cannot be disabled.
// Nothing here ever includes internal notes, internal routing or AI reasoning.

import { createNotification } from "../notifications.js";
import { sendEmail } from "../email.js";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { getSupportCollections } from "./db.js";
import { nowIso, normEmail } from "./common.js";
import { hmacHex } from "./common.js";
import { getInboundSecret, ensureInboundSecret } from "./settings.js";

export const APP_URL = () => (process.env.NEXT_PUBLIC_APP_URL || "https://www.inayanetwork.com").replace(/\/$/, "");
export const portalUrl = (settings, path = "") => `${APP_URL()}/portal/${settings.portalSlug || ""}${path}`;

/** Category of a customer notification, for the preference check. "security" can never be turned off. */
export const CUSTOMER_NOTIFICATION_CATEGORY = {
  ticket_created: "ticketUpdates", ticket_reply: "ticketUpdates", ticket_status: "ticketUpdates", ticket_reply_requested: "ticketUpdates", ticket_solved: "ticketUpdates", ticket_closed: "ticketUpdates",
  sla_update: "ticketUpdates", invoice_link: "ticketUpdates", idea_status: "ideaUpdates", kb_update: "kbSubscriptions", announcement: "productAnnouncements", security: "security", login: "security",
};
export const DEFAULT_PREFS = { ticketUpdates: true, productAnnouncements: false, ideaUpdates: true, kbSubscriptions: false, security: true };

/** Notifies members of the organization. `emails` = specific people; null = every owner/admin. Never throws. */
export async function notifyStaff({ orgId, emails = null, title, body, ticket = null, dedupeKey, severity = "info", type = "support" }) {
  try {
    let targets = emails;
    if (!targets) {
      const { orgMembers } = await getOrgCollections();
      targets = (await orgMembers.find({ orgId: toObjectId(orgId), status: "active", $or: [{ role: { $in: ["owner", "admin"] } }, { supportRole: "manager" }] }).project({ email: 1 }).toArray()).map((m) => m.email);
    }
    for (const t of [...new Set(targets.map(normEmail))]) {
      await createNotification({ scope: "org", orgId, targetEmail: t, category: "support", severity, type, title, body: String(body || "").slice(0, 500), sourceModule: "support", sourceId: ticket ? String(ticket._id) : null, actionUrl: ticket ? `/business?view=support&ticket=${ticket._id}` : "/business?view=support", metadata: { ticketNumber: ticket?.number || null }, dedupeKey: `${dedupeKey}:${t}` });
    }
    return { notified: targets.length };
  } catch (err) { console.error("support notifyStaff failed (non-fatal):", err.message); return { notified: 0 }; }
}

/**
 * Notifies a customer (in the portal and by email). `to` = { email, portalUserId?, prefs? }.
 * Returns { created, emailed }. `created` is false when this dedupeKey was already sent (a retry).
 */
export async function notifyCustomer({ orgId, settings, to, type, ticket = null, title, body, dedupeKey, email = null, force = false }) {
  try {
    const { supportCustomerNotifications, supportPortalUsers } = await getSupportCollections();
    const oid = toObjectId(orgId);
    let user = null;
    if (to.portalUserId) user = await supportPortalUsers.findOne({ _id: toObjectId(to.portalUserId), orgId: oid });
    else if (to.email) user = await supportPortalUsers.findOne({ orgId: oid, email: normEmail(to.email) });
    const category = CUSTOMER_NOTIFICATION_CATEGORY[type] || "ticketUpdates";
    const prefs = { ...DEFAULT_PREFS, ...(user?.prefs?.notifications || {}) };
    const wants = category === "security" || force || prefs[category] !== false;
    if (!wants) return { created: false, emailed: false, skipped: "preference" };
    const doc = { orgId: oid, portalUserId: user?._id || null, email: normEmail(to.email || user?.email), type, ticketId: ticket?._id || null, title: String(title).slice(0, 200), body: String(body || "").slice(0, 1000), dedupeKey, createdAt: nowIso(), readAt: null, emailStatus: "NONE" };
    try { await supportCustomerNotifications.insertOne(doc); } catch (err) { if (err?.code === 11000) return { created: false, emailed: false, skipped: "duplicate" }; throw err; }
    let emailed = false;
    if (email && isEmailish(doc.email)) {
      const r = await sendEmail({ to: doc.email, subject: email.subject, html: email.html, text: email.text, headers: email.headers, replyTo: email.replyTo });
      emailed = r.sent === true;
      await supportCustomerNotifications.updateOne({ orgId: oid, dedupeKey }, { $set: { emailStatus: emailed ? "SENT" : `NOT_SENT:${r.reason || "unknown"}` } });
    }
    return { created: true, emailed };
  } catch (err) { console.error("support notifyCustomer failed (non-fatal):", err.message); return { created: false, emailed: false, error: err.message }; }
}
const isEmailish = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || "");

export function escapeHtml(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

/** A consistent, safe email body: plain-text message, the ticket reference and a link. */
export function emailBody({ heading, message, linkUrl, linkLabel = "Open the request", footer = "" }) {
  const text = `${heading}\n\n${message}\n\n${linkLabel}: ${linkUrl}${footer ? `\n\n${footer}` : ""}`;
  const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:560px"><h2 style="margin:0 0 12px">${escapeHtml(heading)}</h2><p style="white-space:pre-wrap;line-height:1.5">${escapeHtml(message)}</p><p><a href="${escapeHtml(linkUrl)}">${escapeHtml(linkLabel)}</a></p>${footer ? `<p style="color:#666;font-size:12px">${escapeHtml(footer)}</p>` : ""}</div>`;
  return { text, html };
}

// ------------------------------------------------------------- email threading ids
/**
 * The address customers reply to. The organization's own support address if it set one; otherwise, when the platform
 * has an inbound-mail domain (SUPPORT_INBOUND_DOMAIN), `<portal address>@<that domain>`, which needs no setup by the organization.
 */
export function supportAddressOf(settings) {
  if (settings?.email?.supportAddress) return String(settings.email.supportAddress);
  const d = process.env.SUPPORT_INBOUND_DOMAIN;
  return d && settings?.portalSlug ? `${settings.portalSlug}@${d}` : null;
}
const domainOf = (settings) => (supportAddressOf(settings) ? String(supportAddressOf(settings)).split("@")[1] : "inayanetwork.com") || "inayanetwork.com";
export const outboundMessageId = (settings, ticketId, messageId) => `<tkt.${ticketId}.${messageId}@${domainOf(settings)}>`;

/** support+tkt-1042-<sig>@domain: the reply address that lets an inbound reply be tied to ONE ticket. */
export async function replyToAddress({ orgId, settings, ticket }) {
  const addr = supportAddressOf(settings);
  if (!addr) return null;
  let secret = await getInboundSecret(orgId);
  if (!secret && await ensureInboundSecret(orgId)) secret = await getInboundSecret(orgId);
  if (!secret) return addr; // threading then relies on In-Reply-To alone, which is still sender-checked
  const [local, domain] = String(addr).split("@");
  return `${local}+${ticketToken(secret, ticket)}@${domain}`;
}
export function ticketToken(secret, ticket) { return `${String(ticket.number).toLowerCase()}-${hmacHex(secret, `ticket:${ticket._id}`).slice(0, 12)}`; }
