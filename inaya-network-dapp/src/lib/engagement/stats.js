// src/lib/engagement/stats.js
//
// Appointment Calendar SOW — the dashboard numbers from the mockup:
// Total appointments, Completed, Upcoming today, Customers engaged (each with
// the change against the previous period), the Upcoming list with Join
// buttons, calendar-sync status, and the booking completion rate
// (SOW success metric: >= 80%).

import { toObjectId } from "../orgs.js";
import { engagementCollections, ensureEngagementIndexes, normEmail, canManageCalendar } from "./store.js";
import { publicAppointment } from "./appointments.js";
import { zonedToUtc, zonedDateKey, addDaysKey, isValidTimeZone } from "./time.js";

/** Percentage change, rounded to one decimal; null when there's nothing to compare against. */
export function pctChange(current, previous) {
  if (!previous) return current ? null : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/** Period boundaries in the viewer's zone: this period and the one before it, of equal length. */
export function periodBounds(period, timeZone, now = new Date()) {
  const tz = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const today = zonedDateKey(now, tz);
  const days = period === "week" ? 7 : period === "quarter" ? 90 : 30;
  const start = zonedToUtc(addDaysKey(today, -(days - 1)), "00:00", tz);
  const end = zonedToUtc(addDaysKey(today, 1), "00:00", tz);
  const prevStart = zonedToUtc(addDaysKey(today, -(2 * days - 1)), "00:00", tz);
  return { start, end, prevStart, prevEnd: start, todayStart: zonedToUtc(today, "00:00", tz), todayEnd: end, days };
}

async function countsFor(calendar, base, from, to) {
  const rows = await calendar.aggregate([
    { $match: { ...base, start: { $gte: from, $lt: to } } },
    { $group: { _id: "$status", n: { $sum: 1 }, customers: { $addToSet: "$customer.email" } } },
  ]).toArray();
  const by = Object.fromEntries(rows.map((r) => [r._id, r.n]));
  const customers = new Set(rows.filter((r) => r._id !== "CANCELLED").flatMap((r) => r.customers.map(normEmail)));
  const total = rows.filter((r) => r._id !== "CANCELLED").reduce((s, r) => s + r.n, 0);
  return { total, completed: by.COMPLETED || 0, cancelled: by.CANCELLED || 0, noShow: by.NO_SHOW || 0, customers: customers.size };
}

export async function appointmentDashboard({ orgId, membership, scope = "mine", timeZone = "UTC", period = "month", now = new Date() }) {
  await ensureEngagementIndexes();
  const { calendar } = await engagementCollections();
  const team = scope === "team" && canManageCalendar(membership);
  const base = { orgId: toObjectId(orgId), kind: "appointment", ...(team ? {} : { staffEmail: normEmail(membership.email) }) };
  const b = periodBounds(period, timeZone, now);
  const [cur, prev] = await Promise.all([countsFor(calendar, base, b.start, b.end), countsFor(calendar, base, b.prevStart, b.prevEnd)]);
  const todayActive = { ...base, status: { $in: ["PENDING", "CONFIRMED"] } };
  const [upcomingToday, upcomingTodayPrev, upcoming] = await Promise.all([
    calendar.countDocuments({ ...todayActive, start: { $gte: now, $lt: b.todayEnd } }),
    calendar.countDocuments({ ...base, status: { $ne: "CANCELLED" }, start: { $gte: new Date(b.todayStart.getTime() - 7 * 86400000), $lt: new Date(b.todayEnd.getTime() - 7 * 86400000) } }),
    calendar.find({ ...todayActive, end: { $gt: now } }).sort({ start: 1 }).limit(8).toArray(),
  ]);
  const pages = await calendar.find({ orgId: toObjectId(orgId), kind: "page" }).project({ stats: 1, slug: 1, title: 1 }).toArray();
  const funnel = pages.reduce((s, p) => ({ views: s.views + (p.stats?.views || 0), starts: s.starts + (p.stats?.starts || 0), completions: s.completions + (p.stats?.completions || 0), enquiries: s.enquiries + (p.stats?.enquiries || 0) }), { views: 0, starts: 0, completions: 0, enquiries: 0 });
  const sync = await calendar.findOne({ orgId: toObjectId(orgId), kind: "availability", staffEmail: normEmail(membership.email) });
  const held = cur.completed + cur.noShow;
  return {
    period: { name: period, days: b.days, start: b.start.toISOString(), end: b.end.toISOString() },
    cards: {
      total: { value: cur.total, change: pctChange(cur.total, prev.total) },
      completed: { value: cur.completed, change: pctChange(cur.completed, prev.completed) },
      upcomingToday: { value: upcomingToday, change: pctChange(upcomingToday, upcomingTodayPrev) },
      customersEngaged: { value: cur.customers, change: pctChange(cur.customers, prev.customers) },
    },
    rates: {
      bookingCompletion: funnel.starts ? Math.round((funnel.completions / funnel.starts) * 1000) / 10 : null,
      noShow: held ? Math.round((cur.noShow / held) * 1000) / 10 : null,
      cancellation: cur.total + cur.cancelled ? Math.round((cur.cancelled / (cur.total + cur.cancelled)) * 1000) / 10 : null,
    },
    funnel,
    upcoming: upcoming.map((a) => ({ ...publicAppointment(a), joinable: !!a.location?.joinLink && new Date(a.start).getTime() - now.getTime() < 15 * 60000 })),
    sync: {
      feedEnabled: !!sync?.feedTokenHash,
      importConnected: !!sync?.importUrlSealed, importLastSyncAt: sync?.importedAt || null, importError: sync?.importError || null,
    },
    scope: team ? "team" : "mine",
  };
}
