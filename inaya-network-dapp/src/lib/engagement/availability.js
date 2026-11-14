// src/lib/engagement/availability.js
//
// Appointment Calendar SOW — staff availability management and bookable
// slot computation. Pure functions only (no database), so the booking rules
// are unit-tested directly.
//
// A staff member's availability record:
//   { timeZone: "Asia/Karachi",
//     weekly: { mon: [{ start: "09:00", end: "13:00" }, { start: "14:00", end: "17:00" }], tue: [...], ... },
//     timeOff: [{ start: ISO, end: ISO, reason }],
//     importedBusy: [{ start: ISO, end: ISO }] }   // from their own Google/Outlook iCal address
// An appointment type supplies the rules:
//   { durationMinutes, bufferBeforeMinutes, bufferAfterMinutes, minNoticeMinutes, maxAdvanceDays, slotStepMinutes, dailyLimit }

import { DAY_KEYS, isValidTimeZone, minutesOf, zonedToUtc, zonedDateKey, addDaysKey, weekdayOfKey, overlaps } from "./time.js";

export const DEFAULT_WEEKLY = {
  sun: [], mon: [{ start: "09:00", end: "17:00" }], tue: [{ start: "09:00", end: "17:00" }], wed: [{ start: "09:00", end: "17:00" }],
  thu: [{ start: "09:00", end: "17:00" }], fri: [{ start: "09:00", end: "17:00" }], sat: [],
};

export const TYPE_DEFAULTS = { durationMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minNoticeMinutes: 120, maxAdvanceDays: 60, slotStepMinutes: 0, dailyLimit: 0 };

/** Validates and normalises a weekly-hours object. Returns { weekly } or { error }. */
export function normalizeWeekly(input) {
  if (!input || typeof input !== "object") return { error: "Weekly hours are required." };
  const weekly = {};
  for (const day of DAY_KEYS) {
    const ranges = Array.isArray(input[day]) ? input[day] : [];
    if (ranges.length > 6) return { error: `Too many time ranges on ${day} (6 at most).` };
    const out = [];
    for (const r of ranges) {
      const s = minutesOf(r?.start), e = minutesOf(r?.end);
      if (s === null || e === null) return { error: `Use HH:MM times on ${day} (e.g. 09:00).` };
      if (e <= s) return { error: `On ${day}, each range must end after it starts.` };
      out.push({ start: r.start, end: r.end, s, e });
    }
    out.sort((a, b) => a.s - b.s);
    for (let i = 1; i < out.length; i++) if (out[i].s < out[i - 1].e) return { error: `Time ranges on ${day} overlap.` };
    weekly[day] = out.map(({ start, end }) => ({ start, end }));
  }
  return { weekly };
}

/** Validates a type's numeric rules, filling defaults. Returns { rules } or { error }. */
export function normalizeTypeRules(input = {}) {
  const r = { ...TYPE_DEFAULTS };
  const int = (k, min, max) => {
    if (input[k] === undefined || input[k] === null || input[k] === "") return null;
    const v = Number(input[k]);
    if (!Number.isInteger(v) || v < min || v > max) return `${k} must be a whole number between ${min} and ${max}.`;
    r[k] = v; return null;
  };
  const err = int("durationMinutes", 5, 480) || int("bufferBeforeMinutes", 0, 240) || int("bufferAfterMinutes", 0, 240)
    || int("minNoticeMinutes", 0, 60 * 24 * 30) || int("maxAdvanceDays", 1, 365) || int("slotStepMinutes", 0, 240) || int("dailyLimit", 0, 100);
  if (err) return { error: err };
  return { rules: r };
}

/** Working-hour windows (UTC instants) for one local date. */
export function windowsForDate(dateKey, weekly, timeZone) {
  const ranges = weekly?.[DAY_KEYS[weekdayOfKey(dateKey)]] || [];
  return ranges.map((r) => {
    const end = r.end === "24:00" ? zonedToUtc(addDaysKey(dateKey, 1), "00:00", timeZone) : zonedToUtc(dateKey, r.end, timeZone);
    return { start: zonedToUtc(dateKey, r.start, timeZone), end };
  });
}

