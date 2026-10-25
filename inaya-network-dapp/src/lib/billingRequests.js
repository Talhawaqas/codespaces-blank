// src/lib/billingRequests.js
//
// PKR packages (src/lib/pkPricing.js) are paid by bank transfer, not card:
// 1. A company owner/admin picks a PKR package -> requestPkPlan() records a
//    pending request, marks the company as a PKR customer, lets it start
//    working on the free limits meanwhile, and emails Inaya and the requester.
// 2. Inaya sends the invoice; once the transfer arrives, an admin activates
//    the request on /admin/billing -> activatePkRequest() sets the plan.

import { getOrgCollections, toObjectId, canManageOrg } from "./orgs.js";
import { PK_PACKAGES, formatPkr, pkPilotPrice } from "./pkPricing.js";
import { PLANS } from "./orgPlans.js";
import { sendEmail } from "./email.js";
import { logOrgActivity } from "./org-activity-log.js";

const INTERVALS = ["month", "year"];
const MAX_MONTHS = 24;

async function requests() {
  const { db } = await getOrgCollections();
  return db.collection("billing_requests");
}

const amountFor = (planId, interval, pilot) => {
  const pk = PK_PACKAGES[planId];
  if (interval === "year") return pk.yearly;
  return pilot ? pkPilotPrice(pk.monthly) : pk.monthly;
};

/** Records a PKR package request for a company. One pending request per company; a new one replaces it. */
export async function requestPkPlan({ orgId, planId, interval = "month", pilot = false, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can choose the company's package.", status: 403 };
  if (!PK_PACKAGES[planId]) return { error: `Unknown package "${planId}".`, status: 400 };
  if (!INTERVALS.includes(interval)) return { error: "interval must be 'month' or 'year'.", status: 400 };

  const { orgs } = await getOrgCollections();
  const org = await orgs.findOne({ _id: toObjectId(orgId) });
  if (!org) return { error: "Company not found.", status: 404 };

  const now = new Date().toISOString();
  const amount = amountFor(planId, interval, pilot && interval === "month");
  const doc = {
    orgId: toObjectId(orgId), orgName: org.name || null, planId, interval, pilot: !!pilot && interval === "month",
    amountPkr: amount, status: "pending", requestedByEmail: actorEmail, requestedAt: now,
  };
  const col = await requests();
  await col.updateOne({ orgId: doc.orgId, status: "pending" }, { $set: doc }, { upsert: true });

  // A PKR customer from now on; it can start working on the free limits until the plan is active.
  const setFields = { billingRegion: "PK" };
  if (!org.plan) Object.assign(setFields, { requiresPlanSelection: false, noPlanConfirmedAt: org.noPlanConfirmedAt || now, noPlanConfirmedByEmail: org.noPlanConfirmedByEmail || actorEmail });
  await orgs.updateOne({ _id: doc.orgId }, { $set: setFields });

  await logOrgActivity({ orgId, recordType: "ORGANIZATION", recordId: orgId, actorEmail, action: "PK_PLAN_REQUESTED", previousState: org.plan || null, newState: planId, metadata: { interval, amountPkr: amount, pilot: doc.pilot } }).catch(() => {});

  const plan = PLANS[planId];
  const what = `${plan.name} (up to ${plan.maxUsers} users), ${formatPkr(amount)} per ${interval}${doc.pilot ? " (pilot price, 30% off)" : ""}`;
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

  return { request: { planId, interval, amountPkr: amount, pilot: doc.pilot, status: "pending" } };
}

/** Pending and recent requests for the admin page, newest first. */
export async function listBillingRequests({ limit = 100 } = {}) {
  const col = await requests();
  const rows = await col.find({}).sort({ requestedAt: -1 }).limit(limit).toArray();
  return rows.map((r) => ({
    id: String(r._id), orgId: String(r.orgId), orgName: r.orgName, planId: r.planId, interval: r.interval, pilot: !!r.pilot,
    amountPkr: r.amountPkr, status: r.status, requestedByEmail: r.requestedByEmail, requestedAt: r.requestedAt,
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
  await orgs.updateOne({ _id: reqDoc.orgId }, { $set: { plan: reqDoc.planId, planUpdatedAt: now.toISOString(), billingRegion: "PK", requiresPlanSelection: false } });
  await db.collection("org_subscriptions").updateOne(
    { orgId: reqDoc.orgId },
    { $set: { orgId: reqDoc.orgId, plan: reqDoc.planId, status: "active", provider: "bank_transfer", currency: "PKR", billingInterval: reqDoc.interval, currentPeriodEnd: paidUntil.toISOString(), updatedAt: now.toISOString() } },
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
