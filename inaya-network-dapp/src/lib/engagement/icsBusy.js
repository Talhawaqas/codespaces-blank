// src/lib/engagement/icsBusy.js
//
// Appointment Calendar SOW, calendar sync without app verification: reads a
// staff member's own secret iCal address (Google Calendar "Secret address in
// iCal format", Outlook "Publish calendar" ICS link) and turns it into busy
// time ranges, so the booking page never offers a slot when they're busy in
// their own calendar. Only start/end times are kept — never titles,
// attendees or descriptions.
//
// Supports what real Google/Outlook feeds contain: DTSTART/DTEND/DURATION
// with UTC, floating and TZID times and all-day dates, RRULE (DAILY, WEEKLY
// with BYDAY, MONTHLY by month-day, YEARLY; INTERVAL, COUNT, UNTIL), EXDATE,
// RECURRENCE-ID overrides, STATUS:CANCELLED and TRANSP:TRANSPARENT (free).

import { zonedToUtc, isValidTimeZone } from "./time.js";

const MAX_EVENTS = 5000;
const MAX_OCCURRENCES_PER_EVENT = 500;

// Outlook uses Windows zone names in TZID; map the common ones to IANA.
const WINDOWS_ZONES = {
  "Pakistan Standard Time": "Asia/Karachi", "Arabian Standard Time": "Asia/Dubai", "India Standard Time": "Asia/Kolkata",
  "Bangladesh Standard Time": "Asia/Dhaka", "GMT Standard Time": "Europe/London", "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest", "Romance Standard Time": "Europe/Paris", "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago", "Mountain Standard Time": "America/Denver", "Pacific Standard Time": "America/Los_Angeles",
  "Arab Standard Time": "Asia/Riyadh", "Singapore Standard Time": "Asia/Singapore", "China Standard Time": "Asia/Shanghai",
  "Tokyo Standard Time": "Asia/Tokyo", "AUS Eastern Standard Time": "Australia/Sydney", "UTC": "UTC", "Coordinated Universal Time": "UTC",
};

function unfold(text) {
  return String(text).replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

/** "DTSTART;TZID=Asia/Karachi:20261113T090000" -> { name, params, value } */
function parseLine(line) {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const head = line.slice(0, colon); const value = line.slice(colon + 1);
  const [name, ...rawParams] = head.split(";");
  const params = {};
  for (const p of rawParams) { const i = p.indexOf("="); if (i > 0) params[p.slice(0, i).toUpperCase()] = p.slice(i + 1).replace(/^"|"$/g, ""); }
  return { name: name.toUpperCase(), params, value };
}

function zoneOf(tzid, fallbackZone) {
  if (!tzid) return fallbackZone;
  if (isValidTimeZone(tzid)) return tzid;
  return WINDOWS_ZONES[tzid] || fallbackZone;
}

/** Parses an ICS date/date-time value to { date: Date, allDay }. */
export function parseIcsDate(value, params = {}, fallbackZone = "UTC") {
  const v = String(value).trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m || params.VALUE === "DATE") {
    m = m || /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    return { date: zonedToUtc(`${m[1]}-${m[2]}-${m[3]}`, "00:00", zoneOf(params.TZID, fallbackZone)), allDay: true };
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return null;
  if (m[7] === "Z") return { date: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])), allDay: false };
  return { date: zonedToUtc(`${m[1]}-${m[2]}-${m[3]}`, `${m[4]}:${m[5]}`, zoneOf(params.TZID, fallbackZone)), allDay: false };
}

/** "PT1H30M" / "P1D" -> milliseconds. */
export function parseDuration(value) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(value).trim());
  if (!m) return null;
  const ms = ((+m[2] || 0) * 7 * 86400 + (+m[3] || 0) * 86400 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

function parseRrule(value) {
  const out = {};
  for (const part of String(value).split(";")) { const [k, v] = part.split("="); if (k && v) out[k.toUpperCase()] = v; }
  return out;
}

const BYDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** Occurrence start instants of a recurring event that fall before `windowEnd`. */
function expandRrule({ start, rrule, exdates, windowEnd }) {
  const freq = rrule.FREQ;
  const interval = Math.max(1, Number(rrule.INTERVAL) || 1);
  const count = rrule.COUNT ? Number(rrule.COUNT) : Infinity;
  const until = rrule.UNTIL ? parseIcsDate(rrule.UNTIL)?.date : null;
  const limit = until && until < windowEnd ? until : windowEnd;
  const out = [];
  const excluded = new Set(exdates.map((d) => d.getTime()));
  const push = (d) => { if (!excluded.has(d.getTime())) out.push(d); };
  let produced = 0;
  const step = (base, n) => {
    const d = new Date(base);
    if (freq === "DAILY") d.setUTCDate(d.getUTCDate() + n * interval);
    else if (freq === "WEEKLY") d.setUTCDate(d.getUTCDate() + n * 7 * interval);
    else if (freq === "MONTHLY") d.setUTCMonth(d.getUTCMonth() + n * interval);
    else if (freq === "YEARLY") d.setUTCFullYear(d.getUTCFullYear() + n * interval);
    return d;
  };
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return [start];
  if (freq === "WEEKLY" && rrule.BYDAY) {
    const days = rrule.BYDAY.split(",").map((s) => BYDAY[s.slice(-2)]).filter((x) => x !== undefined);
    const weekStart = new Date(start); weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
    for (let w = 0; produced < count && out.length < MAX_OCCURRENCES_PER_EVENT; w++) {
      const base = new Date(weekStart); base.setUTCDate(base.getUTCDate() + w * 7 * interval);
      if (base > limit) break;
      for (const day of days.sort((a, b) => a - b)) {
        const d = new Date(base); d.setUTCDate(d.getUTCDate() + day);
        d.setUTCHours(start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), 0);
        if (d < start || d > limit) continue;
        if (produced >= count) break;
        produced++; push(d);
      }
    }
    return out;
  }
  for (let n = 0; produced < count && out.length < MAX_OCCURRENCES_PER_EVENT; n++) {
    const d = step(start, n);
    if (d > limit) break;
    produced++; push(d);
  }
  return out;
}

