// test/license-dates.test.mjs -- License Manager SOW 4.2 / 4.5 / 21.1: the one date utility. Pure, no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addCycles, paymentDueAt, graceEndsAt, billingDateOf, remaining, graceDay, formatDeadline, parseBillingDate, daysBetween } from "../src/lib/licensing/dates.js";
import { effectiveState, assertTransition } from "../src/lib/licensing/state.js";
import { GRACE_DAYS } from "../src/lib/licensing/config.js";

test("monthly renewals keep the billing day; month-end clamps and comes back (decision 4)", () => {
  assert.equal(addCycles("2027-01-15", "monthly"), "2027-02-15");
  assert.equal(addCycles("2027-01-31", "monthly", 1, 31), "2027-02-28");
  assert.equal(addCycles("2027-02-28", "monthly", 1, 31), "2027-03-31", "the anchor day 31 returns after a short month");
  assert.equal(addCycles("2028-01-31", "monthly", 1, 31), "2028-02-29", "leap February");
  assert.equal(addCycles("2027-12-10", "monthly"), "2028-01-10", "across the year end");
  assert.equal(addCycles("2027-01-31", "monthly", 3, 31), "2027-04-30");
});

test("yearly renewals: same date next year; 29 Feb renews on 28 Feb, and on 29 Feb again in a leap year", () => {
  assert.equal(addCycles("2027-03-01", "yearly"), "2028-03-01");
  assert.equal(addCycles("2028-02-29", "yearly", 1, 29), "2029-02-28");
  assert.equal(addCycles("2029-02-28", "yearly", 3, 29), "2032-02-29");
  assert.throws(() => addCycles("2027-01-01", "weekly"));
  assert.throws(() => parseBillingDate("2027-02-30"));
});

test("a payment is due at the END of its due date in PKT (UTC+5); grace ends exactly 14 days later", () => {
  assert.equal(GRACE_DAYS, 14);
  // 1 Feb 2027 in PKT ends at 2 Feb 00:00 PKT = 1 Feb 19:00 UTC
  assert.equal(paymentDueAt("2027-02-01").toISOString(), "2027-02-01T19:00:00.000Z");
  assert.equal(graceEndsAt("2027-02-01").toISOString(), "2027-02-15T19:00:00.000Z");
  assert.equal(graceEndsAt("2027-02-01", 5).toISOString(), "2027-02-20T19:00:00.000Z", "an extension adds whole days");
  assert.equal(billingDateOf("2027-02-01T18:59:59Z"), "2027-02-01");
  assert.equal(billingDateOf("2027-02-01T19:00:00Z"), "2027-02-02", "PKT midnight");
  assert.equal(formatDeadline(paymentDueAt("2027-02-01")), "1 Feb 2027, 23:59 PKT");
  assert.equal(daysBetween("2027-02-01", "2027-03-01"), 28);
});

test("remaining time and grace day count down from the stored deadline", () => {
  const end = graceEndsAt("2027-02-01");
  assert.equal(remaining(end, new Date(end.getTime() - 3 * 86400000 - 2 * 3600000)).label, "3 days 2 hours");
  assert.equal(remaining(end, new Date(end.getTime() - 30 * 60000)).label, "1 hour");
  assert.equal(remaining(end, new Date(end.getTime() + 1000)).ms, 0, "never negative");
  const due = paymentDueAt("2027-02-01");
  assert.equal(graceDay("2027-02-01", new Date(due.getTime() - 1)), null);
  assert.equal(graceDay("2027-02-01", due), 0);
  assert.equal(graceDay("2027-02-01", new Date(due.getTime() + 7 * 86400000)), 7);
});

test("effective state at the boundaries: before due, at due, in grace, one minute before the end, at the end", () => {
  const lic = { licenseId: "lic_x", licenseStatus: "active", paymentDueAt: paymentDueAt("2027-02-01").toISOString(), graceEndsAt: graceEndsAt("2027-02-01").toISOString() };
  const due = new Date(lic.paymentDueAt).getTime(); const end = new Date(lic.graceEndsAt).getTime();
  assert.equal(effectiveState(lic, new Date(due - 1)).state, "active");
  assert.equal(effectiveState(lic, new Date(due)).state, "grace_period", "exactly at the due instant");
  assert.equal(effectiveState(lic, new Date(due + 7 * 86400000)).access, "normal", "normal access during grace");
  assert.equal(effectiveState(lic, new Date(end - 60000), { autoSuspend: true }).state, "grace_period", "one minute before the end");
  assert.equal(effectiveState(lic, new Date(end), { autoSuspend: true }).state, "suspended", "exactly at the end");
  const dry = effectiveState(lic, new Date(end + 1), { autoSuspend: false });
  assert.equal(dry.state, "grace_period"); assert.equal(dry.access, "normal"); assert.equal(dry.suspensionDue, true, "dry run: access unchanged, flagged");
  assert.equal(effectiveState(null).state, "none");
  assert.equal(effectiveState({ ...lic, overrideUntil: new Date(end + 86400000).toISOString() }, new Date(end + 1), { autoSuspend: true }).state, "admin_override");
  assert.equal(effectiveState({ ...lic, licenseStatus: "cancelled", cancelEffectiveAt: new Date(due).toISOString() }, new Date(due - 1)).access, "normal", "cancelled keeps access to the paid-through date");
  assert.equal(effectiveState({ ...lic, licenseStatus: "cancelled", cancelEffectiveAt: new Date(due).toISOString() }, new Date(due)).access, "restricted");
});

test("the state machine refuses backwards and arbitrary moves", () => {
  assertTransition("active", "grace_period"); assertTransition("grace_period", "suspended"); assertTransition("suspended", "active");
  assert.throws(() => assertTransition("suspended", "pending_activation"), /cannot go/);
  assert.throws(() => assertTransition("pending_activation", "suspended"), /cannot go/);
  assert.throws(() => assertTransition("cancelled", "grace_period"), /cannot go/);
});
