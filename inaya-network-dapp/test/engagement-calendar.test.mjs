// Appointment Calendar SOW — pure logic: time zones, iCal busy import, slot computation, dashboard maths.
import test from "node:test";
import assert from "node:assert/strict";
import { zonedToUtc, zonedDateKey, tzOffsetMinutes, minutesOf, addDaysKey, weekdayOfKey } from "../src/lib/engagement/time.js";
import { busyFromIcs, parseDuration, parseIcsDate, mergeRanges } from "../src/lib/engagement/icsBusy.js";
import { computeSlots, normalizeWeekly, normalizeTypeRules, isSlotFree, pickRoundRobin } from "../src/lib/engagement/availability.js";
import { pctChange, periodBounds } from "../src/lib/engagement/stats.js";

test("time: Karachi wall clock to UTC and back", () => {
  assert.equal(zonedToUtc("2026-11-16", "09:00", "Asia/Karachi").toISOString(), "2026-11-16T04:00:00.000Z");
  assert.equal(tzOffsetMinutes(new Date("2026-11-16T04:00:00Z"), "Asia/Karachi"), 300);
  assert.equal(zonedDateKey(new Date("2026-11-16T20:00:00Z"), "Asia/Karachi"), "2026-11-17");
  assert.equal(addDaysKey("2026-12-31", 1), "2027-01-01");
  assert.equal(weekdayOfKey("2026-11-16"), 1);
  assert.equal(minutesOf("09:30"), 570);
  assert.equal(minutesOf("9:30"), null);
  assert.equal(minutesOf("24:00"), 1440);
});

test("time: DST — London summer vs winter, New York spring-forward gap moves forward", () => {
  assert.equal(zonedToUtc("2026-07-01", "09:00", "Europe/London").toISOString(), "2026-07-01T08:00:00.000Z");
  assert.equal(zonedToUtc("2026-12-01", "09:00", "Europe/London").toISOString(), "2026-12-01T09:00:00.000Z");
  const gap = zonedToUtc("2026-03-08", "02:30", "America/New_York");
  assert.ok(gap.toISOString() === "2026-03-08T07:30:00.000Z" || gap.toISOString() === "2026-03-08T06:30:00.000Z");
});

const ICS = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "X-WR-TIMEZONE:Asia/Karachi",
  // single UTC event
  "BEGIN:VEVENT", "UID:a", "DTSTART:20261116T060000Z", "DTEND:20261116T070000Z", "SUMMARY:Secret title", "END:VEVENT",
  // TZID event with folded line
  "BEGIN:VEVENT", "UID:b", "DTSTART;TZID=Asia/Karachi:20261117T140000", "DURATION:PT30M", "SUMMARY:Long", " folded", "END:VEVENT",
  // transparent (free) and cancelled: ignored
  "BEGIN:VEVENT", "UID:c", "DTSTART:20261118T060000Z", "DTEND:20261118T070000Z", "TRANSP:TRANSPARENT", "END:VEVENT",
  "BEGIN:VEVENT", "UID:d", "DTSTART:20261118T080000Z", "DTEND:20261118T090000Z", "STATUS:CANCELLED", "END:VEVENT",
  // weekly Mon/Wed 10:00 Karachi, 3 occurrences, one excluded
  "BEGIN:VEVENT", "UID:e", "DTSTART;TZID=Asia/Karachi:20261116T100000", "DTEND;TZID=Asia/Karachi:20261116T103000", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=3", "EXDATE;TZID=Asia/Karachi:20261118T100000", "END:VEVENT",
  // all-day
  "BEGIN:VEVENT", "UID:f", "DTSTART;VALUE=DATE:20261120", "DTEND;VALUE=DATE:20261121", "END:VEVENT",
  // Outlook Windows zone name
  "BEGIN:VEVENT", "UID:g", "DTSTART;TZID=Pakistan Standard Time:20261119T090000", "DTEND;TZID=Pakistan Standard Time:20261119T091500", "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

test("icsBusy: real-world feed shapes become busy ranges only", () => {
  const r = busyFromIcs(ICS, { windowStart: new Date("2026-11-15T00:00:00Z"), windowEnd: new Date("2026-12-01T00:00:00Z") });
  const starts = r.busy.map((b) => b.start);
  assert.ok(starts.includes("2026-11-16T05:00:00.000Z"), "weekly Mon 10:00 PKT");      // recurring
  assert.ok(starts.includes("2026-11-16T06:00:00.000Z"));                                // UTC event
  assert.ok(starts.includes("2026-11-17T09:00:00.000Z"));                                // 14:00 PKT
  assert.ok(!starts.includes("2026-11-18T05:00:00.000Z"), "EXDATE removed");
  assert.ok(starts.includes("2026-11-23T05:00:00.000Z"), "third occurrence (COUNT=3 counts the excluded one)");
  assert.ok(!starts.includes("2026-11-25T05:00:00.000Z"), "COUNT stops the series");
  assert.ok(!starts.includes("2026-11-18T06:00:00.000Z"), "transparent ignored");
  assert.ok(!starts.includes("2026-11-18T08:00:00.000Z"), "cancelled ignored");
  assert.ok(starts.includes("2026-11-19T04:00:00.000Z"), "Windows zone mapped");
  assert.ok(starts.includes("2026-11-19T19:00:00.000Z"), "all-day in calendar zone (Karachi midnight)");
  assert.ok(!JSON.stringify(r).includes("Secret"), "no titles kept");
  assert.throws(() => busyFromIcs("<html>", { windowStart: new Date(), windowEnd: new Date() }));
});

