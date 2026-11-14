// src/lib/engagement/time.js
//
// Appointment Calendar SOW — time-zone arithmetic without a date library.
// Staff availability is written in the staff member's own time zone
// ("Mon 09:00-17:00 Asia/Karachi"); bookings are stored as UTC instants.
// Intl.DateTimeFormat gives the wall-clock parts of an instant in any IANA
// zone, which is enough to convert both ways (including DST transitions).

const partsCache = new Map();
function formatter(timeZone) {
  if (!partsCache.has(timeZone)) {
    partsCache.set(timeZone, new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
    }));
  }
  return partsCache.get(timeZone);
}

/** True for a valid IANA time zone name. */
export function isValidTimeZone(timeZone) {
  if (!timeZone || typeof timeZone !== "string") return false;
  try { formatter(timeZone).format(new Date()); return true; } catch { return false; }
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
export const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Wall-clock parts of `date` in `timeZone`: { year, month, day, hour, minute, second, weekday (0=Sun) }. */
export function zonedParts(date, timeZone) {
  const out = {};
  for (const p of formatter(timeZone).formatToParts(new Date(date))) {
    if (p.type === "weekday") out.weekday = WEEKDAYS[p.value];
    else if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out;
}

/** Offset of `timeZone` from UTC at instant `date`, in minutes (Asia/Karachi -> +300). */
export function tzOffsetMinutes(date, timeZone) {
  const d = new Date(date);
  const p = zonedParts(d, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
}

/**
 * The UTC instant for a wall-clock time in a zone: zonedToUtc("2026-11-13", "09:30", "Asia/Karachi").
 * During a DST gap (a local time that does not exist) the result moves forward to a real instant.
 */
export function zonedToUtc(dateStr, timeStr, timeZone) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const [hh, mm] = String(timeStr || "00:00").split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh || 0, mm || 0, 0);
  let guess = wall - tzOffsetMinutes(new Date(wall), timeZone) * 60000;
  // second pass settles the offset across a DST boundary
  guess = wall - tzOffsetMinutes(new Date(guess), timeZone) * 60000;
  return new Date(guess);
}

/** "2026-11-13" for the instant in the zone. */
export function zonedDateKey(date, timeZone) {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Adds whole days to a "YYYY-MM-DD" key (calendar arithmetic, zone-independent). */
export function addDaysKey(dateKey, days) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** Weekday (0=Sun) of a "YYYY-MM-DD" key. */
export function weekdayOfKey(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** "09:30" -> 570. Rejects anything that is not HH:MM in 00:00-24:00. */
export function minutesOf(hhmm) {
  const m = /^([01]\d|2[0-4]):([0-5]\d)$/.exec(String(hhmm || ""));
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v <= 1440 ? v : null;
}

/** Human time in a zone, e.g. "Fri 13 Nov 2026, 09:30 (Asia/Karachi)". */
export function formatInZone(date, timeZone, { withZone = true } = {}) {
  const s = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(date));
  return withZone ? `${s} (${timeZone})` : s;
}

/** Do [aStart, aEnd) and [bStart, bEnd) overlap? Accepts Dates, ISO strings or ms. */
export function overlaps(aStart, aEnd, bStart, bEnd) {
  return new Date(aStart).getTime() < new Date(bEnd).getTime() && new Date(bStart).getTime() < new Date(aEnd).getTime();
}
