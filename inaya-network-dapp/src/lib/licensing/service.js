// src/lib/licensing/service.js -- Business Workspace company licenses: the ONLY code that changes a license.
//
// Storage (Atlas is at its collection limit, so no new collections):
//   org_subscriptions  -- the license itself, one document per company (unique orgId). The older fields
//                         (plan, status, currentPeriodEnd, billingInterval, provider) are kept in sync so every
//                         existing reader keeps working.
//   billing_requests   -- append-only history next to the existing activation requests, told apart by `kind`:
//                         license_period (subscription versions), license_payment, license_event (audit),
//                         license_notice (sent reminders, de-duplication), company_export (export jobs).
//                         None of these carry the requests' own `status` field, so request queries never see them.
// Money and access decisions are founder policy (config.js); dates come only from dates.js; access only from
// state.js. Every action writes one license_event, and multi-document changes run in a transaction.

import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { connectToDatabase } from "../mongodb.js";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { PLANS } from "../orgPlans.js";
import { logOrgActivity } from "../org-activity-log.js";
import { BILLING_CYCLES, CURRENCIES, LICENSE_PAYMENT_METHODS, MAX_GRACE_EXTENSION_DAYS, adminActorName } from "./config.js";
import { addCycles, billingDateOf, graceEndsAt, parseBillingDate, paymentDueAt } from "./dates.js";
import { assertTransition, effectiveState } from "./state.js";

export class LicenseError extends Error {
  constructor(status, message, code = "LICENSE_ERROR") { super(message); this.status = status; this.code = code; }
}
const fail = (status, message, code) => { throw new LicenseError(status, message, code); };

// ------------------------------------------------------------------------------------------- collections
let indexesReady = null;
export async function licenseCollections() {
  const { db } = await getOrgCollections();
  const subs = db.collection("org_subscriptions");
  const ledger = db.collection("billing_requests");
  if (!indexesReady) {
    indexesReady = Promise.all([
      // One license per company. Built once; if old duplicate rows exist the build fails loudly in the log and the
      // service still refuses duplicates in code (assignLicense checks first).
      subs.createIndex({ orgId: 1 }, { unique: true, name: "license_org_unique" }).catch((e) => console.error("licensing: unique orgId index on org_subscriptions not built:", e.message)),
      subs.createIndex({ licenseStatus: 1, paymentDueAt: 1 }, { name: "license_status_due", partialFilterExpression: { licenseId: { $exists: true } } }),
      subs.createIndex({ licenseStatus: 1, graceEndsAt: 1 }, { name: "license_status_grace", partialFilterExpression: { licenseId: { $exists: true } } }),
      ledger.createIndex({ kind: 1, orgId: 1, createdAt: -1 }, { name: "ledger_kind_org_time", partialFilterExpression: { kind: { $exists: true } } }),
      ledger.createIndex({ idempotencyKey: 1 }, { unique: true, name: "ledger_idempotency", partialFilterExpression: { idempotencyKey: { $type: "string" } } }),
      ledger.createIndex({ dedupeKey: 1 }, { unique: true, name: "ledger_notice_dedupe", partialFilterExpression: { dedupeKey: { $type: "string" } } }),
      ledger.createIndex({ kind: 1, paymentStatus: 1, confirmedAt: -1 }, { name: "ledger_payments", partialFilterExpression: { kind: "license_payment" } }),
      ledger.createIndex({ kind: 1, exportStatus: 1, expiresAt: 1 }, { name: "ledger_exports", partialFilterExpression: { kind: "company_export" } }),
    ]).catch((e) => { indexesReady = null; throw e; });
  }
  await indexesReady;
  return { db, subs, ledger };
}

async function withTxn(fn) {
  const { client } = await connectToDatabase();
  const session = client.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await fn(session); }, { readPreference: "primary", readConcern: { level: "local" }, writeConcern: { w: "majority" } });
    return result;
  } finally { await session.endSession(); }
}

// ------------------------------------------------------------------------------------------- helpers
const nowIso = () => new Date().toISOString();
const newLicenseId = () => `lic_${randomBytes(9).toString("hex")}`;
const correlationId = () => `cor_${randomBytes(8).toString("hex")}`;
const clean = (v, max = 500) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
const money = (v) => { const n = Math.round(Number(v) * 100) / 100; return Number.isFinite(n) ? n : NaN; };
const requireReason = (reason, what) => { const r = clean(reason, 500); if (r.length < 3) fail(400, `A reason is required to ${what}.`, "REASON_REQUIRED"); return r; };

export function planSnapshot(planId) {
  const p = PLANS[planId];
  if (!p || p.noBilling) fail(400, `Unknown Business Workspace package "${planId}".`, "UNKNOWN_PLAN");
  return { id: p.id, name: p.name, maxUsers: p.maxUsers, maxExtraUsers: p.maxExtraUsers ?? null, maxStorageGB: p.maxStorageGB ?? null, maxFileSizeMB: p.maxFileSizeMB ?? null, priceMonthlyUsd: p.priceMonthly, priceYearlyUsd: p.priceYearly };
}

/** The fields a license carries for one paid-through date, all from dates.js. */
function deadlinesFor(paidThroughDate, extraGraceDays = 0) {
  return { paidThroughDate, nextPaymentDueDate: paidThroughDate, paymentDueAt: paymentDueAt(paidThroughDate).toISOString(), graceEndsAt: graceEndsAt(paidThroughDate, extraGraceDays).toISOString() };
}

/** Old fields other code still reads (billing page, admin dashboard, support agent). */
function legacyFields(lic) {
  const status = { active: "active", grace_period: "past_due", suspended: "suspended", cancelled: "canceled", expired: "canceled", pending_activation: "pending" }[lic.licenseStatus] || lic.licenseStatus;
  return { plan: lic.planId, status, currentPeriodEnd: lic.paidThroughDate ? startIso(lic.paidThroughDate) : null, billingInterval: lic.billingCycle === "yearly" ? "year" : "month", provider: lic.lastPaymentMethod || "bank_transfer", currency: lic.currency };
}
const startIso = (d) => paymentDueAt(d).toISOString();

async function event(ledger, session, { lic, orgId, type, actor = adminActorName(), actorType = "admin", source = "admin_portal", previousState = null, newState = null, previousValues = null, newValues = null, reason = null, paymentId = null, subscriptionId = null, correlation = null, metadata = null }) {
  const doc = {
    kind: "license_event", orgId: toObjectId(orgId), licenseId: lic?.licenseId || null, subscriptionId: subscriptionId || lic?.currentSubscriptionId || null, paymentId,
    eventType: type, actorType, actorId: actor, at: nowIso(), createdAt: nowIso(), previousState, newState, previousValues, newValues, reason, source, correlationId: correlation || correlationId(), metadata,
  };
  await ledger.insertOne(doc, session ? { session } : undefined);
  return doc;
}