/**
 * Busy ranges from ICS text that overlap [windowStart, windowEnd).
 * @returns {{ busy: { start: string, end: string }[], events: number, truncated: boolean }}
 */
export function busyFromIcs(icsText, { windowStart, windowEnd, defaultTimeZone = "UTC" }) {
  const text = unfold(icsText);
  if (!/BEGIN:VCALENDAR/.test(text)) throw new Error("That address didn't return a calendar (no VCALENDAR found).");
  const calZoneLine = /X-WR-TIMEZONE:([^\n]+)/.exec(text);
  const calZone = zoneOf(calZoneLine?.[1]?.trim(), defaultTimeZone);
  const blocks = text.split("BEGIN:VEVENT").slice(1).map((b) => b.split("END:VEVENT")[0]);
  const wStart = new Date(windowStart); const wEnd = new Date(windowEnd);
  const overrides = new Map(); // uid -> Set(recurrence-id ms)
  const events = [];
  for (const block of blocks.slice(0, MAX_EVENTS)) {
    const ev = { exdates: [] };
    for (const raw of block.split("\n")) {
      const line = parseLine(raw.trim()); if (!line) continue;
      if (line.name === "DTSTART") ev.start = parseIcsDate(line.value, line.params, calZone);
      else if (line.name === "DTEND") ev.end = parseIcsDate(line.value, line.params, calZone);
      else if (line.name === "DURATION") ev.duration = parseDuration(line.value);
      else if (line.name === "RRULE") ev.rrule = parseRrule(line.value);
      else if (line.name === "EXDATE") for (const v of line.value.split(",")) { const d = parseIcsDate(v, line.params, calZone); if (d) ev.exdates.push(d.date); }
      else if (line.name === "UID") ev.uid = line.value;
      else if (line.name === "RECURRENCE-ID") ev.recurrenceId = parseIcsDate(line.value, line.params, calZone)?.date;
      else if (line.name === "STATUS") ev.status = line.value.toUpperCase();
      else if (line.name === "TRANSP") ev.transp = line.value.toUpperCase();
    }
    if (!ev.start) continue;
    if (ev.recurrenceId && ev.uid) { if (!overrides.has(ev.uid)) overrides.set(ev.uid, new Set()); overrides.get(ev.uid).add(ev.recurrenceId.getTime()); }
    events.push(ev);
  }
  const busy = [];
  for (const ev of events) {
    if (ev.status === "CANCELLED" || ev.transp === "TRANSPARENT") continue;
    const startMs = ev.start.date.getTime();
    const lengthMs = ev.end ? ev.end.date.getTime() - startMs : ev.duration ?? (ev.start.allDay ? 86400000 : 0);
    if (!(lengthMs > 0)) continue;
    let starts = [ev.start.date];
    if (ev.rrule && !ev.recurrenceId) {
      const replaced = overrides.get(ev.uid) || new Set();
      starts = expandRrule({ start: ev.start.date, rrule: ev.rrule, exdates: ev.exdates, windowEnd: wEnd }).filter((d) => !replaced.has(d.getTime()));
    }
    for (const s of starts) {
      const e = new Date(s.getTime() + lengthMs);
      if (e > wStart && s < wEnd) busy.push({ start: s.toISOString(), end: e.toISOString() });
    }
  }
  busy.sort((a, b) => a.start.localeCompare(b.start));
  return { busy: mergeRanges(busy), events: events.length, truncated: blocks.length > MAX_EVENTS };
}

/** Merges overlapping/adjacent ranges (sorted or not). */
export function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => new Date(a.start) - new Date(b.start));
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && new Date(r.start) <= new Date(last.end)) { if (new Date(r.end) > new Date(last.end)) last.end = r.end; }
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}