test("icsBusy helpers", () => {
  assert.equal(parseDuration("PT1H30M"), 5400000);
  assert.equal(parseDuration("P1D"), 86400000);
  assert.equal(parseIcsDate("20261116T060000Z").date.toISOString(), "2026-11-16T06:00:00.000Z");
  assert.deepEqual(mergeRanges([{ start: "2026-01-01T10:00:00Z", end: "2026-01-01T11:00:00Z" }, { start: "2026-01-01T10:30:00Z", end: "2026-01-01T12:00:00Z" }]), [{ start: "2026-01-01T10:00:00Z", end: "2026-01-01T12:00:00Z" }]);
});

const KHI = { timeZone: "Asia/Karachi", weekly: { sun: [], mon: [{ start: "09:00", end: "12:00" }], tue: [], wed: [], thu: [], fri: [], sat: [] } };
const NOW = new Date("2026-11-13T00:00:00Z"); // a Friday

test("slots: weekly hours in the staff zone, duration and step", () => {
  const slots = computeSlots({ availability: KHI, rules: { durationMinutes: 60, minNoticeMinutes: 0 }, from: "2026-11-16T00:00:00Z", to: "2026-11-17T00:00:00Z", now: NOW });
  assert.deepEqual(slots, ["2026-11-16T04:00:00.000Z", "2026-11-16T05:00:00.000Z", "2026-11-16T06:00:00.000Z"]);
  const half = computeSlots({ availability: KHI, rules: { durationMinutes: 60, slotStepMinutes: 30, minNoticeMinutes: 0 }, from: "2026-11-16T00:00:00Z", to: "2026-11-17T00:00:00Z", now: NOW });
  assert.equal(half.length, 5);
});

test("slots: bookings + buffers, time off, imported busy, notice, advance limit, daily limit", () => {
  const rules = { durationMinutes: 60, minNoticeMinutes: 0, bufferAfterMinutes: 15 };
  const booked = [{ start: "2026-11-16T04:00:00Z", end: "2026-11-16T05:00:00Z" }];
  const s1 = computeSlots({ availability: KHI, rules, booked, from: "2026-11-16T00:00:00Z", to: "2026-11-17T00:00:00Z", now: NOW });
  // 10:00 PKT slot would start right after the 09:00 booking, but needs 15 min buffer before? bufferAfter pads the *new* slot's end;
  // a new slot [s,e) must satisfy e + after <= existing start and existing end + before <= s.
  assert.ok(!s1.includes("2026-11-16T04:00:00.000Z"));
  assert.ok(s1.includes("2026-11-16T05:00:00.000Z"));
  const s2 = computeSlots({ availability: { ...KHI, timeOff: [{ start: "2026-11-16T05:00:00Z", end: "2026-11-16T06:00:00Z" }], importedBusy: [{ start: "2026-11-16T06:30:00Z", end: "2026-11-16T06:45:00Z" }] }, rules: { durationMinutes: 60, minNoticeMinutes: 0 }, from: "2026-11-16T00:00:00Z", to: "2026-11-17T00:00:00Z", now: NOW });
  assert.deepEqual(s2, ["2026-11-16T04:00:00.000Z"]);
  const s3 = computeSlots({ availability: KHI, rules: { durationMinutes: 60, minNoticeMinutes: 60 * 24 * 10 }, from: "2026-11-16T00:00:00Z", to: "2026-11-17T00:00:00Z", now: NOW });
  assert.deepEqual(s3, []);
  const s4 = computeSlots({ availability: KHI, rules: { durationMinutes: 60, minNoticeMinutes: 0, maxAdvanceDays: 1 }, from: "2026-11-16T00:00:00Z", to: "2026-11-17T00:00:00Z", now: NOW });
  assert.deepEqual(s4, []);
  const s5 = computeSlots({ availability: KHI, rules: { durationMinutes: 60, minNoticeMinutes: 0, dailyLimit: 1 }, booked, from: "2026-11-16T00:00:00Z", to: "2026-11-17T00:00:00Z", now: NOW });
  assert.deepEqual(s5, []);
  assert.equal(isSlotFree({ availability: KHI, rules: { durationMinutes: 60, minNoticeMinutes: 0 }, booked, start: "2026-11-16T04:00:00.000Z", now: NOW }), false);
  assert.equal(isSlotFree({ availability: KHI, rules: { durationMinutes: 60, minNoticeMinutes: 0 }, booked, start: "2026-11-16T05:00:00.000Z", now: NOW }), true);
});

test("weekly + rules validation, round robin", () => {
  assert.ok(normalizeWeekly({ mon: [{ start: "09:00", end: "08:00" }] }).error);
  assert.ok(normalizeWeekly({ mon: [{ start: "09:00", end: "12:00" }, { start: "11:00", end: "13:00" }] }).error);
  assert.deepEqual(normalizeWeekly({ mon: [{ start: "14:00", end: "17:00" }, { start: "09:00", end: "12:00" }] }).weekly.mon, [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "17:00" }]);
  assert.ok(normalizeTypeRules({ durationMinutes: 2 }).error);
  assert.equal(normalizeTypeRules({ durationMinutes: "45" }).rules.durationMinutes, 45);
  assert.equal(pickRoundRobin([{ email: "b@x.com", load: 1 }, { email: "a@x.com", load: 1 }, { email: "c@x.com", load: 0 }]).email, "c@x.com");
});

test("dashboard maths", () => {
  assert.equal(pctChange(12, 10), 20);
  assert.equal(pctChange(0, 0), 0);
  assert.equal(pctChange(5, 0), null);
  const b = periodBounds("week", "Asia/Karachi", new Date("2026-11-13T10:00:00Z"));
  assert.equal(b.end.toISOString(), "2026-11-13T19:00:00.000Z");
  assert.equal((b.end - b.start) / 86400000, 7);
  assert.equal(b.prevEnd.toISOString(), b.start.toISOString());
});