function activityLog(orgId, action, metadata) {
  // Company-visible activity (Owner/Admin activity feed); never includes internal notes.
  logOrgActivity({ orgId: String(orgId), recordType: "ORGANIZATION", recordId: String(orgId), actorEmail: "Inaya billing", action, previousState: null, newState: null, metadata }).catch(() => {});
}

// ------------------------------------------------------------------------------------------- reads
export async function getLicense(orgId) {
  const { subs } = await licenseCollections();
  const lic = await subs.findOne({ orgId: toObjectId(orgId) });
  return lic?.licenseId ? lic : null;
}

/** A license as the company's Owner/Admin may see it (no internal notes, no admin names). */
export function publicLicenseView(lic, now = new Date()) {
  if (!lic) return null;
  const eff = effectiveState(lic, now);
  return {
    licenseId: lic.licenseId, state: eff.state, access: eff.access, reason: eff.reason, deadline: eff.deadline || null, cancelling: !!eff.cancelling,
    plan: lic.planSnapshot, billingCycle: lic.billingCycle, currency: lic.currency, amount: lic.amount,
    activatedAt: lic.activatedAt || null, paidThroughDate: lic.paidThroughDate || null, nextPaymentDueDate: lic.nextPaymentDueDate || null,
    paymentDueAt: lic.paymentDueAt || null, graceEndsAt: lic.graceEndsAt || null, suspendedAt: lic.suspendedAt || null,
    lastPaymentAt: lic.lastPaymentAt || null, lastPaymentMethod: lic.lastPaymentMethod || null, cancelEffectiveAt: lic.cancelEffectiveAt || null,
  };
}

// ------------------------------------------------------------------------------------------- assign
/**
 * Assigns a license to an existing company (SOW 6.3). `firstPayment` is the explicit decision the SOW requires:
 *   { status: "awaiting" }                                   -> license is pending_activation until a payment is confirmed
 *   { status: "confirmed", method, reference, receivedAt }   -> payment received: recorded, confirmed, license active
 * Founder decision 2: a license is active only after payment is confirmed.
 */
export async function assignLicense({ orgId, planId, billingCycle, currency, amount, startDate, firstPayment, note = null, actor = adminActorName(), idempotencyKey = null }) {
  const { subs, ledger } = await licenseCollections();
  const { orgs } = await getOrgCollections();
  const oid = toObjectId(orgId);
  const org = await orgs.findOne({ _id: oid }, { projection: { name: 1 } });
  if (!org) fail(404, "No company with that id.", "ORG_NOT_FOUND");
  const snapshot = planSnapshot(planId);
  if (!BILLING_CYCLES.includes(billingCycle)) fail(400, "Billing cycle must be monthly or yearly.", "BAD_CYCLE");
  if (!CURRENCIES.includes(currency)) fail(400, "Currency must be USD or PKR.", "BAD_CURRENCY");
  const amt = money(amount);
  if (!(amt > 0) || amt > 10_000_000) fail(400, "Enter the agreed amount (more than 0).", "BAD_AMOUNT");
  try { parseBillingDate(startDate); } catch { fail(400, "Start date must be a real date (YYYY-MM-DD).", "BAD_DATE"); }
  if (!firstPayment || !["awaiting", "confirmed"].includes(firstPayment.status)) fail(400, "Decide whether the first period is already paid or awaiting payment.", "FIRST_PAYMENT_DECISION");
  if (firstPayment.status === "confirmed") validatePaymentInput(firstPayment);

  const existing = await subs.findOne({ orgId: oid });
  if (existing?.licenseId && !["cancelled", "expired"].includes(existing.licenseStatus)) fail(409, "This company already has a license. Change it instead of assigning a new one.", "DUPLICATE_LICENSE");
  if (idempotencyKey) { const prior = await ledger.findOne({ idempotencyKey: `assign:${idempotencyKey}` }); if (prior) return { license: await getLicense(orgId), replayed: true }; }

  const anchorDay = parseBillingDate(startDate).d;
  const paidThroughDate = addCycles(startDate, billingCycle, 1, anchorDay);
  const corr = correlationId();
  const result = await withTxn(async (session) => {
    const periodId = new ObjectId();
    const lic = {
      orgId: oid, licenseId: newLicenseId(), licenseStatus: "pending_activation", planId, planSnapshot: snapshot, billingCycle, currency, amount: amt, anchorDay,
      startDate, currentSubscriptionId: periodId, graceExtensionDays: 0, licenseVersion: 1,
      createdAt: nowIso(), createdBy: actor, updatedAt: nowIso(), updatedBy: actor, notes: note ? [{ at: nowIso(), by: actor, text: clean(note, 2000) }] : [],
      previousLicense: existing?.licenseId ? { licenseId: existing.licenseId, status: existing.licenseStatus, endedAt: existing.cancelEffectiveAt || existing.suspendedAt || nowIso() } : (existing ? { legacy: { plan: existing.plan || null, status: existing.status || null, currentPeriodEnd: existing.currentPeriodEnd || null } } : null),
    };
    await ledger.insertOne({ _id: periodId, kind: "license_period", orgId: oid, licenseId: lic.licenseId, version: 1, planSnapshot: snapshot, billingCycle, currency, amount: amt, periodStartDate: startDate, periodEndDate: paidThroughDate, paymentDueAt: paymentDueAt(paidThroughDate).toISOString(), periodStatus: "awaiting_payment", changeReason: "assigned", createdAt: nowIso(), createdBy: actor, ...(idempotencyKey ? { idempotencyKey: `assign:${idempotencyKey}` } : {}) }, { session });
    await subs.updateOne({ orgId: oid }, { $set: { ...lic, ...legacyFields(lic) }, $unset: existing?.licenseId ? { suspendedAt: "", suspendedReason: "", cancelledAt: "", cancelEffectiveAt: "", cancelReason: "", graceStartedAt: "", overrideUntil: "", paymentDueAt: "", graceEndsAt: "", paidThroughDate: "", nextPaymentDueDate: "", activatedAt: "", lastPaymentAt: "", lastPaymentMethod: "" } : {} }, { upsert: true, session });
    await event(ledger, session, { lic, orgId, type: "license_assigned", actor, previousState: existing?.licenseStatus || null, newState: "pending_activation", newValues: { planId, billingCycle, currency, amount: amt, startDate }, reason: note ? "assigned with note" : null, correlation: corr, subscriptionId: periodId });
    return lic;
  });
  activityLog(orgId, "LICENSE_ASSIGNED", { plan: snapshot.name, billingCycle });
  if (firstPayment.status === "confirmed") {
    const p = await recordPayment({ orgId, amount: amt, currency, method: firstPayment.method, reference: firstPayment.reference, receivedAt: firstPayment.receivedAt, note: "First payment, recorded with the license", actor });
    await confirmPayment({ orgId, paymentId: p.paymentId, actor });
  }
  return { license: await getLicense(orgId), licenseId: result.licenseId };
}

