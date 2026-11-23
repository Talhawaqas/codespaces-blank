// src/lib/licensing/notices.js -- license notices to a company's Owners and Admins (SOW sections 8.2, 8.3, 14).
//
// Billing notices are transactional and mandatory (founder decision 7: all Owners and Admins): the e-mail is sent
// directly, not subject to personal notification preferences, and an in-app notice goes through the existing
// notification router ("billing.license"). Every notice is recorded once per license, notice type and billing
// period (a `license_notice` row with a unique dedupeKey), so a job retry never sends the same reminder twice; a
// failed send is retried by the next run (up to 5 times) and stays visible to the admin.
// Notices never contain internal admin notes, payment references or credentials.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { sendEmail } from "../email.js";
import { ACTIVATION_INBOX } from "../billingRequests.js";
import { formatBillingDateLong, formatDeadline, remaining } from "./dates.js";
import { GRACE_DAYS } from "./config.js";
import { licenseCollections } from "./service.js";

const APP = () => (process.env.NEXT_PUBLIC_APP_URL || "https://www.inayanetwork.com").replace(/\/$/, "");
const MAX_ATTEMPTS = 5;
const money = (amount, currency) => (currency === "PKR" ? `PKR ${Number(amount).toLocaleString("en-US")}` : `$${Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

export const NOTICE_TYPES = ["payment_due", "grace_started", "grace_daily", "suspended", "payment_confirmed", "reactivated", "plan_changed"];

/** Owners and Admins of the company: the billing contacts (decision 7). */
export async function billingContacts(orgId) {
  const { orgMembers } = await getOrgCollections();
  const rows = await orgMembers.find({ orgId: toObjectId(orgId), status: "active", role: { $in: ["owner", "admin"] } }, { projection: { email: 1 } }).toArray();
  return [...new Set(rows.map((r) => String(r.email || "").toLowerCase()).filter(Boolean))];
}

/** The words of each notice. Dates and remaining time always come from the stored deadlines (dates.js). */
export function noticeContent(type, { license, orgName, now = new Date() }) {
  const plan = license.planSnapshot?.name || license.planId;
  const due = license.nextPaymentDueDate ? formatBillingDateLong(license.nextPaymentDueDate) : null;
  const deadline = license.graceEndsAt ? formatDeadline(license.graceEndsAt) : null;
  const left = license.graceEndsAt ? remaining(license.graceEndsAt, now).label : null;
  // Whole days left, counted up (2 days 3 hours -> "3 days remaining"); the last day reads "1 day remaining".
  const daysLeft = license.graceEndsAt ? Math.max(1, Math.ceil(remaining(license.graceEndsAt, now).ms / 86400000)) : null;
  const daysText = `${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
  const amount = money(license.amount, license.currency);
  const billing = `${APP()}/business?view=billing`;
  const pay = `To pay, use NayaPay or a bank transfer. If you do not have our payment details, reply to this email or write to ${ACTIVATION_INBOX} with your company name, and we will send them.`;
  const exportLine = "Your company's data is safe. An Owner or Admin can download all of it at any time from Billing > Download company data.";
  const T = {
    payment_due: { subject: `${orgName}: your Business OS payment is due on ${due}`, title: "Your next payment is coming up", lines: [`Your ${plan} subscription (${amount} per ${license.billingCycle === "yearly" ? "year" : "month"}) is due on ${due}.`, pay] },
    grace_started: { subject: `${orgName}: Business OS payment overdue, ${GRACE_DAYS} days to pay`, title: "Your payment is overdue", lines: [`Your ${plan} subscription payment of ${amount} was due on ${due}.`, `You can keep using Business OS normally during a ${GRACE_DAYS}-day grace period. Your license will be suspended on ${deadline} (${left} from now) if payment is not confirmed by then.`, pay, exportLine] },
    grace_daily: daysLeft === 1
      ? { subject: `${orgName}: 1 day remaining until your Business OS license is suspended`, title: "Final day: 1 day remaining", lines: [`Your license will be suspended on ${deadline} (${left} from now) unless payment of ${amount} is confirmed.`, "If you decide not to continue, you can download your company data from Billing before and after suspension.", pay] }
      : { subject: `${orgName}: ${daysText} remaining until your Business OS license is suspended`, title: `${daysText} remaining`, lines: [`Your ${plan} payment of ${amount} (due ${due}) has not been received yet.`, `${daysText} remaining: your license will be suspended on ${deadline} unless payment is confirmed. You can keep working normally until then.`, pay, exportLine] },
    suspended: { subject: `${orgName}: Business OS license suspended`, title: "Your license is suspended", lines: [`Your Business OS license is suspended because payment of ${amount} (due ${due}) was not received within the ${GRACE_DAYS}-day grace period.`, "Nothing has been deleted. Owners and Admins can still sign in to Billing, contact support and download all company data.", "Access returns as soon as payment is confirmed.", pay] },
    payment_confirmed: { subject: `${orgName}: payment received, thank you`, title: "Payment confirmed", lines: [`Thank you. Your payment was confirmed and your ${plan} license is paid until ${formatBillingDateLong(license.paidThroughDate)}.`, `Your next payment is due on ${due}.`] },
    reactivated: { subject: `${orgName}: Business OS access is back`, title: "Your license is active again", lines: [license.overrideUntil ? `Access has been restored until ${formatDeadline(license.overrideUntil)} while your payment is arranged.` : `Your ${plan} license is active again, paid until ${formatBillingDateLong(license.paidThroughDate)}.`, "Everyone in your company can sign in and work as before."] },
    plan_changed: { subject: `${orgName}: your Business OS package changed`, title: "Package changed", lines: [`Your company is now on the ${plan} package (${amount} per ${license.billingCycle === "yearly" ? "year" : "month"}).`, due ? `Your next payment is due on ${due}.` : null].filter(Boolean) },
  };
  const t = T[type];
  if (!t) throw new Error(`Unknown license notice "${type}".`);
  return { ...t, link: billing };
}

// One notice per license, type and billing period; the daily grace reminder is also per day of grace.
const dedupeKeyFor = (type, license, day = null) => `license:${license.licenseId}:${type}:${["payment_confirmed", "reactivated", "plan_changed"].includes(type) ? `${license.licenseVersion || 0}` : license.paymentDueAt || "none"}${type === "grace_daily" ? `:day${day}` : ""}`;

/**
 * Sends one notice to all billing contacts, at most once per license / type / billing period.
 * Returns { sent, skipped, failed } -- never throws for a delivery problem (a state change must not wait on e-mail).
 */
export async function sendLicenseNotice({ orgId, type, license, now = new Date(), sender = sendEmail, day = null }) {
  const { ledger } = await licenseCollections();
  const { orgs } = await getOrgCollections();
  const dedupeKey = dedupeKeyFor(type, license, day);
  // Claim the notice: a new row, or a previously FAILED one that may be retried.
  let claim = null;
  try {
    await ledger.insertOne({ kind: "license_notice", orgId: toObjectId(orgId), licenseId: license.licenseId, noticeType: type, dedupeKey, noticeStatus: "sending", attempts: 1, createdAt: now.toISOString() });
    claim = "new";
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const r = await ledger.findOneAndUpdate({ dedupeKey, noticeStatus: "failed", attempts: { $lt: MAX_ATTEMPTS } }, { $set: { noticeStatus: "sending" }, $inc: { attempts: 1 } });
    claim = (r?.value ?? r) ? "retry" : null;
  }
  if (!claim) return { skipped: true, dedupeKey };

  const org = await orgs.findOne({ _id: toObjectId(orgId) }, { projection: { name: 1 } });
  const orgName = org?.name && org.name !== "(Company name not set)" ? org.name : "Your company";
  const content = noticeContent(type, { license, orgName, now });
  const recipients = await billingContacts(orgId);
  const results = [];
  for (const to of recipients) {
    const r = await sender({ to, replyTo: ACTIVATION_INBOX, subject: content.subject, text: [content.title, "", ...content.lines, "", `Billing: ${content.link}`, "", "Inaya Network"].join("\n") }).catch((e) => ({ sent: false, reason: e.message }));
    results.push({ to, sent: !!r?.sent, reason: r?.sent ? null : r?.reason || "not sent" });
  }
  // In-app notice for the same people (the router de-duplicates by dedupeKey).
  try {
    const { notifyEvent } = await import("../notify/router.js");
    await notifyEvent({ orgId: String(orgId), event: "billing.license", audience: "admins", title: content.title, body: content.lines[0], link: "/business?view=billing", sourceId: license.licenseId, dedupeKey, protectedContent: false, sender: async () => ({ sent: false, reason: "email_sent_separately" }) });
  } catch (e) { console.error("license in-app notice failed:", e.message); }
  const anySent = results.some((r) => r.sent);
  const status = recipients.length === 0 ? "no_recipients" : anySent ? "sent" : "failed";
  await ledger.updateOne({ dedupeKey }, { $set: { noticeStatus: status, sentAt: anySent ? now.toISOString() : null, recipients: results, updatedAt: now.toISOString() } });
  import("../metrics/metrics.js").then((m) => m.metric?.("license.notice", { orgId: String(orgId), label: `${type}:${status}` })).catch(() => {});
  return { sent: anySent, failed: status === "failed", status, dedupeKey, recipients: results.length };
}

/** Fire-and-forget notice after an admin action (payment confirmed, reactivated, plan changed, suspended). */
export async function notifyLicenseEvent({ orgId, type, license }) {
  if (!license?.licenseId) return null;
  return sendLicenseNotice({ orgId, type, license });
}
