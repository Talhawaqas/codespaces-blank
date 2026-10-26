// src/lib/billingRequests.js
//
// PKR packages (src/lib/pkPricing.js) are paid by bank transfer, not card:
// 1. A company owner/admin picks a PKR package -> requestPkPlan() records a
//    pending request, marks the company as a PKR customer, lets it start
//    working on the free limits meanwhile, and emails Inaya and the requester.
// 2. Inaya sends the invoice; once the transfer arrives, an admin activates
//    the request on /admin/billing -> activatePkRequest() sets the plan.

import { getOrgCollections, toObjectId, canManageOrg } from "./orgs.js";
import { PK_PACKAGES, PK_EXTRA_USER_MONTHLY, PK_PILOT, formatPkr, pkPilotPrice, pkSetupFee } from "./pkPricing.js";
import { PLANS, planChangeError } from "./orgPlans.js";
import { sendEmail } from "./email.js";
import { logOrgActivity } from "./org-activity-log.js";

const INTERVALS = ["month", "year"];
const MAX_MONTHS = 24;
// The same package can be paid again (a renewal) once its period ends within this many days.
const RENEWAL_WINDOW_DAYS = 7;

async function requests() {
  const { db } = await getOrgCollections();
  return db.collection("billing_requests");
}

// Package plus extra users. A year costs 10 months, as for the package itself.
export const pkAmountFor = (planId, interval, pilot, extraUsers = 0) => {
  const pk = PK_PACKAGES[planId];
  if (interval === "year") return pk.yearly + extraUsers * PK_EXTRA_USER_MONTHLY * 10;
  const monthly = pk.monthly + extraUsers * PK_EXTRA_USER_MONTHLY;
  // An extra user in the pilot is exactly 30% off (PKR 1,750), as the proposal quotes; not rounded to 100.
  return pilot ? pkPilotPrice(pk.monthly) + (extraUsers * PK_EXTRA_USER_MONTHLY * (100 - PK_PILOT.discountPercent)) / 100 : monthly;
};

/** True when one of `emails` shares a domain with an outreach lead that was promised free setup. */
async function setupPromisedTo(emails) {
  const domains = [...new Set(emails.filter(Boolean).map((e) => String(e).toLowerCase().split("@")[1]).filter(Boolean))];
  if (!domains.length) return false;
  const { db } = await getOrgCollections();
  const leads = await db.collection("sales_leads").find({ setupFeeWaived: true }, { projection: { email: 1 } }).toArray();
  return leads.some((l) => domains.includes(String(l.email).toLowerCase().split("@")[1]));
}