// ------------------------------------------------------------------------------------------- payments
function validatePaymentInput({ method, reference, receivedAt }) {
  if (!LICENSE_PAYMENT_METHODS[method]) fail(400, "Payment method must be NayaPay, bank transfer or other (manual).", "BAD_METHOD");
  const ref = clean(reference, 120);
  if (method !== "other_manual" && ref.length < 3) fail(400, "Enter the payment reference or transaction id.", "REFERENCE_REQUIRED");
  if (receivedAt && Number.isNaN(new Date(receivedAt).getTime())) fail(400, "Received date is not a valid date.", "BAD_DATE");
  if (receivedAt && new Date(receivedAt).getTime() > Date.now() + 60 * 60 * 1000) fail(400, "Received date cannot be in the future.", "BAD_DATE");
}

/** Records a payment as PENDING. A pending payment never changes access (SOW 10.2). */
export async function recordPayment({ orgId, amount, currency, method, reference, receivedAt = null, note = null, periods = 1, actor = adminActorName(), idempotencyKey = null }) {
  const { ledger } = await licenseCollections();
  const lic = await getLicense(orgId);
  if (!lic) fail(404, "This company has no license yet. Assign one first.", "NO_LICENSE");
  validatePaymentInput({ method, reference, receivedAt });
  const amt = money(amount);
  if (!(amt > 0)) fail(400, "Enter the amount received.", "BAD_AMOUNT");
  if (currency !== lic.currency) fail(400, `This license is billed in ${lic.currency}.`, "CURRENCY_MISMATCH");
  const n = Number(periods);
  if (!Number.isInteger(n) || n < 1 || n > 12) fail(400, "A payment can cover 1 to 12 periods.", "BAD_PERIODS");
  if (idempotencyKey) { const prior = await ledger.findOne({ idempotencyKey: `payment:${idempotencyKey}` }); if (prior) return { paymentId: String(prior._id), replayed: true }; }
  const doc = {
    kind: "license_payment", orgId: lic.orgId, licenseId: lic.licenseId, subscriptionId: lic.currentSubscriptionId, amount: amt, currency, method, reference: clean(reference, 120) || null,
    receivedAt: receivedAt ? new Date(receivedAt).toISOString() : null, periods: n, paymentStatus: "pending", note: note ? clean(note, 1000) : null,
    createdAt: nowIso(), createdBy: actor, ...(idempotencyKey ? { idempotencyKey: `payment:${idempotencyKey}` } : {}),
  };
  const r = await ledger.insertOne(doc);
  await event(ledger, null, { lic, orgId, type: "payment_recorded", actor, paymentId: r.insertedId, newValues: { amount: amt, currency, method, periods: n } });
  return { paymentId: String(r.insertedId) };
}

/**
 * What confirming a payment would do, without doing it (shown to the admin first, SOW 10.4).
 * Renewal policy (founder decision 3): always extend from the previous paid-through date -- no free days, no lost days.
 * For a first payment the period starts on the license's start date. `restartFrom` (suspended or lapsed companies
 * only) starts a fresh period on a chosen date instead; it needs an explicit admin decision.
 */
export function previewRenewal(lic, { periods = 1, restartFrom = null } = {}) {
  const n = Number(periods) || 1;
  let from;
  if (lic.licenseStatus === "pending_activation") from = lic.startDate;
  else if (restartFrom) from = restartFrom;
  else from = lic.paidThroughDate;
  const anchor = restartFrom ? parseBillingDate(restartFrom).d : lic.anchorDay;
  const pending = lic.pendingChange && lic.pendingChange.applyAt === "next_renewal" ? lic.pendingChange : null;
  const cycle = pending?.billingCycle || lic.billingCycle;
  const newPaidThrough = addCycles(from, cycle, n, anchor);
  return { periodStartDate: from, newPaidThroughDate: newPaidThrough, billingCycle: cycle, planId: pending?.planId || lic.planId, amountPerPeriod: pending?.amount ?? lic.amount, expectedAmount: money((pending?.amount ?? lic.amount) * n), anchorDay: anchor, ...deadlinesFor(newPaidThrough, 0) };
}

