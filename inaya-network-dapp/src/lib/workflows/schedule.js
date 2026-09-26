// src/lib/workflows/schedule.js
//
// SOW §8 scheduled trigger: timezone, start/end date, daily / weekly / monthly /
// custom interval, enabled state and next-run calculation. Pure and
// server-authoritative: the browser never decides when a workflow runs.
// Local wall-clock times are resolved to UTC through Intl (so DST is handled
// by the platform's tz database, not by hand-rolled offset tables).

export const SCHEDULE_KINDS = ["daily", "weekly", "monthly", "interval"];
const MIN_INTERVAL_MINUTES = 5;
const MAX_LOOKAHEAD_DAYS = 800;

export function isValidTimezone(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return typeof tz === "string" && tz.length > 0; } catch { return false; }
}

function partsOf(ts, tz) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const o = {};
  for (const p of f.formatToParts(new Date(ts))) if (p.type !== "literal") o[p.type] = Number(p.value);
  return o;
}
function offsetMs(ts, tz) {
  const p = partsOf(ts, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
}
/** Wall-clock (in tz) -> UTC epoch ms. */
export function zonedToUtc(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  let t = guess - offsetMs(guess, tz);
  const off2 = offsetMs(t, tz);
  if (guess - off2 !== t) t = guess - off2;
  return t;
}
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

export function validateSchedule(s) {
  const errors = [];
  if (!s || typeof s !== "object") return ["The schedule is missing."];
  if (!SCHEDULE_KINDS.includes(s.kind)) errors.push(`Schedule kind must be one of ${SCHEDULE_KINDS.join(", ")}.`);
  if (!isValidTimezone(s.timezone || "UTC")) errors.push("The timezone is not a valid IANA timezone (for example Asia/Karachi).");
  if (s.kind !== "interval" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time || "")) errors.push("A daily/weekly/monthly schedule needs a time as HH:MM (24 hour).");
  if (s.kind === "weekly" && !(Array.isArray(s.daysOfWeek) && s.daysOfWeek.length && s.daysOfWeek.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))) errors.push("A weekly schedule needs daysOfWeek (0=Sunday … 6=Saturday).");
  if (s.kind === "monthly" && !(Number.isInteger(s.dayOfMonth) && s.dayOfMonth >= 1 && s.dayOfMonth <= 31)) errors.push("A monthly schedule needs dayOfMonth 1–31 (a shorter month runs on its last day).");
  if (s.kind === "interval" && !(Number.isInteger(s.everyMinutes) && s.everyMinutes >= MIN_INTERVAL_MINUTES && s.everyMinutes <= 60 * 24 * 31)) errors.push(`An interval schedule needs everyMinutes between ${MIN_INTERVAL_MINUTES} and ${60 * 24 * 31}.`);
  for (const k of ["startDate", "endDate"]) if (s[k] && !Number.isFinite(Date.parse(s[k]))) errors.push(`${k} is not a valid date.`);
  if (s.startDate && s.endDate && Date.parse(s.endDate) < Date.parse(s.startDate)) errors.push("endDate is before startDate.");
  return errors;
}

/**
 * Next scheduled run strictly after `after` (Date | ms | ISO). Returns an ISO
 * string in UTC, or null when the schedule is disabled or has ended.
 */
export function nextRun(schedule, after = Date.now()) {
  if (!schedule || schedule.enabled === false) return null;
  if (validateSchedule(schedule).length) return null;
  const afterMs = typeof after === "number" ? after : new Date(after).getTime();
  const tz = schedule.timezone || "UTC";
  const startMs = schedule.startDate ? Date.parse(schedule.startDate) : null;
  const endMs = schedule.endDate ? Date.parse(schedule.endDate) : null;
  const from = Math.max(afterMs, startMs !== null ? startMs - 1 : -Infinity);
  const withinEnd = (t) => endMs === null || t <= endMs;

  if (schedule.kind === "interval") {
    const step = schedule.everyMinutes * 60000;
    const anchor = startMs ?? 0;
    const n = Math.floor((from - anchor) / step) + 1;
    const t = anchor + Math.max(0, n) * step;
    return withinEnd(t) ? new Date(t).toISOString() : null;
  }

  const [hh, mm] = schedule.time.split(":").map(Number);
  const p0 = partsOf(from, tz);
  let y = p0.year, m = p0.month, d = p0.day;
  for (let i = 0; i < MAX_LOOKAHEAD_DAYS; i++) {
    let ok = false;
    if (schedule.kind === "daily") ok = true;
    else if (schedule.kind === "weekly") ok = schedule.daysOfWeek.includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
    else if (schedule.kind === "monthly") ok = d === Math.min(schedule.dayOfMonth, daysInMonth(y, m));
    if (ok) {
      const t = zonedToUtc(y, m, d, hh, mm, tz);
      if (t > from) return withinEnd(t) ? new Date(t).toISOString() : null;
    }
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    y = next.getUTCFullYear(); m = next.getUTCMonth() + 1; d = next.getUTCDate();
  }
  return null;
}
