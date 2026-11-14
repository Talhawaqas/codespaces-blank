// src/lib/engagement/reminders.js
//
// Appointment Calendar SOW — the reminder engine, run by /api/cron/engagement:
//   - email reminders and Twilio SMS reminders at the org's offsets (default 24 h and 1 h before)
//   - the post-meeting prompt to the staff member ("mark it done and add notes"), which is
//     what puts the meeting outcome on the CRM record (workflow step 7)
// Each reminder is claimed atomically (sentAt set before sending), so overlapping cron runs
// never send it twice.

import { sendEmail } from "../email.js";
import { createNotification } from "../notifications.js";
import { engagementCollections, ensureEngagementIndexes, engagementAccess } from "./store.js";
import { openSafe } from "./crypto.js";
import { getCalendarSettings, manageUrlFor, publicAppointment } from "./appointments.js";
import * as MSG from "./messages.js";

export async function processDueReminders({ now = new Date(), limit = 100, sms = null } = {}) {
  await ensureEngagementIndexes();
  const { calendar } = await engagementCollections();
  const due = await calendar.find({
    kind: "appointment", status: { $in: ["PENDING", "CONFIRMED"] },
    reminders: { $elemMatch: { dueAt: { $lte: now }, sentAt: null } },
  }).limit(limit).toArray();
  const smsProvider = sms || (await import("../smsProviders/twilio.js"));
  const settingsCache = new Map();
  const gateCache = new Map();
  const stats = { appointments: due.length, email: 0, sms: 0, prompts: 0, skipped: 0, failed: 0 };

  for (const a of due) {
    const orgKey = String(a.orgId);
    if (!gateCache.has(orgKey)) gateCache.set(orgKey, !(await engagementAccess(orgKey)));
    if (!settingsCache.has(orgKey)) settingsCache.set(orgKey, await getCalendarSettings(orgKey));
    const settings = settingsCache.get(orgKey);
    for (const r of a.reminders.filter((x) => x.sentAt === null && x.dueAt && new Date(x.dueAt) <= now)) {
      // claim
      const claim = await calendar.updateOne({ _id: a._id, reminders: { $elemMatch: { id: r.id, sentAt: null } } }, { $set: { "reminders.$.sentAt": now.toISOString() } });
      if (!claim.modifiedCount) continue;
      const setResult = (error) => calendar.updateOne({ _id: a._id, "reminders.id": r.id }, { $set: { "reminders.$.error": error } });
      if (!gateCache.get(orgKey)) { stats.skipped++; await setResult("Plan no longer includes appointments."); continue; }
      const tooLate = r.channel !== "staff_prompt" && new Date(a.start) <= now;
      if (tooLate) { stats.skipped++; await setResult("Appointment already started."); continue; }
      const token = openSafe(a.manageTokenSealed);
      const manageUrl = token ? manageUrlFor(token) : `${MSG.appUrl()}/book`;
      try {
        if (r.channel === "email") {
          const m = MSG.reminderEmail({ appt: a, businessName: settings.businessName, manageUrl });
          const d = await sendEmail({ to: a.customer.email, ...m, replyTo: settings.replyToEmail || a.staffEmail });
          if (d?.sent === false) throw new Error(d.reason || "Email not sent.");
          stats.email++;
        } else if (r.channel === "sms") {
          const phone = openSafe(a.customer?.phoneSealed);
          if (!phone) throw new Error("No phone number.");
          if (!smsProvider.isConfigured()) throw new Error("SMS isn't set up (Twilio credentials missing).");
          await smsProvider.sendSms(phone, MSG.reminderSms({ appt: a, businessName: settings.businessName, manageUrl }));
          stats.sms++;
        } else if (r.channel === "staff_prompt") {
          if (a.status !== "CONFIRMED") { stats.skipped++; continue; }
          await createNotification({
            scope: "org", orgId: a.orgId, targetEmail: a.staffEmail, category: "business", severity: "info", type: "appointment.followup_due",
            title: `How did it go? ${a.typeName} with ${a.customer?.name || "your customer"}`,
            body: "Mark it completed or no-show and add notes. Completing it updates the CRM record.",
            sourceModule: "appointments", sourceId: String(a._id), actionUrl: `/business?view=appointments&appointment=${a._id}`, metadata: {}, dedupeKey: `appt:post:${a._id}:${a.sequence || 0}`,
          });
          stats.prompts++;
        }
        import("../workflows/queue.js").then((m) => m.emitWorkflowEvent({ orgId: orgKey, type: "event", key: r.channel === "staff_prompt" ? "appointment.ended" : "appointment.reminder_sent", eventId: `appt-rem:${a._id}:${r.id}:${a.sequence || 0}`, payload: { appointment: publicAppointment(a), channel: r.channel } })).catch(() => {});
      } catch (e) {
        stats.failed++;
        await setResult(String(e?.message || e).slice(0, 300));
      }
    }
  }
  return stats;
}

/** Marks confirmed appointments that ended more than 7 days ago with no outcome as needing attention (no auto-complete). */
export async function staleAppointments(orgId, { now = new Date() } = {}) {
  const { calendar } = await engagementCollections();
  const { toObjectId } = await import("../orgs.js");
  return calendar.countDocuments({ orgId: toObjectId(orgId), kind: "appointment", status: "CONFIRMED", end: { $lt: new Date(now.getTime() - 7 * 86400000) } });
}