/** Confirms a pending payment: renews the license, ends grace/suspension, all in one transaction (SOW 10.3). */
export async function confirmPayment({ orgId, paymentId, actor = adminActorName(), adjustmentReason = null, restartFrom = null, now = new Date() }) {
  const { subs, ledger } = await licenseCollections();
  const corr = correlationId();
  const out = await withTxn(async (session) => {
    const lic = await subs.findOne({ orgId: toObjectId(orgId) }, { session });
    if (!lic?.licenseId) fail(404, "This company has no license.", "NO_LICENSE");
    const pay = await ledger.findOne({ _id: toObjectId(paymentId), kind: "license_payment", orgId: lic.orgId }, { session });
    if (!pay) fail(404, "Payment not found for this company.", "PAYMENT_NOT_FOUND");
    if (pay.paymentStatus === "confirmed") return { replayed: true, license: lic, payment: pay }; // idempotent
    if (pay.paymentStatus !== "pending") fail(409, `This payment is ${pay.paymentStatus}.`, "PAYMENT_NOT_PENDING");
    if (pay.reference) {
      const dup = await ledger.findOne({ kind: "license_payment", method: pay.method, reference: pay.reference, paymentStatus: "confirmed", _id: { $ne: pay._id } }, { session });
      if (dup) fail(409, `A confirmed payment with reference ${pay.reference} already exists.`, "DUPLICATE_REFERENCE");
    }
    if (restartFrom && !["suspended", "cancelled", "expired"].includes(effectiveState(lic, now).state)) fail(400, "A new start date can only be chosen for a suspended, cancelled or expired license.", "RESTART_NOT_ALLOWED");
    if (restartFrom) { try { parseBillingDate(restartFrom); } catch { fail(400, "The new start date is not a real date.", "BAD_DATE"); } }
    const plan = previewRenewal(lic, { periods: pay.periods || 1, restartFrom });
    if (Math.abs(pay.amount - plan.expectedAmount) > 0.005) {
      if (!adjustmentReason || clean(adjustmentReason).length < 3) fail(400, `Expected ${plan.expectedAmount} ${lic.currency} for ${pay.periods || 1} period(s); this payment is ${pay.amount}. Give a reason to accept a different amount.`, "AMOUNT_MISMATCH");
    }
    const prevState = lic.licenseStatus;
    const toState = "active";
    if (prevState !== "active") assertTransition(prevState === "cancelled" || prevState === "expired" ? prevState : prevState, toState);
    const periodId = new ObjectId();
    const version = (lic.licenseVersion || 1) + 1;
    const snapshot = plan.planId !== lic.planId ? planSnapshot(plan.planId) : lic.planSnapshot;
    const set = {
      licenseStatus: toState, planId: plan.planId, planSnapshot: snapshot, billingCycle: plan.billingCycle, amount: plan.amountPerPeriod, anchorDay: plan.anchorDay,
      ...deadlinesFor(plan.newPaidThroughDate, 0), graceExtensionDays: 0, currentSubscriptionId: periodId, licenseVersion: version,
      lastPaymentAt: pay.receivedAt || now.toISOString(), lastPaymentMethod: pay.method, lastRenewalPaymentId: pay._id, previousPaidThroughDate: lic.paidThroughDate || null,
      activatedAt: lic.activatedAt || now.toISOString(), updatedAt: now.toISOString(), updatedBy: actor,
    };
    const unset = { graceStartedAt: "", suspendedAt: "", suspendedReason: "", suspensionDueAt: "", pendingChange: "", cancelledAt: "", cancelEffectiveAt: "", cancelReason: "" };
    const next = { ...lic, ...set };
    // Optimistic concurrency: the license must be unchanged since it was read inside this transaction.
    const r = await subs.updateOne({ _id: lic._id, licenseVersion: lic.licenseVersion || 1 }, { $set: { ...set, ...legacyFields(next) }, $unset: unset }, { session });
    if (!r.modifiedCount) fail(409, "The license changed while confirming. Reload and try again.", "CONCURRENT_CHANGE");
    await ledger.updateOne({ _id: pay._id, paymentStatus: "pending" }, { $set: { paymentStatus: "confirmed", confirmedAt: now.toISOString(), confirmedBy: actor, adjustmentReason: adjustmentReason ? clean(adjustmentReason) : null, renewal: { fromPaidThroughDate: lic.paidThroughDate || null, toPaidThroughDate: plan.newPaidThroughDate, periodStartDate: plan.periodStartDate, subscriptionId: periodId } } }, { session });
    await ledger.updateMany({ kind: "license_period", licenseId: lic.licenseId, periodStatus: "awaiting_payment" }, { $set: { periodStatus: "superseded" } }, { session });
    await ledger.insertOne({ _id: periodId, kind: "license_period", orgId: lic.orgId, licenseId: lic.licenseId, version, planSnapshot: snapshot, billingCycle: plan.billingCycle, currency: lic.currency, amount: plan.amountPerPeriod, periodStartDate: plan.periodStartDate, periodEndDate: plan.newPaidThroughDate, paymentDueAt: set.paymentDueAt, periodStatus: "paid", paymentId: pay._id, changeReason: restartFrom ? "restarted" : prevState === "pending_activation" ? "first_payment" : "renewal", createdAt: now.toISOString(), createdBy: actor }, { session });
    await event(ledger, session, { lic, orgId, type: "payment_confirmed", actor, paymentId: pay._id, subscriptionId: periodId, previousState: prevState, newState: toState, previousValues: { paidThroughDate: lic.paidThroughDate || null }, newValues: { paidThroughDate: plan.newPaidThroughDate, amount: pay.amount, currency: pay.currency, method: pay.method }, reason: adjustmentReason ? clean(adjustmentReason) : null, correlation: corr });
    if (prevState !== toState) await event(ledger, session, { lic, orgId, type: prevState === "pending_activation" ? "license_activated" : prevState === "suspended" ? "license_reactivated" : "license_renewed", actor, previousState: prevState, newState: toState, subscriptionId: periodId, correlation: corr });
    else await event(ledger, session, { lic, orgId, type: "license_renewed", actor, previousState: prevState, newState: toState, subscriptionId: periodId, correlation: corr });
    return { license: next, payment: pay, prevState };
  });
  if (out.replayed) return { replayed: true, license: out.license };
  // Outside the transaction: the plan in force for the existing entitlement checks, and the company's activity feed.
  const { orgs } = await getOrgCollections();
  await orgs.updateOne({ _id: out.license.orgId }, { $set: { plan: out.license.planId, planUpdatedAt: nowIso(), billingRegion: out.license.currency === "PKR" ? "PK" : "INTL", requiresPlanSelection: false } });
  activityLog(orgId, "LICENSE_PAYMENT_CONFIRMED", { paidThroughDate: out.license.paidThroughDate });
  const { notifyLicenseEvent } = await import("./notices.js");
  notifyLicenseEvent({ orgId, type: out.prevState === "suspended" ? "reactivated" : "payment_confirmed", license: out.license }).catch((e) => console.error("license notice failed:", e.message));
  return { license: out.license, paidThroughDate: out.license.paidThroughDate };
}

export async function rejectPayment({ orgId, paymentId, reason, actor = adminActorName() }) {
  const why = requireReason(reason, "reject a payment");
  const { ledger } = await licenseCollections();
  const lic = await getLicense(orgId);
  if (!lic) fail(404, "This company has no license.", "NO_LICENSE");
  const r = await ledger.updateOne({ _id: toObjectId(paymentId), kind: "license_payment", orgId: lic.orgId, paymentStatus: "pending" }, { $set: { paymentStatus: "rejected", rejectedAt: nowIso(), rejectedBy: actor, rejectReason: why } });
  if (!r.modifiedCount) fail(409, "Only a pending payment of this company can be rejected.", "PAYMENT_NOT_PENDING");
  await event(ledger, null, { lic, orgId, type: "payment_rejected", actor, paymentId: toObjectId(paymentId), reason: why });
  return { rejected: true };
}

/**
 * Reverses a confirmed payment (SOW 10.5): the payment is never edited or deleted; it is marked reversed with a
 * reference to a new reversal record. If it was the latest renewal, the paid-through date returns to where it was
 * and the state follows from the dates (an auditable transition; the admin is told). Otherwise it is flagged for review.
 */
