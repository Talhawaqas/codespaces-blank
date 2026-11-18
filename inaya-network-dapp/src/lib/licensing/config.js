// src/lib/licensing/config.js -- Business Workspace company licenses: the policy settings in one place.
//
// Every value here is a founder decision (17 Nov 2026, License Manager SOW section 26) or a safe default the
// founder approved. Change them here, not in the UI, the jobs or the emails: those all read this file.

/** Billing timezone (decision 1): Pakistan time. PKT is UTC+5 all year (no daylight saving), so a fixed offset is exact. */
export const BILLING_TIMEZONE = "Asia/Karachi";
export const BILLING_TZ_LABEL = "PKT";
export const BILLING_TZ_OFFSET_MINUTES = 5 * 60;

/** The grace period after a missed payment: 14 calendar days, the same for monthly and yearly (founder, 17 Nov 2026). */
export const GRACE_DAYS = 14;

/**
 * Grace reminders (founder, 17 Nov 2026): EVERY day of the grace period, an e-mail and an in-app notice to Owners and
 * Admins -- "X days remaining until your license is suspended". Day 0 is the "payment overdue" notice; days 1 to the last
 * day are the daily reminder (the final day says so). One per day per license, never repeated by a re-run.
 */
export const DAILY_GRACE_REMINDERS = true;

/** Notice before the due date for active licenses ("payment due" reminder), in days. */
export const PAYMENT_DUE_NOTICE_DAYS = 7;

/** A grace extension needs a reason and may add at most this many days at a time (decision 9). */
export const MAX_GRACE_EXTENSION_DAYS = 30;

/** Billing cycles. Renewals use calendar months/years, keeping the original billing day (decision 4). */
export const BILLING_CYCLES = ["monthly", "yearly"];

/** Accepted payment methods (founder decision, 15 Nov 2026; "other" only when an admin chooses it explicitly). */
export const LICENSE_PAYMENT_METHODS = { nayapay: "NayaPay", bank_transfer: "Bank transfer", other_manual: "Other (manual)" };

export const CURRENCIES = ["USD", "PKR"];

/** How long a ready company-data ZIP can be downloaded before it is deleted. */
export const EXPORT_ARTIFACT_TTL_DAYS = 7;
/** File contents (S3 / NAS storage) included in one export ZIP, at most. Larger companies get the rest listed. */
export const EXPORT_FILE_BYTES_CAP = 400 * 1024 * 1024;
/** One export at a time per company, and at most this many requests a day. */
export const EXPORT_REQUESTS_PER_DAY = 5;

/** The name recorded on admin actions. The founder is the only admin (17 Nov 2026); set LICENSE_ADMIN_NAME to change it. */
export const adminActorName = () => (process.env.LICENSE_ADMIN_NAME || "Inaya admin").slice(0, 80);

/**
 * Automatic suspension (SOW 20.4 / 27.16): production suspension stays OFF until the founder approves the tested
 * recovery and export behaviour. Off = "dry run": the job still starts grace periods, sends reminders and records
 * that a company WOULD be suspended, but access is not restricted. Turn on with LICENSE_AUTO_SUSPEND=on.
 * Outside production (tests, local) it is on, so the behaviour can be exercised.
 */
export function autoSuspendEnabled() {
  const v = String(process.env.LICENSE_AUTO_SUSPEND || "").toLowerCase();
  if (v === "on" || v === "true" || v === "1") return true;
  if (v === "off" || v === "false" || v === "0") return false;
  return process.env.NODE_ENV !== "production";
}

/** Central enforcement of suspension on the server (the license gate). On by default; LICENSE_ENFORCEMENT=off is the kill switch. */
export function enforcementEnabled() {
  return String(process.env.LICENSE_ENFORCEMENT || "on").toLowerCase() !== "off";
}
