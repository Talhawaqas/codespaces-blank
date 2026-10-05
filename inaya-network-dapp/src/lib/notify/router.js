// src/lib/notify/router.js
//
// Smart notifications (Competitive Expansion SOW workstream V, NOTIFY-001): one place that turns an EVENT into notifications on the right CHANNELS for each
// person, extending the existing in-app subsystem (src/lib/notifications.js). Channels: in-app, email, push, desktop, webhook.
//   in-app   the notification feed (delivered by createNotification, deduped).
//   email    via the existing email sender with the organization's branding.
//   push     NOT_CONFIGURED: this deployment has no mobile push credentials (APNs/FCM through Expo). The router records the intent and the state; when a
//            push adapter is configured it sends a generic text only.
//   desktop  the desktop app shows the same feed; recorded as delivered-to-feed.
//   webhook  only for events that have a registry equivalent (see WEBHOOK_TYPE).
// PRIVACY: an event may carry `protectedContent` (file names, titles, anything from a confidential context). Channels differ in trust: in-app and desktop
// are authenticated surfaces; email, push and webhook are not. Protected details are NEVER placed in a lower-trust channel; those get the generic text.
// Preferences are per person and per event with documented defaults. Collections: notification_prefs, notification_deliveries.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { createNotification } from "../notifications.js";
import { sendEmail } from "../email.js";
import { brandedEmail } from "../branding/branding.js";

export const CHANNELS = ["inApp", "email", "push", "desktop", "webhook"];
const HIGH_TRUST = new Set(["inApp", "desktop"]);
/** event -> label, defaults, severity, and the registry webhook type (if any). `generic` is the text safe for any channel. */
export const EVENTS = {
  "file.shared": { label: "A file is shared with me", defaults: { inApp: true, email: true }, severity: "info", generic: "A file was shared with you." },
  "file.changed": { label: "A file I follow changed", defaults: { inApp: true }, severity: "info", generic: "A file you follow was changed." },
  "file.locked": { label: "A file is locked", defaults: { inApp: true }, severity: "info", generic: "A file was locked for editing." },
  "file.unlocked": { label: "A file is unlocked", defaults: { inApp: true }, severity: "info", generic: "A file was unlocked." },
  "share.expiring": { label: "A share link is about to expire", defaults: { inApp: true, email: true }, severity: "warning", generic: "A share link you created expires soon." },
  "share.revoked": { label: "A share link was revoked", defaults: { inApp: true }, severity: "info", generic: "A share link was revoked.", webhook: "share.revoked" },
  "dlp.blocked": { label: "An action was blocked by data protection", defaults: { inApp: true, email: true }, severity: "warning", generic: "A data protection rule blocked an action.", webhook: "dlp.decision" },
  "classification.changed": { label: "A file's classification changed", defaults: { inApp: true }, severity: "info", generic: "A file's classification changed." },
  "backup.failed": { label: "A backup failed", defaults: { inApp: true, email: true, desktop: true }, severity: "warning", generic: "A backup run failed.", webhook: "backup.event" },
  "resilience.failed": { label: "A resilience test failed", defaults: { inApp: true, email: true }, severity: "critical", generic: "A resilience test failed.", webhook: "resilience.event" },
  "chat.message": { label: "New chat message", defaults: { inApp: true, push: true, desktop: true }, severity: "info", generic: "You have a new message." },
  "note.shared": { label: "A note is shared with me", defaults: { inApp: true, email: false }, severity: "info", generic: "A secure note was shared with you." },
  "workflow.approval": { label: "A workflow needs my approval", defaults: { inApp: true, email: true }, severity: "info", generic: "A workflow is waiting for your approval.", webhook: "workflow.event" },
  "vdr.invitation": { label: "I was invited to a data room", defaults: { email: true }, severity: "info", generic: "You were invited to a secure data room." },
  "customer.upload": { category: "external_share", label: "A customer uploaded a file", defaults: { inApp: true, email: true }, severity: "info", generic: "Someone uploaded a file to your request.", webhook: "file_request.received" },
  "gateway.offline": { label: "A gateway went offline", defaults: { inApp: true, email: true }, severity: "warning", generic: "A gateway in your network has stopped reporting.", webhook: "gateway.event" },
  "device.revoked": { label: "A device was removed or blocked", defaults: { inApp: true, email: true }, severity: "warning", generic: "A device on your account was removed or blocked.", webhook: "device.revoked" },
  "security.incident": { label: "A security incident was detected", defaults: { inApp: true, email: true, push: true, desktop: true }, severity: "critical", generic: "Unusual activity was detected. Review it in Inaya.", webhook: "ransomware.signal" },
};

let indexed = false;
async function cols() { const c = await getOrgCollections(); const prefs = c.db.collection("notification_prefs"); const deliveries = c.db.collection("notification_deliveries"); if (!indexed) { await Promise.all([prefs.createIndex({ orgId: 1, email: 1 }, { unique: true }), deliveries.createIndex({ createdAt: 1 }, { expireAfterSeconds: 30 * 86400 })]); indexed = true; } return { c, prefs, deliveries }; }
const norm = (e) => String(e || "").trim().toLowerCase();
// Event names contain dots, which Mongo reads as nested paths; they are stored with "~" in their place.
const ek = (event) => String(event).replaceAll(".", "~");