export async function reversePayment({ orgId, paymentId, reason, actor = adminActorName() }) {
  const why = requireReason(reason, "reverse a payment");
  const { subs, ledger } = await licenseCollections();
  return withTxn(async (session) => {
    const lic = await subs.findOne({ orgId: toObjectId(orgId) }, { session });
    if (!lic?.licenseId) fail(404, "This company has no license.", "NO_LICENSE");
    const pay = await ledger.findOne({ _id: toObjectId(paymentId), kind: "license_payment", orgId: lic.orgId }, { session });
    if (!pay || pay.paymentStatus !== "confirmed") fail(409, "Only a confirmed payment can be reversed.", "PAYMENT_NOT_CONFIRMED");
    const reversal = { _id: new ObjectId(), kind: "license_payment", orgId: lic.orgId, licenseId: lic.licenseId, amount: -pay.amount, currency: pay.currency, method: pay.method, reference: pay.reference, paymentStatus: "reversal", reversalOf: pay._id, reason: why, createdAt: nowIso(), createdBy: actor };
    await ledger.insertOne(reversal, { session });
    await ledger.updateOne({ _id: pay._id }, { $set: { paymentStatus: "reversed", reversedAt: nowIso(), reversedBy: actor, reversalId: reversal._id } }, { session });
    const isLatest = String(lic.lastRenewalPaymentId || "") === String(pay._id) && pay.renewal?.fromPaidThroughDate !== undefined;
    let impact = "flagged_for_review";
    if (isLatest) {
      const back = pay.renewal.fromPaidThroughDate;
      const set = back ? { ...deadlinesFor(back, lic.graceExtensionDays || 0) } : {};
      const next = { ...lic, ...set, licenseStatus: back ? lic.licenseStatus : "pending_activation" };
      await subs.updateOne({ _id: lic._id }, { $set: { ...set, licenseStatus: next.licenseStatus, licenseVersion: (lic.licenseVersion || 1) + 1, updatedAt: nowIso(), updatedBy: actor, needsReview: null, ...legacyFields(next) }, $unset: { lastRenewalPaymentId: "" } }, { session });
      impact = back ? `paid_through_reverted_to_${back}` : "returned_to_pending_activation";
    } else {
      await subs.updateOne({ _id: lic._id }, { $set: { needsReview: { reason: "payment reversed that was not the latest renewal", paymentId: pay._id, at: nowIso() } } }, { session });
    }
    await event(ledger, session, { lic, orgId, type: "payment_reversed", actor, paymentId: pay._id, reason: why, metadata: { reversalId: reversal._id, impact } });
    return { reversed: true, reversalId: String(reversal._id), impact };
  });
}

// ------------------------------------------------------------------------------------------- plan / cycle / amount
/**
 * Changes the package, billing cycle and/or amount (SOW 11). `applyAt`: "now" (entitlements change today; the next
 * renewal uses the new cycle/amount) or "next_renewal" (applied when the next payment is confirmed). No proration is
 * invented: the agreed amount is entered by the admin. History is kept as a new subscription version.
 */
export async function changeSubscription({ orgId, planId = null, billingCycle = null, amount = null, applyAt = "now", reason, actor = adminActorName() }) {
  const why = requireReason(reason, "change the subscription");
  const { subs, ledger } = await licenseCollections();
  const lic = await getLicense(orgId);
  if (!lic) fail(404, "This company has no license.", "NO_LICENSE");
  if (["cancelled", "expired"].includes(lic.licenseStatus)) fail(409, "Assign a new license to a cancelled company instead.", "LICENSE_ENDED");
  const nextPlan = planId || lic.planId; const snapshot = planSnapshot(nextPlan);
  const cycle = billingCycle || lic.billingCycle;
  if (!BILLING_CYCLES.includes(cycle)) fail(400, "Billing cycle must be monthly or yearly.", "BAD_CYCLE");
  const amt = amount === null || amount === undefined || amount === "" ? lic.amount : money(amount);
  if (!(amt > 0)) fail(400, "Enter the agreed amount.", "BAD_AMOUNT");
  if (cycle !== lic.billingCycle && (amount === null || amount === undefined || amount === "")) fail(400, "A billing-cycle change needs the agreed amount for the new cycle.", "AMOUNT_REQUIRED");
  if (!["now", "next_renewal"].includes(applyAt)) fail(400, "applyAt must be now or next_renewal.", "BAD_APPLY_AT");
  const prev = { planId: lic.planId, billingCycle: lic.billingCycle, amount: lic.amount };
  const nextValues = { planId: nextPlan, billingCycle: cycle, amount: amt };
  if (prev.planId === nextValues.planId && prev.billingCycle === nextValues.billingCycle && prev.amount === nextValues.amount) fail(400, "Nothing to change.", "NO_CHANGE");
  await withTxn(async (session) => {
    if (applyAt === "now") {
      const periodId = new ObjectId();
      const next = { ...lic, planId: nextPlan, planSnapshot: snapshot, billingCycle: cycle, amount: amt };
      await subs.updateOne({ _id: lic._id }, { $set: { planId: nextPlan, planSnapshot: snapshot, billingCycle: cycle, amount: amt, currentSubscriptionId: periodId, licenseVersion: (lic.licenseVersion || 1) + 1, updatedAt: nowIso(), updatedBy: actor, ...legacyFields(next) }, $unset: { pendingChange: "" } }, { session });
      await ledger.insertOne({ _id: periodId, kind: "license_period", orgId: lic.orgId, licenseId: lic.licenseId, version: (lic.licenseVersion || 1) + 1, planSnapshot: snapshot, billingCycle: cycle, currency: lic.currency, amount: amt, periodStartDate: billingDateOf(new Date()), periodEndDate: lic.paidThroughDate || null, paymentDueAt: lic.paymentDueAt || null, periodStatus: "plan_change", changeReason: why, createdAt: nowIso(), createdBy: actor }, { session });
    } else {
      await subs.updateOne({ _id: lic._id }, { $set: { pendingChange: { ...nextValues, applyAt: "next_renewal", requestedAt: nowIso(), by: actor, reason: why }, updatedAt: nowIso(), updatedBy: actor } }, { session });
    }
    await event(ledger, session, { lic, orgId, type: prev.planId !== nextPlan ? "plan_changed" : prev.billingCycle !== cycle ? "billing_cycle_changed" : "amount_changed", actor, previousValues: prev, newValues: { ...nextValues, applyAt }, reason: why });
  });
  if (applyAt === "now" && nextPlan !== lic.planId) {
    const { orgs } = await getOrgCollections();
    await orgs.updateOne({ _id: lic.orgId }, { $set: { plan: nextPlan, planUpdatedAt: nowIso() } });
    activityLog(orgId, "LICENSE_PLAN_CHANGED", { plan: snapshot.name });
    const { notifyLicenseEvent } = await import("./notices.js");
    notifyLicenseEvent({ orgId, type: "plan_changed", license: await getLicense(orgId) }).catch(() => {});
  }
  return { license: await getLicense(orgId) };
}

