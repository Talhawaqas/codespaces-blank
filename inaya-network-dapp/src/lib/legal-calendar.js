// src/lib/legal-calendar.js
//
// Healthcare & Legal Expansion SOW, Phase 7 (§11.17) — court/case
// calendar. Every deadline carries `confidence` and `manualConfirmation`
// fields explicitly so a synced-but-unconfirmed deadline (via the stubbed
// calendarAdapter.js, Phase 10) is never presented as authoritative — the
// SOW's own instruction: "Do not assert deadlines as authoritative
// without verified source data." A deadline created directly by a human
// (source:"manual") is automatically confirmed; one from an external
// sync (source:"external_sync") starts unconfirmed until a human
// reviews it.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canAccessLegalMatters, canManageLegal } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";
import { createNotification } from "./notifications.js";

export async function createDeadline({ orgId, matterId, description, dueAt, jurisdiction, timeZone, court, source, confidence, actorEmail, membership }) {
  if (!canAccessLegalMatters(membership)) return { error: "You don't have permission to add a deadline.", status: 403 };
  const { legalDeadlines } = await getOrgCollections();
  const now = new Date().toISOString();
  const isManual = (source || "manual") === "manual";
  const doc = {
    orgId: toObjectId(orgId), matterId: toObjectId(matterId), description, dueAt,
    jurisdiction: jurisdiction || null, timeZone: timeZone || "UTC", court: court || null,
    source: source || "manual", confidence: confidence || (isManual ? "high" : "unverified"),
    manualConfirmation: isManual, confirmedByEmail: isManual ? actorEmail : null, confirmedAt: isManual ? now : null,
    reminderSentAt: null, escalated: false,
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await legalDeadlines.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "LEGAL_DEADLINE", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: null, metadata: { matterId, dueAt, source: doc.source } });
  return { deadline: inserted };
}

/** A human must explicitly confirm an externally-synced deadline before
 *  it's treated as authoritative anywhere in the UI — this is the one
 *  state change that flips manualConfirmation, and it's deliberately a
 *  separate call from createDeadline, never implicit. */
export async function confirmDeadline({ orgId, deadlineId, actorEmail, membership }) {
  if (!canAccessLegalMatters(membership)) return { error: "You don't have permission to confirm this deadline.", status: 403 };
  const { legalDeadlines } = await getOrgCollections();
  const now = new Date().toISOString();
  const updated = await legalDeadlines.findOneAndUpdate(
    { _id: toObjectId(deadlineId), orgId: toObjectId(orgId), manualConfirmation: false },
    { $set: { manualConfirmation: true, confirmedByEmail: actorEmail, confirmedAt: now, confidence: "high", updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Deadline not found, or already confirmed.", status: 409 };
  await logOrgActivity({ orgId, recordType: "LEGAL_DEADLINE", recordId: updated._id, actorEmail, action: "CONFIRMED", previousState: null, newState: null, metadata: {} });
  return { deadline: updated };
}

/** Reminder + escalation — cron-driven, same idempotent-via-marker
 *  pattern as health-scheduling.js's appointment reminders and
 *  invoice-workflow.js's overdue check. Escalates (notifies the
 *  responsible partner directly, not just the matter team) for any
 *  deadline still unconfirmed within the reminder window — an
 *  unconfirmed deadline close to due is exactly the case that most needs
 *  a human's attention, not less. */
export async function sendDeadlineReminders(daysAhead = 3) {
  const { legalDeadlines, legalMatters } = await getOrgCollections();
  const now = new Date();
  const windowEnd = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
  const due = await legalDeadlines.find({ dueAt: { $gte: now.toISOString(), $lte: windowEnd }, reminderSentAt: null }).toArray();

  let sent = 0;
  for (const deadline of due) {
    const updated = await legalDeadlines.findOneAndUpdate({ _id: deadline._id, reminderSentAt: null }, { $set: { reminderSentAt: new Date().toISOString() } });
    if (!updated) continue;
    const matter = await legalMatters.findOne({ _id: deadline.matterId });
    const severity = !deadline.manualConfirmation ? "critical" : "warning";
    const body = !deadline.manualConfirmation
      ? `UNCONFIRMED deadline approaching (${deadline.confidence} confidence, source: ${deadline.source}) — please verify before relying on this date.`
      : `Deadline approaching: ${deadline.description}`;
    await createNotification({
      scope: "org", orgId: deadline.orgId, targetEmail: matter?.responsiblePartnerEmail || null, category: "business", severity,
      type: "matter_deadline", title: `Deadline: ${deadline.description}`, body,
      sourceModule: "legal-calendar", sourceId: deadline._id, actionUrl: "/business?view=legal",
      dedupeKey: `${deadline.orgId}:matter_deadline:${deadline._id}`,
    });
    sent += 1;
  }
  return { checked: due.length, sent };
}

export async function listDeadlinesForMatter(orgId, matterId) {
  const { legalDeadlines } = await getOrgCollections();
  return legalDeadlines.find({ orgId: toObjectId(orgId), matterId: toObjectId(matterId) }).sort({ dueAt: 1 }).toArray();
}