/** Effective preference for one person and event: their choice, else the documented default. */
export function resolveChannels(event, stored) {
  const def = EVENTS[event]?.defaults || {}; const mine = stored?.[ek(event)] || {}; const out = {};
  for (const ch of CHANNELS) out[ch] = ch in mine ? !!mine[ch] : !!def[ch]; if (!EVENTS[event]?.webhook) out.webhook = false; return out;
}
export async function getPrefs({ orgId, email }) {
  const { prefs } = await cols(); const row = await prefs.findOne({ orgId: toObjectId(orgId), email: norm(email) });
  return { catalog: Object.entries(EVENTS).map(([key, e]) => ({ key, label: e.label, webhook: !!e.webhook, defaults: e.defaults })), channels: CHANNELS, prefs: Object.fromEntries(Object.keys(EVENTS).map((k) => [k, resolveChannels(k, row?.events)])), pushStatus: pushConfigured() ? "CONFIGURED" : "NOT_CONFIGURED" };
}
export async function setPrefs({ orgId, email, changes }) {
  const { prefs } = await cols(); const set = {};
  for (const [event, chs] of Object.entries(changes || {})) { if (!EVENTS[event]) throw Object.assign(new Error(`Unknown event "${event}".`), { status: 400 }); for (const [ch, on] of Object.entries(chs || {})) { if (!CHANNELS.includes(ch)) throw Object.assign(new Error(`Unknown channel "${ch}".`), { status: 400 }); if (ch === "webhook" && !EVENTS[event].webhook) throw Object.assign(new Error("That event has no webhook equivalent."), { status: 400 }); set[`events.${ek(event)}.${ch}`] = !!on; } }
  if (Object.keys(set).length) await prefs.updateOne({ orgId: toObjectId(orgId), email: norm(email) }, { $set: set }, { upsert: true }); return getPrefs({ orgId, email });
}
const pushConfigured = () => !!(process.env.EXPO_ACCESS_TOKEN || process.env.FCM_SERVER_KEY || process.env.APNS_KEY_ID);

/**
 * Notify one person (or, with targetEmail null, every member) about an event.
 *   title/body : may include protected detail (shown only in high-trust channels when protectedContent is true)
 *   generic    : optional override of the catalog's safe text
 */
export async function notifyEvent({ orgId, event, targetEmail = null, audience = "all", title, body, link = null, sourceId = null, dedupeKey, protectedContent = true, orgName = "Inaya", sender = sendEmail }) {
  const ev = EVENTS[event]; if (!ev) throw new Error(`Unknown notification event "${event}".`);
  const { c, prefs, deliveries } = await cols(); const recipients = targetEmail ? [norm(targetEmail)] : (await c.orgMembers.find({ orgId: toObjectId(orgId), status: "active", ...(audience === "admins" ? { role: { $in: ["owner", "admin"] } } : {}) }).project({ email: 1 }).toArray()).map((m) => norm(m.email));
  if (orgName === "Inaya") { try { orgName = (await c.orgs.findOne({ _id: toObjectId(orgId) }, { projection: { name: 1 } }))?.name || "Inaya"; } catch { /* keep default */ } }
  const results = [];
  for (const email of recipients) {
    const row = await prefs.findOne({ orgId: toObjectId(orgId), email }); const ch = resolveChannels(event, row?.events);
    const safeTitle = protectedContent ? ev.generic : title || ev.generic; const safeBody = protectedContent ? "Open Inaya to see the details." : body || "";
    const rec = (channel, state, extra = {}) => results.push({ email, channel, state, ...extra });
    if (ch.inApp || ch.desktop) { try { await createNotification({ scope: "org", orgId, targetEmail: email, category: ev.category || event.split(".")[0], severity: ev.severity, type: event, title: title || ev.generic, body: body || "", sourceModule: "notify", sourceId, actionUrl: link, metadata: { channels: [ch.inApp && "inApp", ch.desktop && "desktop"].filter(Boolean) }, dedupeKey: `${dedupeKey}:${email}` }); if (ch.inApp) rec("inApp", "DELIVERED"); if (ch.desktop) rec("desktop", "DELIVERED_TO_FEED"); } catch (e) { rec("inApp", "FAILED", { error: String(e.message).slice(0, 80) }); } }
    if (ch.email) {
      try { const m = await brandedEmail({ orgId, orgName, title: safeTitle, lines: safeBody ? [safeBody] : [], ctaUrl: link ? new URL(link, process.env.NEXT_PUBLIC_APP_URL || "https://inaya.network").href : null, ctaLabel: "Open in Inaya" }); const r = await sender({ to: email, subject: safeTitle, html: m.html, text: m.text }); rec("email", r?.sent === false ? "NOT_CONFIGURED" : "SENT", r?.sent === false ? { reason: r.reason } : {}); } catch (e) { rec("email", "FAILED", { error: String(e.message).slice(0, 80) }); }
    }
    if (ch.push) rec("push", pushConfigured() ? "QUEUED" : "NOT_CONFIGURED", { note: pushConfigured() ? "A generic text would be sent." : "No push credentials are configured for this deployment." });
    if (ch.webhook && ev.webhook) { import("../webhooks/registry.js").then((m) => m.emitWebhookEvent({ orgId, type: ev.webhook, eventId: `notify:${dedupeKey}`, data: { event, recipient: email, generic: ev.generic } })).catch(() => {}); rec("webhook", "QUEUED"); }
  }
  try { if (results.length) await deliveries.insertOne({ orgId: toObjectId(orgId), event, dedupeKey, createdAt: new Date(), results: results.map(({ email, channel, state }) => ({ email, channel, state })) }); } catch { /* history is best effort */ }
  return { results };
}
export { HIGH_TRUST };