// ------------------------------------------------------------------------------------------- grace, suspension, override
/** Grants more grace (decision 9: reason required, at most MAX_GRACE_EXTENSION_DAYS each time). Lifts a suspension if the new deadline is in the future. */
export async function extendGrace({ orgId, days, reason, actor = adminActorName(), now = new Date() }) {
  const why = requireReason(reason, "extend the grace period");
  const d = Number(days);
  if (!Number.isInteger(d) || d < 1 || d > MAX_GRACE_EXTENSION_DAYS) fail(400, `Extend by 1 to ${MAX_GRACE_EXTENSION_DAYS} days.`, "BAD_DAYS");
  const { subs, ledger } = await licenseCollections();
  const lic = await getLicense(orgId);
  if (!lic) fail(404, "This company has no license.", "NO_LICENSE");
  const eff = effectiveState(lic, now, { autoSuspend: true });
  if (!["grace_period", "suspended"].includes(eff.state) && !(lic.paymentDueAt && now >= new Date(lic.paymentDueAt))) fail(409, "Grace can be extended only for an overdue or suspended license.", "NOT_OVERDUE");
  if (lic.licenseStatus === "suspended" && lic.suspendedReason === "manual") fail(409, "This company was suspended manually; reactivate it instead.", "MANUAL_SUSPENSION");
  const extra = (lic.graceExtensionDays || 0) + d;
  const newEnd = graceEndsAt(lic.paidThroughDate, extra).toISOString();
  const lifts = new Date(newEnd) > now;
  const toState = lic.licenseStatus === "suspended" && lifts ? "grace_period" : lic.licenseStatus;
  if (toState !== lic.licenseStatus) assertTransition(lic.licenseStatus, toState);
  const next = { ...lic, graceExtensionDays: extra, graceEndsAt: newEnd, licenseStatus: toState };
  const r = await subs.updateOne({ _id: lic._id, licenseVersion: lic.licenseVersion || 1 }, { $set: { graceExtensionDays: extra, graceEndsAt: newEnd, licenseStatus: toState, licenseVersion: (lic.licenseVersion || 1) + 1, updatedAt: nowIso(), updatedBy: actor, ...legacyFields(next) }, ...(toState !== lic.licenseStatus ? { $unset: { suspendedAt: "", suspendedReason: "" } } : {}) });
  if (!r.modifiedCount) fail(409, "The license changed meanwhile. Reload and try again.", "CONCURRENT_CHANGE");
  await event(ledger, null, { lic, orgId, type: "grace_extended", actor, previousState: lic.licenseStatus, newState: toState, previousValues: { graceEndsAt: lic.graceEndsAt }, newValues: { graceEndsAt: newEnd, extraDays: d }, reason: why });
  activityLog(orgId, "LICENSE_GRACE_EXTENDED", { graceEndsAt: newEnd });
  return { license: next };
}

/** Manual suspension by an admin (reason required). */
export async function suspendLicense({ orgId, reason, actor = adminActorName(), source = "admin_portal", now = new Date() }) {
  const why = requireReason(reason, "suspend a license");
  const { subs, ledger } = await licenseCollections();
  const lic = await getLicense(orgId);
  if (!lic) fail(404, "This company has no license.", "NO_LICENSE");
  if (lic.licenseStatus === "suspended") fail(409, "This license is already suspended.", "ALREADY_SUSPENDED");
  assertTransition(lic.licenseStatus, "suspended");
  const next = { ...lic, licenseStatus: "suspended" };
  const r = await subs.updateOne({ _id: lic._id, licenseVersion: lic.licenseVersion || 1 }, { $set: { licenseStatus: "suspended", suspendedAt: now.toISOString(), suspendedReason: "manual", manualSuspensionReason: why, licenseVersion: (lic.licenseVersion || 1) + 1, updatedAt: nowIso(), updatedBy: actor, ...legacyFields(next) }, $unset: { overrideUntil: "" } });
  if (!r.modifiedCount) fail(409, "The license changed meanwhile. Reload and try again.", "CONCURRENT_CHANGE");
  await event(ledger, null, { lic, orgId, type: "license_suspended", actor, source, previousState: lic.licenseStatus, newState: "suspended", reason: why });
  const { invalidateLicenseCache } = await import("./gate.js"); invalidateLicenseCache(orgId);
  const { notifyLicenseEvent } = await import("./notices.js");
  notifyLicenseEvent({ orgId, type: "suspended", license: { ...next, suspendedAt: now.toISOString() } }).catch(() => {});
  return { license: next };
}

/**
 * Reactivates without a payment (an admin override, SOW 5 "admin_override"): access returns until `until`
 * (a date, at most MAX_GRACE_EXTENSION_DAYS ahead), with a reason. Normal reactivation is by confirming a payment.
 */
export async function reactivateLicense({ orgId, reason, untilDate, actor = adminActorName(), now = new Date() }) {
  const why = requireReason(reason, "reactivate a license without a payment");
  const { subs, ledger } = await licenseCollections();
  const lic = await getLicense(orgId);
  if (!lic) fail(404, "This company has no license.", "NO_LICENSE");
  try { parseBillingDate(untilDate); } catch { fail(400, "Choose the date access runs until (YYYY-MM-DD).", "BAD_DATE"); }
  const until = paymentDueAt(untilDate);
  if (until <= now) fail(400, "The date must be in the future.", "BAD_DATE");
  if (until.getTime() - now.getTime() > (MAX_GRACE_EXTENSION_DAYS + 1) * 86400000) fail(400, `An override can last at most ${MAX_GRACE_EXTENSION_DAYS} days; confirm a payment for longer.`, "OVERRIDE_TOO_LONG");
  if (!["suspended", "grace_period", "active"].includes(lic.licenseStatus)) fail(409, `A ${lic.licenseStatus} license is renewed by assigning or confirming a payment.`, "NOT_OVERRIDABLE");
  const toState = lic.licenseStatus === "suspended" ? "grace_period" : lic.licenseStatus;
  const next = { ...lic, licenseStatus: toState, overrideUntil: until.toISOString() };
  const r = await subs.updateOne({ _id: lic._id, licenseVersion: lic.licenseVersion || 1 }, { $set: { licenseStatus: toState, overrideUntil: until.toISOString(), overrideReason: why, licenseVersion: (lic.licenseVersion || 1) + 1, updatedAt: nowIso(), updatedBy: actor, ...legacyFields(next) }, $unset: { suspendedAt: "", suspendedReason: "", manualSuspensionReason: "" } });
  if (!r.modifiedCount) fail(409, "The license changed meanwhile. Reload and try again.", "CONCURRENT_CHANGE");
  await event(ledger, null, { lic, orgId, type: "admin_override_applied", actor, previousState: lic.licenseStatus, newState: "admin_override", newValues: { overrideUntil: until.toISOString() }, reason: why });
  const { invalidateLicenseCache } = await import("./gate.js"); invalidateLicenseCache(orgId);
  const { notifyLicenseEvent } = await import("./notices.js");
  notifyLicenseEvent({ orgId, type: "reactivated", license: next }).catch(() => {});
  return { license: next };
}

