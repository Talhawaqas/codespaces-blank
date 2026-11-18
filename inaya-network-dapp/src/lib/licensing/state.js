// src/lib/licensing/state.js -- the license state machine (SOW section 5) and the access matrix (SOW 9.2).
//
// The stored `licenseStatus` changes only through src/lib/licensing/service.js (and the scheduled job). What a
// company may do RIGHT NOW is `effectiveState(license, now)`: it reads the stored deadlines (paymentDueAt,
// graceEndsAt, cancelEffectiveAt, overrideUntil) so access is correct at the exact deadline even before the job has
// run, and every surface (gate, Billing page, banner, emails, admin table, Excel) shows the same state.

import { autoSuspendEnabled } from "./config.js";

export const LICENSE_STATES = ["pending_activation", "active", "grace_period", "suspended", "cancelled", "expired", "admin_override"];

/** Allowed stored transitions (from -> to). Anything else is refused by assertTransition. */
export const TRANSITIONS = {
  pending_activation: ["active", "cancelled"],
  active: ["active", "grace_period", "suspended", "cancelled"],
  grace_period: ["active", "grace_period", "suspended", "cancelled"],
  suspended: ["active", "grace_period", "cancelled"],
  cancelled: ["active"], // only by an explicit re-activation with a confirmed payment
  expired: ["active"],
};

export function assertTransition(from, to) {
  if (!(TRANSITIONS[from] || []).includes(to)) {
    const e = new Error(`A license cannot go from ${from} to ${to}.`); e.status = 409; e.code = "INVALID_TRANSITION"; throw e;
  }
}

const t = (v) => (v ? new Date(v).getTime() : null);

/**
 * The state that governs access at `now`.
 * Returns { state, access: "normal"|"restricted", reason, deadline?, suspensionDue? }.
 *   none                -- no license record (legacy / pilot / not yet assigned): existing onboarding rules apply
 *   pending_activation  -- assigned, first payment not confirmed: existing plan-selection rules apply
 *   active / grace_period / admin_override -- normal access
 *   suspended / cancelled / expired       -- restricted (Billing, support, export only)
 */
export function effectiveState(license, now = new Date(), { autoSuspend = autoSuspendEnabled() } = {}) {
  const n = new Date(now).getTime();
  if (!license?.licenseId) return { state: "none", access: "normal", reason: "no_license" };
  const s = license.licenseStatus;
  if (s === "pending_activation") return { state: "pending_activation", access: "normal", reason: "awaiting_first_payment" };
  if (s === "cancelled") {
    const eff = t(license.cancelEffectiveAt);
    return eff && n < eff ? { state: "active", access: "normal", reason: "cancellation_scheduled", deadline: license.cancelEffectiveAt, cancelling: true }
      : { state: "cancelled", access: "restricted", reason: "cancelled" };
  }
  if (s === "expired") return { state: "expired", access: "restricted", reason: "expired" };
  if (t(license.overrideUntil) && n < t(license.overrideUntil)) return { state: "admin_override", access: "normal", reason: "admin_override", deadline: license.overrideUntil };
  if (s === "suspended") return { state: "suspended", access: "restricted", reason: license.suspendedReason || "suspended" };
  // active / grace_period: decided by the stored deadlines
  const due = t(license.paymentDueAt); const graceEnd = t(license.graceEndsAt);
  if (!due || n < due) return { state: "active", access: "normal", reason: "paid", deadline: license.paymentDueAt };
  if (n < graceEnd) return { state: "grace_period", access: "normal", reason: "payment_overdue", deadline: license.graceEndsAt };
  if (autoSuspend) return { state: "suspended", access: "restricted", reason: "grace_ended", deadline: license.graceEndsAt };
  // Dry run (automatic suspension not yet approved for production): still overdue, access stays normal.
  return { state: "grace_period", access: "normal", reason: "grace_ended_dry_run", deadline: license.graceEndsAt, suspensionDue: true };
}

/** Customer-facing words for a state (never the internal names, SOW 18.3). */
export const STATE_LABELS = {
  none: "No license", pending_activation: "Awaiting first payment", active: "Active", grace_period: "Payment overdue",
  suspended: "Suspended", cancelled: "Cancelled", expired: "Expired", admin_override: "Active (extended by Inaya)",
};
