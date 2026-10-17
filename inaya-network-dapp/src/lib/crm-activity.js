// src/lib/crm-activity.js
//
// Business Workspace gap closure, Batch 2 — CRM depth: a per-contact
// activity history (notes, calls, meetings, emails), an explainable lead
// score, email from the CRM, and calendar invites.
//
// Lead score (0-100) is a fixed, published rule set — no AI, no hidden
// weights — and every point awarded comes back as a reason:
//   details   email 10, phone 5, company 10                      (max 25)
//   stage     best open deal NEW 5 / QUALIFIED 15 / PROPOSAL 25 /
//             NEGOTIATION 30                                     (max 30)
//   value     open pipeline >= 1k 5 / >= 10k 10 / >= 50k 15      (max 15)
//   won       has a WON deal 15                                  (max 15)
//   activity  3+ in 14 days 15 / 1+ in 14 days 10 / any in 60 days 5 (max 15)
// Email is outbound only (no inbox sync); invites are RFC 5545 .ics files.

import { randomUUID } from "node:crypto";
import { getOrgCollections, toObjectId } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";
import { sendEmail } from "./email.js";
import { buildInvite } from "./ics.js";

export const ACTIVITY_TYPES = ["NOTE", "CALL", "MEETING", "EMAIL"];
const STAGE_POINTS = { NEW: 5, QUALIFIED: 15, PROPOSAL: 25, NEGOTIATION: 30 };
const OPEN_STAGES = Object.keys(STAGE_POINTS);
const DAY = 86400000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function computeLeadScore({ contact, deals = [], activityDates = [], now = Date.now() }) {
  const reasons = [];
  const award = (label, points) => { if (points > 0) reasons.push({ label, points }); };
  award("Has an email address", contact.email ? 10 : 0);
  award("Has a phone number", contact.phone ? 5 : 0);
  award("Company is known", contact.company ? 10 : 0);

  const open = deals.filter((d) => OPEN_STAGES.includes(d.status));
  const best = open.reduce((max, d) => Math.max(max, STAGE_POINTS[d.status] || 0), 0);
  const bestStage = OPEN_STAGES.find((s) => STAGE_POINTS[s] === best);
  award(`Open deal at ${bestStage} stage`, best);

  const pipeline = open.reduce((s, d) => s + (Number(d.value) || 0), 0);
  award(`Open pipeline of ${pipeline.toLocaleString("en-US")}`, pipeline >= 50000 ? 15 : pipeline >= 10000 ? 10 : pipeline >= 1000 ? 5 : 0);
  award("Has won a deal before", deals.some((d) => d.status === "WON") ? 15 : 0);

  const times = activityDates.map((d) => new Date(d).getTime()).filter(Number.isFinite);
  const recent = times.filter((t) => now - t <= 14 * DAY && t <= now + DAY).length;
  if (recent >= 3) award(`${recent} interactions in the last 14 days`, 15);
  else if (recent >= 1) award(`${recent} interaction${recent === 1 ? "" : "s"} in the last 14 days`, 10);
  else award("Contacted in the last 60 days", times.some((t) => now - t <= 60 * DAY) ? 5 : 0);

  const score = Math.min(100, reasons.reduce((s, r) => s + r.points, 0));
  return { score, band: score >= 70 ? "HOT" : score >= 40 ? "WARM" : "COLD", reasons };
}

export async function scoreContact(orgId, contact) {
  const { crmDeals, crmActivities } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const [deals, activities] = await Promise.all([
    crmDeals.find({ orgId: orgObjectId, contactId: contact._id, deletedAt: null }, { projection: { status: 1, value: 1 } }).toArray(),
    crmActivities.find({ orgId: orgObjectId, contactId: contact._id }, { projection: { at: 1 } }).toArray(),
  ]);
  return computeLeadScore({ contact, deals, activityDates: activities.map((a) => a.at) });
}