/** Cancels (decision 6): access continues to the paid-through date unless `immediate` (reason required either way). Data is never deleted. */
export async function cancelLicense({ orgId, reason, immediate = false, actor = adminActorName(), now = new Date() }) {
  const why = requireReason(reason, "cancel a license");
  const { subs, ledger } = await licenseCollections();
  const lic = await getLicense(orgId);
  if (!lic) fail(404, "This company has no license.", "NO_LICENSE");
  assertTransition(lic.licenseStatus, "cancelled");
  const effectiveAt = immediate || !lic.paymentDueAt || new Date(lic.paymentDueAt) <= now ? now.toISOString() : lic.paymentDueAt;
  const next = { ...lic, licenseStatus: "cancelled", cancelEffectiveAt: effectiveAt };
  const r = await subs.updateOne({ _id: lic._id, licenseVersion: lic.licenseVersion || 1 }, { $set: { licenseStatus: "cancelled", cancelledAt: now.toISOString(), cancelEffectiveAt: effectiveAt, cancelReason: why, licenseVersion: (lic.licenseVersion || 1) + 1, updatedAt: nowIso(), updatedBy: actor, ...legacyFields(next) }, $unset: { overrideUntil: "", pendingChange: "" } });
  if (!r.modifiedCount) fail(409, "The license changed meanwhile. Reload and try again.", "CONCURRENT_CHANGE");
  await event(ledger, null, { lic, orgId, type: "license_cancelled", actor, previousState: lic.licenseStatus, newState: "cancelled", newValues: { cancelEffectiveAt: effectiveAt, immediate: !!immediate }, reason: why });
  const { invalidateLicenseCache } = await import("./gate.js"); invalidateLicenseCache(orgId);
  activityLog(orgId, "LICENSE_CANCELLED", { effectiveAt });
  return { license: next };
}

export async function addNote({ orgId, text, actor = adminActorName() }) {
  const note = clean(text, 2000);
  if (note.length < 2) fail(400, "Write the note.", "EMPTY_NOTE");
  const { subs, ledger } = await licenseCollections();
  const lic = await getLicense(orgId);
  if (!lic) fail(404, "This company has no license.", "NO_LICENSE");
  await subs.updateOne({ _id: lic._id }, { $push: { notes: { $each: [{ at: nowIso(), by: actor, text: note }], $slice: -200 } } });
  await event(ledger, null, { lic, orgId, type: "note_added", actor });
  return { added: true };
}

// ------------------------------------------------------------------------------------------- system transitions (the job)
/** Persists the transition the dates already imply. Idempotent: guarded by status + version, so a repeat run does nothing. */
export async function systemTransition({ lic, to, now = new Date(), reason }) {
  const { subs, ledger } = await licenseCollections();
  assertTransition(lic.licenseStatus, to);
  const set = { licenseStatus: to, licenseVersion: (lic.licenseVersion || 1) + 1, updatedAt: now.toISOString(), updatedBy: "system" };
  if (to === "grace_period") set.graceStartedAt = lic.paymentDueAt;
  if (to === "suspended") { set.suspendedAt = now.toISOString(); set.suspendedReason = "grace_ended"; }
  const next = { ...lic, ...set };
  const r = await subs.updateOne({ _id: lic._id, licenseStatus: lic.licenseStatus, licenseVersion: lic.licenseVersion || 1 }, { $set: { ...set, ...legacyFields(next) } });
  if (!r.modifiedCount) return null; // someone else moved it (a payment, an extension, another job run)
  await event(ledger, null, { lic, orgId: lic.orgId, type: to === "grace_period" ? "grace_started" : "license_suspended", actor: "license-job", actorType: "system", source: "cron", previousState: lic.licenseStatus, newState: to, reason });
  if (to === "suspended") { const { invalidateLicenseCache } = await import("./gate.js"); invalidateLicenseCache(lic.orgId); }
  return next;
}

// ------------------------------------------------------------------------------------------- history
export async function licenseHistory(orgId, { limit = 500 } = {}) {
  const { ledger } = await licenseCollections();
  const oid = toObjectId(orgId);
  const [periods, payments, events] = await Promise.all([
    ledger.find({ kind: "license_period", orgId: oid }).sort({ createdAt: -1 }).limit(limit).toArray(),
    ledger.find({ kind: "license_payment", orgId: oid }).sort({ createdAt: -1 }).limit(limit).toArray(),
    ledger.find({ kind: "license_event", orgId: oid }).sort({ at: -1 }).limit(limit).toArray(),
  ]);
  return { periods, payments, events };
}

/** Payments as the company's Owner/Admin sees them: amounts, dates, method, status. No admin names or internal notes. */
export async function companyPaymentHistory(orgId) {
  const { ledger } = await licenseCollections();
  const rows = await ledger.find({ kind: "license_payment", orgId: toObjectId(orgId), paymentStatus: { $in: ["confirmed", "reversed", "reversal"] } }).sort({ createdAt: -1 }).limit(200).toArray();
  return rows.map((p) => ({ id: String(p._id), amount: p.amount, currency: p.currency, method: LICENSE_PAYMENT_METHODS[p.method] || p.method, reference: p.reference ? `…${String(p.reference).slice(-4)}` : null, receivedAt: p.receivedAt || null, confirmedAt: p.confirmedAt || null, status: p.paymentStatus === "reversal" ? "reversal" : p.paymentStatus, periodTo: p.renewal?.toPaidThroughDate || null }));
}

// ------------------------------------------------------------------------------------------- launch migration (SOW 20)
/**
 * Companies with a subscription record from before licenses existed (activated on /admin/billing before 17 Nov 2026):
 * active, paid until `currentPeriodEnd`, but no licenseId. Read-only report for the migration screen.
 */
export async function legacySubscriptions() {
  const { subs } = await licenseCollections();
  const { orgs } = await getOrgCollections();
  const rows = await subs.find({ licenseId: { $exists: false } }).limit(5000).toArray();
  const names = new Map((await orgs.find({ _id: { $in: rows.map((r) => r.orgId) } }, { projection: { name: 1 } }).toArray()).map((o) => [String(o._id), o.name]));
  return rows.map((r) => ({ orgId: String(r.orgId), companyName: names.get(String(r.orgId)) || "(company removed)", plan: r.plan || null, status: r.status || null, billingInterval: r.billingInterval || null, currency: r.currency || null, currentPeriodEnd: r.currentPeriodEnd || null, provider: r.provider || null }));
}