/**
 * Bookable slot starts for one staff member.
 * @param {object} p
 * @param {object} p.availability  { timeZone, weekly, timeOff, importedBusy }
 * @param {object} p.rules         type rules (normalizeTypeRules)
 * @param {{start,end}[]} p.booked existing appointments of this staff member (any type), already excluding cancelled
 * @param {Date|string} p.from     start of range (inclusive)
 * @param {Date|string} p.to       end of range (exclusive)
 * @param {Date} [p.now]
 * @returns {string[]} ISO slot start instants, ascending
 */
export function computeSlots({ availability, rules: rawRules, booked = [], from, to, now = new Date() }) {
  const tz = isValidTimeZone(availability?.timeZone) ? availability.timeZone : "UTC";
  const rules = { ...TYPE_DEFAULTS, ...(rawRules || {}) };
  const durMs = rules.durationMinutes * 60000;
  const stepMs = (rules.slotStepMinutes || rules.durationMinutes) * 60000;
  const before = rules.bufferBeforeMinutes * 60000, after = rules.bufferAfterMinutes * 60000;
  const earliest = Math.max(new Date(from).getTime(), now.getTime() + rules.minNoticeMinutes * 60000);
  const latest = Math.min(new Date(to).getTime(), now.getTime() + rules.maxAdvanceDays * 86400000);
  if (!(latest > earliest)) return [];

  // Everything that blocks: bookings (padded by this type's buffers), time off, the staff member's own calendar.
  const blocks = [
    ...booked.map((b) => ({ s: new Date(b.start).getTime() - after, e: new Date(b.end).getTime() + before })),
    ...(availability?.timeOff || []).map((b) => ({ s: new Date(b.start).getTime(), e: new Date(b.end).getTime() })),
    ...(availability?.importedBusy || []).map((b) => ({ s: new Date(b.start).getTime() - after, e: new Date(b.end).getTime() + before })),
  ].filter((b) => b.e > b.s);

  const perDay = new Map();
  for (const b of booked) { const k = zonedDateKey(b.start, tz); perDay.set(k, (perDay.get(k) || 0) + 1); }

  const out = [];
  let day = zonedDateKey(new Date(earliest), tz);
  const lastDay = zonedDateKey(new Date(latest), tz);
  for (let guard = 0; day <= lastDay && guard < 400; guard++, day = addDaysKey(day, 1)) {
    if (rules.dailyLimit && (perDay.get(day) || 0) >= rules.dailyLimit) continue;
    for (const w of windowsForDate(day, availability?.weekly || DEFAULT_WEEKLY, tz)) {
      for (let s = w.start.getTime(); s + durMs <= w.end.getTime(); s += stepMs) {
        if (s < earliest || s >= latest) continue;
        const e = s + durMs;
        if (blocks.some((b) => s < b.e && b.s < e)) continue;
        out.push(new Date(s).toISOString());
      }
    }
  }
  return out;
}

/** Is [start,end) still free for this staff member? Used at booking time (the slot list may be stale). */
export function isSlotFree({ availability, rules, booked = [], start, now = new Date() }) {
  const s = new Date(start);
  if (Number.isNaN(s.getTime())) return false;
  const slots = computeSlots({ availability, rules, booked, from: new Date(s.getTime() - 1), to: new Date(s.getTime() + 60000), now });
  return slots.includes(s.toISOString());
}

/** Picks the staff member for a round-robin type: the free one with the fewest upcoming bookings, ties by email. */
export function pickRoundRobin(candidates) {
  return [...candidates].sort((a, b) => (a.load - b.load) || a.email.localeCompare(b.email))[0] || null;
}

export { overlaps };