/** Records a PKR package request for a company. One pending request per company; a new one replaces it. */
export async function requestPkPlan({ orgId, planId, interval = "month", pilot = false, extraUsers = 0, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can choose the company's package.", status: 403 };
  if (!PK_PACKAGES[planId]) return { error: `Unknown package "${planId}".`, status: 400 };
  if (!INTERVALS.includes(interval)) return { error: "interval must be 'month' or 'year'.", status: 400 };

  const { orgs } = await getOrgCollections();
  const org = await orgs.findOne({ _id: toObjectId(orgId) });
  if (!org) return { error: "Company not found.", status: 404 };

  // One package per company: while it is paid up, only a larger package or more extra users can be requested.
  const { db } = await getOrgCollections();
  const sub = await db.collection("org_subscriptions").findOne({ orgId: toObjectId(orgId) });
  const periodEnd = sub?.currentPeriodEnd ? new Date(sub.currentPeriodEnd).getTime() : 0;
  const active = !!org.plan && ["active", "trialing", "past_due"].includes(sub?.status) && periodEnd > Date.now();
  const extra = Number(extraUsers);
  const blocked = planChangeError({
    currentPlanId: org.plan, currentExtraUsers: org.extraUsers || 0, active,
    renewalDue: active && periodEnd - Date.now() <= RENEWAL_WINDOW_DAYS * 86400000, planId, extraUsers: extra,
  });
  if (blocked) return { error: blocked, status: 409 };

  // Pilot places: companies whose pilot package was activated. A company already in the pilot keeps
  // its pilot price; a new one gets it while places remain, otherwise the standard price.
  const col = await requests();
  const pilotOrgs = await col.distinct("orgId", { pilot: true, status: "active" });
  const inPilot = pilotOrgs.some((id) => String(id) === String(org._id));
  const pilotFull = !inPilot && pilotOrgs.length >= PK_PILOT.maxCompanies;
  const isPilot = !!pilot && interval === "month" && !pilotFull;
  // The one-time setup fee comes with a company's first package only, never on upgrades or renewals.
  // Free for the first 5 pilot companies, and for companies our outreach already promised free setup
  // (sales_leads.setupFeeWaived, matched on email domain); those don't use up one of the 5 places.
  let setupFeePkr = 0, setupFeeReason = null;
  if (!org.plan) {
    const promised = isPilot && (await setupPromisedTo([actorEmail, org.ownerEmail]));
    const freePlacesUsed = (await col.distinct("orgId", { pilot: true, status: "active", setupFeeReason: "first_five" })).length;
    setupFeePkr = promised ? 0 : pkSetupFee(planId, { pilot: isPilot, pilotsJoined: freePlacesUsed });
    setupFeeReason = promised ? "promised_in_outreach" : !isPilot ? "standard" : setupFeePkr ? "pilot_fee" : "first_five";
  }
  const now = new Date().toISOString();
  const amount = pkAmountFor(planId, interval, isPilot, extra);
  const doc = {
    orgId: toObjectId(orgId), orgName: org.name || null, planId, interval, pilot: isPilot,
    extraUsers: extra, amountPkr: amount, setupFeePkr, setupFeeReason, status: "pending", requestedByEmail: actorEmail, requestedAt: now,
  };
  await col.updateOne({ orgId: doc.orgId, status: "pending" }, { $set: doc }, { upsert: true });

  // A PKR customer from now on; it can start working on the free limits until the plan is active.
  const setFields = { billingRegion: "PK" };
  if (!org.plan) Object.assign(setFields, { requiresPlanSelection: false, noPlanConfirmedAt: org.noPlanConfirmedAt || now, noPlanConfirmedByEmail: org.noPlanConfirmedByEmail || actorEmail });
  await orgs.updateOne({ _id: doc.orgId }, { $set: setFields });

  await logOrgActivity({ orgId, recordType: "ORGANIZATION", recordId: orgId, actorEmail, action: "PK_PLAN_REQUESTED", previousState: org.plan || null, newState: planId, metadata: { interval, amountPkr: amount, pilot: doc.pilot } }).catch(() => {});

  const plan = PLANS[planId];
  const users = extra ? `${plan.maxUsers} users + ${extra} extra` : `up to ${plan.maxUsers} users`;
  const what = `${plan.name} (${users}), ${formatPkr(amount)} per ${interval}${doc.pilot ? " (pilot price, 30% off)" : ""}${setupFeePkr ? `, plus a one-time setup fee of ${formatPkr(setupFeePkr)}` : ""}`;
  const notify = process.env.BILLING_NOTIFY_EMAIL || process.env.HEALTH_REPORT_EMAIL;
  await Promise.all([
    notify && sendEmail({
      to: notify,
      subject: `New PKR package request: ${org.name || orgId}, ${plan.name}`,
      text: `${org.name || "A company"} asked for ${what}.\nRequested by: ${actorEmail}\nCompany id: ${orgId}\n\nSend the invoice with your bank details, then activate it at https://www.inayanetwork.com/admin/billing once the transfer arrives.`,
    }),
    sendEmail({
      to: actorEmail,
      subject: "Your Inaya package request",
      text: `Thank you. We received your request for ${what}.\n\nWithin one working day we will email you an invoice with our bank details. Your package is activated as soon as the transfer arrives. Until then your team can already start using Inaya.\n\nQuestions: reply to this email.\n\nInaya Network`,
    }),
  ].filter(Boolean)).catch(() => {});

  return { request: { planId, interval, extraUsers: extra, amountPkr: amount, setupFeePkr, pilot: doc.pilot, pilotFull: !!pilot && pilotFull, status: "pending" } };
}

/** Pending and recent requests for the admin page, newest first. */
export async function listBillingRequests({ limit = 100 } = {}) {
  const col = await requests();
  const rows = await col.find({}).sort({ requestedAt: -1 }).limit(limit).toArray();
  return rows.map((r) => ({
    id: String(r._id), orgId: String(r.orgId), orgName: r.orgName, planId: r.planId, interval: r.interval, pilot: !!r.pilot,
    extraUsers: r.extraUsers || 0, amountPkr: r.amountPkr, setupFeePkr: r.setupFeePkr || 0, setupFeeReason: r.setupFeeReason || null, status: r.status, requestedByEmail: r.requestedByEmail, requestedAt: r.requestedAt,
    activatedAt: r.activatedAt || null, paidUntil: r.paidUntil || null, paymentReference: r.paymentReference || null,
  }));
}

/** Activates a pending request after payment: sets the company's plan, paid for `months`. */
export async function activatePkRequest({ requestId, months, paymentReference, adminLabel = "admin" }) {
  const m = Number(months);
  if (!Number.isInteger(m) || m < 1 || m > MAX_MONTHS) return { error: `months must be a whole number from 1 to ${MAX_MONTHS}.`, status: 400 };
  const col = await requests();
  const reqDoc = await col.findOne({ _id: toObjectId(requestId) });
  if (!reqDoc) return { error: "Request not found.", status: 404 };
  if (reqDoc.status !== "pending") return { error: `This request is already ${reqDoc.status}.`, status: 409 };

  const now = new Date();
  const paidUntil = new Date(now);
  paidUntil.setMonth(paidUntil.getMonth() + m);
  const { orgs, db } = await getOrgCollections();
  await orgs.updateOne({ _id: reqDoc.orgId }, { $set: { plan: reqDoc.planId, extraUsers: reqDoc.extraUsers || 0, planUpdatedAt: now.toISOString(), billingRegion: "PK", requiresPlanSelection: false } });
  await db.collection("org_subscriptions").updateOne(
    { orgId: reqDoc.orgId },
    { $set: { orgId: reqDoc.orgId, plan: reqDoc.planId, status: "active", provider: "bank_transfer", currency: "PKR", billingInterval: reqDoc.interval, pilot: !!reqDoc.pilot, currentPeriodEnd: paidUntil.toISOString(), updatedAt: now.toISOString() } },
    { upsert: true }
  );
  await col.updateOne({ _id: reqDoc._id }, { $set: { status: "active", activatedAt: now.toISOString(), paidUntil: paidUntil.toISOString(), paymentReference: String(paymentReference || "").slice(0, 120) || null, activatedBy: adminLabel } });
  await logOrgActivity({ orgId: String(reqDoc.orgId), recordType: "ORGANIZATION", recordId: String(reqDoc.orgId), actorEmail: adminLabel, action: "PK_PLAN_ACTIVATED", previousState: null, newState: reqDoc.planId, metadata: { months: m, paidUntil: paidUntil.toISOString() } }).catch(() => {});

  if (reqDoc.requestedByEmail) {
    await sendEmail({
      to: reqDoc.requestedByEmail,
      subject: "Your Inaya package is active",
      text: `Thank you for your payment. Your ${PLANS[reqDoc.planId].name} package is now active, paid until ${paidUntil.toISOString().slice(0, 10)}.\n\nInaya Network`,
    }).catch(() => {});
  }
  return { activated: true, paidUntil: paidUntil.toISOString() };
}

/** Marks a pending request as declined (for example a duplicate or a mistake). */
export async function declinePkRequest({ requestId }) {
  const col = await requests();
  const r = await col.updateOne({ _id: toObjectId(requestId), status: "pending" }, { $set: { status: "declined", declinedAt: new Date().toISOString() } });
  return r.matchedCount ? { declined: true } : { error: "No pending request with that id.", status: 404 };
}