/**
 * Adopts one legacy subscription as a license, keeping what was already paid: active until its existing period end
 * (no new payment is recorded and none is inferred). The agreed amount comes from the admin (or the company's last
 * activation request). Idempotent: a company that already has a license is left alone.
 */
export async function adoptLegacySubscription({ orgId, amount = null, actor = adminActorName(), now = new Date() }) {
  const { subs, ledger } = await licenseCollections();
  const oid = toObjectId(orgId);
  const legacy = await subs.findOne({ orgId: oid });
  if (!legacy) fail(404, "This company has no subscription record to adopt.", "NO_LEGACY");
  if (legacy.licenseId) return { adopted: false, reason: "already a license", license: legacy };
  if (!legacy.plan || !PLANS[legacy.plan]) fail(400, "The old record has no known package; assign a license instead.", "NO_PLAN");
  const cycle = legacy.billingInterval === "year" ? "yearly" : "monthly";
  const currency = legacy.currency === "USD" ? "USD" : "PKR";
  let amt = amount !== null && amount !== undefined && amount !== "" ? money(amount) : null;
  if (amt === null) {
    const req = await ledger.findOne({ orgId: oid, kind: { $exists: false }, status: "active" }, { sort: { activatedAt: -1 } });
    amt = currency === "PKR" ? Number(req?.amountPkr) : Number(req?.amountUsd);
  }
  if (!(amt > 0)) fail(400, "Enter the agreed amount per period for this company.", "AMOUNT_REQUIRED");
  const paidThroughDate = legacy.currentPeriodEnd ? billingDateOf(legacy.currentPeriodEnd) : billingDateOf(now);
  const periodId = new ObjectId();
  const snapshot = planSnapshot(legacy.plan);
  const lic = {
    orgId: oid, licenseId: newLicenseId(), licenseStatus: "active", planId: legacy.plan, planSnapshot: snapshot, billingCycle: cycle, currency, amount: amt,
    anchorDay: parseBillingDate(paidThroughDate).d, startDate: billingDateOf(legacy.updatedAt || now), ...deadlinesFor(paidThroughDate, 0), graceExtensionDays: 0,
    currentSubscriptionId: periodId, licenseVersion: 1, activatedAt: legacy.updatedAt || now.toISOString(), lastPaymentMethod: legacy.provider || "bank_transfer",
    createdAt: now.toISOString(), createdBy: actor, updatedAt: now.toISOString(), updatedBy: actor, notes: [], previousLicense: { legacy: { plan: legacy.plan, status: legacy.status, currentPeriodEnd: legacy.currentPeriodEnd } },
  };
  await withTxn(async (session) => {
    const r = await subs.updateOne({ _id: legacy._id, licenseId: { $exists: false } }, { $set: { ...lic, ...legacyFields(lic) } }, { session });
    if (!r.modifiedCount) fail(409, "This record changed meanwhile. Reload and try again.", "CONCURRENT_CHANGE");
    await ledger.insertOne({ _id: periodId, kind: "license_period", orgId: oid, licenseId: lic.licenseId, version: 1, planSnapshot: snapshot, billingCycle: cycle, currency, amount: amt, periodStartDate: lic.startDate, periodEndDate: paidThroughDate, paymentDueAt: lic.paymentDueAt, periodStatus: "paid", changeReason: "adopted from the subscription record that existed before licenses", createdAt: now.toISOString(), createdBy: actor }, { session });
    await event(ledger, session, { lic, orgId, type: "license_assigned", actor, previousState: legacy.status || null, newState: "active", newValues: { planId: legacy.plan, billingCycle: cycle, currency, amount: amt, paidThroughDate }, reason: "migrated: existing paid subscription adopted as a license (no payment inferred)" });
  });
  activityLog(orgId, "LICENSE_ASSIGNED", { plan: snapshot.name, migrated: true });
  return { adopted: true, license: await getLicense(orgId) };
}

/**
 * Bulk assignment for launch (SOW 20.2): validates every row first (preview), then assigns each valid one individually.
 * Never confirms a payment: every license starts awaiting its first payment. Idempotent per company and start date.
 * rows = [{ orgId, planId, billingCycle, currency, amount, startDate }]
 */
export async function bulkAssign({ rows, preview = true, actor = adminActorName() }) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 200) fail(400, "Send 1 to 200 rows.", "BAD_ROWS");
  const { subs } = await licenseCollections();
  const { orgs } = await getOrgCollections();
  const seen = new Set(); const results = [];
  for (const [i, r] of rows.entries()) {
    const out = { row: i + 1, orgId: r.orgId || null };
    try {
      if (!r.orgId || !/^[0-9a-f]{24}$/i.test(String(r.orgId))) fail(400, "orgId is missing or not a company id.", "BAD_ORG");
      if (seen.has(String(r.orgId))) fail(409, "This company appears twice in the list.", "DUPLICATE_ROW");
      seen.add(String(r.orgId));
      const org = await orgs.findOne({ _id: toObjectId(r.orgId) }, { projection: { name: 1 } });
      if (!org) fail(404, "No company with that id.", "ORG_NOT_FOUND");
      out.companyName = org.name;
      planSnapshot(r.planId);
      if (!BILLING_CYCLES.includes(r.billingCycle)) fail(400, "Billing cycle must be monthly or yearly.", "BAD_CYCLE");
      if (!CURRENCIES.includes(r.currency)) fail(400, "Currency must be USD or PKR.", "BAD_CURRENCY");
      if (!(money(r.amount) > 0)) fail(400, "Amount must be more than 0.", "BAD_AMOUNT");
      parseBillingDate(r.startDate);
      const existing = await subs.findOne({ orgId: toObjectId(r.orgId) }, { projection: { licenseId: 1, licenseStatus: 1 } });
      if (existing?.licenseId && !["cancelled", "expired"].includes(existing.licenseStatus)) { out.status = "skipped"; out.reason = `already has a license (${existing.licenseStatus})`; results.push(out); continue; }
      if (preview) { out.status = "valid"; results.push(out); continue; }
      const a = await assignLicense({ orgId: r.orgId, planId: r.planId, billingCycle: r.billingCycle, currency: r.currency, amount: r.amount, startDate: r.startDate, firstPayment: { status: "awaiting" }, note: "bulk assignment", actor, idempotencyKey: `bulk:${r.orgId}:${r.startDate}` });
      out.status = "assigned"; out.licenseId = a.license?.licenseId || a.licenseId;
    } catch (e) { out.status = "error"; out.reason = e.message; }
    results.push(out);
  }
  return { preview, results, counts: results.reduce((m, x) => ((m[x.status] = (m[x.status] || 0) + 1), m), {}) };
}