export async function logActivity({ orgId, contact, type, subject, body, at, durationMinutes, dealId, extra = {}, actorEmail }) {
  if (!ACTIVITY_TYPES.includes(type)) return { error: `type must be one of ${ACTIVITY_TYPES.join(", ")}.`, status: 400 };
  const cleanSubject = String(subject || "").trim();
  if (!cleanSubject && type !== "NOTE") return { error: "A subject is required.", status: 400 };
  if (type === "NOTE" && !String(body || "").trim()) return { error: "A note needs some text.", status: 400 };
  const when = at ? new Date(at) : new Date();
  if (Number.isNaN(when.getTime())) return { error: "Invalid date.", status: 400 };
  if (durationMinutes !== undefined && durationMinutes !== null && (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440)) {
    return { error: "durationMinutes must be a whole number from 1 to 1440.", status: 400 };
  }
  const { crmActivities } = await getOrgCollections();
  const doc = {
    orgId: toObjectId(orgId), contactId: contact._id, departmentId: contact.departmentId,
    dealId: dealId ? toObjectId(dealId) : null, type, subject: cleanSubject || null,
    body: String(body || "").trim() || null, at: when.toISOString(),
    durationMinutes: durationMinutes ?? null, ...extra,
    createdByEmail: actorEmail, createdAt: new Date().toISOString(),
  };
  const r = await crmActivities.insertOne(doc);
  await logOrgActivity({
    orgId: doc.orgId, recordType: "CONTACT", recordId: contact._id, actorEmail,
    action: `CONTACT_${type}_LOGGED`, previousState: null, newState: null, metadata: { activityId: r.insertedId.toString() },
  });
  return { activity: { ...doc, _id: r.insertedId } };
}

export async function listActivities(orgId, contactId) {
  const { crmActivities } = await getOrgCollections();
  return crmActivities.find({ orgId: toObjectId(orgId), contactId: toObjectId(contactId) }).sort({ at: -1 }).limit(200).toArray();
}

export async function sendContactEmail({ orgId, contact, subject, body, actorEmail, sender = sendEmail }) {
  if (!contact.email) return { error: "This contact has no email address.", status: 400 };
  const cleanSubject = String(subject || "").trim();
  const cleanBody = String(body || "").trim();
  if (!cleanSubject || !cleanBody) return { error: "Subject and message are required.", status: 400 };
  const result = await sender({ to: contact.email, subject: cleanSubject, text: cleanBody, html: cleanBody.split("\n").map((l) => `<p>${escapeHtml(l)}</p>`).join(""), replyTo: actorEmail });
  const delivered = result?.sent !== false;
  const logged = await logActivity({
    orgId, contact, type: "EMAIL", subject: cleanSubject, body: cleanBody, actorEmail,
    extra: { delivery: delivered ? "SENT" : "NOT_SENT", deliveryReason: delivered ? null : result?.reason || null },
  });
  return { ...logged, sent: delivered, reason: delivered ? null : result?.reason || null };
}

export async function scheduleMeeting({ orgId, contact, start, durationMinutes = 30, subject, description, location, attendeeEmails = [], organizerName, actorEmail, sender = sendEmail }) {
  const begin = new Date(start);
  if (Number.isNaN(begin.getTime())) return { error: "A valid start time is required.", status: 400 };
  if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 1440) return { error: "Duration must be 5 to 1440 minutes.", status: 400 };
  const cleanSubject = String(subject || "").trim();
  if (!cleanSubject) return { error: "A meeting title is required.", status: 400 };
  const extraAttendees = [...new Set((attendeeEmails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
  if (extraAttendees.some((e) => !EMAIL_RE.test(e))) return { error: "Every attendee needs a valid email address.", status: 400 };

  const uid = `${randomUUID()}@inayanetwork.com`;
  const attendees = [...(contact.email ? [{ email: contact.email, name: contact.name }] : []), ...extraAttendees.map((email) => ({ email }))];
  const ics = buildInvite({ uid, start: begin, durationMinutes, summary: cleanSubject, description, location, organizerEmail: actorEmail, organizerName, attendees });

  const recipients = attendees.map((a) => a.email);
  const deliveries = [];
  for (const to of recipients) {
    const r = await sender({
      to, subject: `Invitation: ${cleanSubject}`, replyTo: actorEmail,
      text: `You're invited: ${cleanSubject}\nWhen: ${begin.toUTCString()} (${durationMinutes} min)${location ? `\nWhere: ${location}` : ""}${description ? `\n\n${description}` : ""}\n\nThe attached invite adds it to your calendar.`,
      html: `<p>You're invited: <strong>${escapeHtml(cleanSubject)}</strong></p><p>When: ${escapeHtml(begin.toUTCString())} (${durationMinutes} min)</p>${location ? `<p>Where: ${escapeHtml(location)}</p>` : ""}${description ? `<p>${escapeHtml(description)}</p>` : ""}<p>The attached invite adds it to your calendar.</p>`,
      attachments: [{ filename: "invite.ics", content: Buffer.from(ics).toString("base64"), contentType: "text/calendar; method=REQUEST" }],
    });
    deliveries.push({ to, sent: r?.sent !== false, reason: r?.reason || null });
  }
  const logged = await logActivity({
    orgId, contact, type: "MEETING", subject: cleanSubject, body: description, at: begin.toISOString(), durationMinutes, actorEmail,
    extra: { location: location || null, attendees: recipients, icsUid: uid, ics, deliveries },
  });
  return { ...logged, ics, deliveries };
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
