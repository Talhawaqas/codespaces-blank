// src/lib/licensing/dates.js -- the ONE place license dates are calculated (SOW 4.2, 4.5, 26).
//
// Model (founder decisions, 17 Nov 2026):
//   - A billing date is a calendar date (YYYY-MM-DD) in the billing timezone (PKT, UTC+5, no daylight saving).
//   - A period runs from its start date up to (not including) its end date. The end date is also the next payment's
//     due date: "paid until 2027-02-01, next payment due 2027-02-01".
//   - A payment is due by the END of its due date in PKT. That instant is `paymentDueAt` (stored in UTC).
//   - The grace period starts at `paymentDueAt` and ends exactly GRACE_DAYS calendar days later (`graceEndsAt`).
//   - Monthly/yearly renewals keep the original billing day ("anchor day"): 31 Jan -> 28/29 Feb -> 31 Mar.
//     A 29 Feb anchor renews on 28 Feb in non-leap years and on 29 Feb again in leap years.
// Nothing else in the codebase may compute these dates; the API, UI, emails, jobs and Excel export all use these.

import { BILLING_TZ_OFFSET_MINUTES, GRACE_DAYS, BILLING_TZ_LABEL } from "./config.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const OFFSET_MS = BILLING_TZ_OFFSET_MINUTES * 60 * 1000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (n) => String(n).padStart(2, "0");
const daysInMonth = (y, m /* 1-12 */) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Validates and normalises a YYYY-MM-DD billing date. Throws on anything else. */
export function parseBillingDate(s) {
  const m = DATE_RE.exec(String(s || "").trim());
  if (!m) throw new Error(`Not a date (YYYY-MM-DD): ${s}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) throw new Error(`Not a real calendar date: ${s}`);
  return { y, m: mo, d };
}
export const formatBillingDate = ({ y, m, d }) => `${y}-${pad(m)}-${pad(d)}`;

/** The billing date (in PKT) that contains a given instant. */
export function billingDateOf(instant) {
  const t = new Date(new Date(instant).getTime() + OFFSET_MS);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Start of a billing date (00:00 PKT) as a UTC Date. */
export function startOfBillingDate(dateStr) {
  const { y, m, d } = parseBillingDate(dateStr);
  return new Date(Date.UTC(y, m - 1, d) - OFFSET_MS);
}

/** The instant a payment due on `dateStr` becomes overdue: the end of that date in PKT (= start of the next day). */
export function paymentDueAt(dateStr) {
  return new Date(startOfBillingDate(dateStr).getTime() + DAY_MS);
}

/** The end of the grace period for a payment due on `dateStr`, optionally extended by `extraDays`. */
export function graceEndsAt(dateStr, extraDays = 0) {
  return new Date(paymentDueAt(dateStr).getTime() + (GRACE_DAYS + Number(extraDays || 0)) * DAY_MS);
}

/**
 * Adds `count` billing cycles to a date, keeping the anchor day (decision 4).
 * `anchorDay` is the original billing day (1-31); when the target month is shorter, the last day is used.
 */
export function addCycles(dateStr, cycle, count = 1, anchorDay = null) {
  if (cycle !== "monthly" && cycle !== "yearly") throw new Error(`Unknown billing cycle: ${cycle}`);
  const { y, m, d } = parseBillingDate(dateStr);
  const anchor = Number(anchorDay) || d;
  const months = (cycle === "monthly" ? 1 : 12) * Number(count);
  const total = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(total / 12); const nm = (total % 12) + 1;
  return formatBillingDate({ y: ny, m: nm, d: Math.min(anchor, daysInMonth(ny, nm)) });
}

/** Whole calendar days between two billing dates (b - a). */
export function daysBetween(a, b) {
  return Math.round((startOfBillingDate(b).getTime() - startOfBillingDate(a).getTime()) / DAY_MS);
}

/** Remaining time until `deadline` (ISO/Date) from `now`: { ms, days, hours, label } -- never negative. */
export function remaining(deadline, now = new Date()) {
  const ms = Math.max(0, new Date(deadline).getTime() - new Date(now).getTime());
  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / (60 * 60 * 1000));
  const label = ms === 0 ? "now" : days >= 1 ? `${days} day${days === 1 ? "" : "s"}${hours ? ` ${hours} hour${hours === 1 ? "" : "s"}` : ""}` : `${Math.max(1, Math.ceil(ms / (60 * 60 * 1000)))} hour${Math.ceil(ms / (60 * 60 * 1000)) === 1 ? "" : "s"}`;
  return { ms, days, hours, label };
}

/** How a deadline instant reads to a person: "5 Feb 2027, 23:59 PKT" (the last minute before it passes). */
export function formatDeadline(instant) {
  const t = new Date(new Date(instant).getTime() + OFFSET_MS - 60 * 1000);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${t.getUTCDate()} ${months[t.getUTCMonth()]} ${t.getUTCFullYear()}, ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())} ${BILLING_TZ_LABEL}`;
}

/** A billing date as a person reads it: "1 Feb 2027". */
export function formatBillingDateLong(dateStr) {
  const { y, m, d } = parseBillingDate(dateStr);
  return `${d} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${y}`;
}

/** Day number within the grace period (0 on the first day) for `now`, or null if grace has not started. */
export function graceDay(dueDateStr, now = new Date()) {
  const start = paymentDueAt(dueDateStr).getTime();
  const t = new Date(now).getTime();
  return t < start ? null : Math.floor((t - start) / DAY_MS);
}
