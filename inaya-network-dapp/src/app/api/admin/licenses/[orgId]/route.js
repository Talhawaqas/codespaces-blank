// app/api/admin/licenses/[orgId]/route.js -- one company's license (SOW 6.3 - 6.5). Admin session only.
//   GET  -> license, effective state, history (subscription versions, payments, audit events, notices, exports)
//   POST { action, ... } -> one license action; high-impact actions need confirm: true (SOW 17.4):
//     assign            { planId, billingCycle, currency, amount, startDate, firstPayment: { status: "awaiting" | "confirmed", method?, reference?, receivedAt? }, note?, idempotencyKey? }
//     preview_renewal   { periods?, restartFrom? }                         (no change; shows the effective dates)
//     record_payment    { amount, currency, method, reference, receivedAt?, periods?, note?, idempotencyKey? }
//     confirm_payment   { paymentId, adjustmentReason?, restartFrom? }
//     reject_payment    { paymentId, reason }
//     reverse_payment   { paymentId, reason }
//     change            { planId?, billingCycle?, amount?, applyAt: "now" | "next_renewal", reason }
//     extend_grace      { days, reason }
//     suspend           { reason }
//     reactivate        { reason, untilDate }        (override without payment)
//     cancel            { reason, immediate? }
//     note              { text }
import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../../lib/admin-auth";
import { checkRateLimit } from "../../../../../lib/rateLimit.js";
import { getOrgCollections, toObjectId } from "../../../../../lib/orgs.js";
import * as L from "../../../../../lib/licensing/service.js";
import { effectiveState, STATE_LABELS } from "../../../../../lib/licensing/state.js";
import { formatDeadline } from "../../../../../lib/licensing/dates.js";
import { rowView } from "../../../../../lib/licensing/admin.js";

export const dynamic = "force-dynamic";
const HIGH_IMPACT = new Set(["assign", "confirm_payment", "reverse_payment", "change", "extend_grace", "suspend", "reactivate", "cancel"]);

export async function GET(req, { params }) {
  if (!isAdminAuthenticated(req)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const { orgId } = await params;
    let oid; try { oid = toObjectId(orgId); } catch { return NextResponse.json({ error: "Invalid company id." }, { status: 400 }); }
    const { orgs, orgMembers } = await getOrgCollections();
    const org = await orgs.findOne({ _id: oid }, { projection: { name: 1, plan: 1, createdAt: 1, ownerEmail: 1 } });
    if (!org) return NextResponse.json({ error: "No company with that id." }, { status: 404 });
    const lic = await L.getLicense(orgId);
    const { ledger } = await L.licenseCollections();
    const [history, notices, exports, admins] = await Promise.all([
      L.licenseHistory(orgId),
      ledger.find({ kind: "license_notice", orgId: oid }).sort({ createdAt: -1 }).limit(100).toArray(),
      ledger.find({ kind: "company_export", orgId: oid }).sort({ requestedAt: -1 }).limit(20).project({ artifact: 0 }).toArray(),
      orgMembers.find({ orgId: oid, status: "active", role: { $in: ["owner", "admin"] } }, { projection: { email: 1, role: 1 } }).toArray(),
    ]);
    const eff = lic ? effectiveState(lic) : null;
    return NextResponse.json({
      company: { orgId, name: org.name, plan: org.plan || null, createdAt: org.createdAt || null, billingContacts: admins.map((a) => ({ email: a.email, role: a.role })) },
      license: lic ? { ...rowView({ ...lic, companyName: org.name, effective: eff }), notes: lic.notes || [], planSnapshot: lic.planSnapshot, anchorDay: lic.anchorDay, graceExtensionDays: lic.graceExtensionDays || 0, cancelEffectiveAt: lic.cancelEffectiveAt || null, deadlineText: eff?.deadline ? formatDeadline(eff.deadline) : null, stateLabel: STATE_LABELS[eff.state] } : null,
      renewalPreview: lic && !["cancelled", "expired"].includes(lic.licenseStatus) ? L.previewRenewal(lic) : null,
      history, notices, exports,
    });
  } catch (err) {
    console.error("admin/licenses/[orgId] GET failed:", err?.message);
    return NextResponse.json({ error: "Could not load the license." }, { status: 500 });
  }
}

export async function POST(req, { params }) {
  if (!isAdminAuthenticated(req)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { orgId } = await params;
  let b = {}; try { b = await req.json(); } catch { b = {}; }
  try { await checkRateLimit({ action: "admin-license", key: "admin", max: 120, windowMs: 60000 }); } catch { return NextResponse.json({ error: "Too many changes in a minute. Slow down." }, { status: 429 }); }
  if (HIGH_IMPACT.has(b.action) && b.confirm !== true) return NextResponse.json({ error: "Confirm this change first.", code: "CONFIRM_REQUIRED" }, { status: 400 });
  try {
    let result;
    switch (b.action) {
      case "assign": result = await L.assignLicense({ orgId, planId: b.planId, billingCycle: b.billingCycle, currency: b.currency, amount: b.amount, startDate: b.startDate, firstPayment: b.firstPayment, note: b.note, idempotencyKey: b.idempotencyKey || null }); break;
      case "preview_renewal": { const lic = await L.getLicense(orgId); if (!lic) return NextResponse.json({ error: "No license." }, { status: 404 }); result = { preview: L.previewRenewal(lic, { periods: b.periods, restartFrom: b.restartFrom || null }) }; break; }
      case "record_payment": result = await L.recordPayment({ orgId, amount: b.amount, currency: b.currency, method: b.method, reference: b.reference, receivedAt: b.receivedAt || null, periods: b.periods || 1, note: b.note, idempotencyKey: b.idempotencyKey || null }); break;
      case "confirm_payment": result = await L.confirmPayment({ orgId, paymentId: b.paymentId, adjustmentReason: b.adjustmentReason || null, restartFrom: b.restartFrom || null }); break;
      case "reject_payment": result = await L.rejectPayment({ orgId, paymentId: b.paymentId, reason: b.reason }); break;
      case "reverse_payment": result = await L.reversePayment({ orgId, paymentId: b.paymentId, reason: b.reason }); break;
      case "change": result = await L.changeSubscription({ orgId, planId: b.planId || null, billingCycle: b.billingCycle || null, amount: b.amount ?? null, applyAt: b.applyAt || "now", reason: b.reason }); break;
      case "extend_grace": result = await L.extendGrace({ orgId, days: b.days, reason: b.reason }); break;
      case "suspend": result = await L.suspendLicense({ orgId, reason: b.reason }); break;
      case "reactivate": result = await L.reactivateLicense({ orgId, reason: b.reason, untilDate: b.untilDate }); break;
      case "cancel": result = await L.cancelLicense({ orgId, reason: b.reason, immediate: !!b.immediate }); break;
      case "note": result = await L.addNote({ orgId, text: b.text }); break;
      default: return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
    const { invalidateLicenseCache } = await import("../../../../../lib/licensing/gate.js"); invalidateLicenseCache(orgId);
    return NextResponse.json({ ok: true, ...JSON.parse(JSON.stringify(result || {})) });
  } catch (err) {
    if (err instanceof L.LicenseError || err?.status) {
      if (err.code === "DUPLICATE_REFERENCE") import("../../../../../lib/metrics/metrics.js").then((m) => m.metric?.("license.payment", { orgId, label: "duplicate_prevented" })).catch(() => {});
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status || 400 });
    }
    console.error("admin/licenses POST failed:", err?.message);
    import("../../../../../lib/metrics/metrics.js").then((m) => m.metric?.("license.payment", { orgId, label: "action_failed" })).catch(() => {});
    return NextResponse.json({ error: "The change could not be saved. Nothing was changed." }, { status: 500 });
  }
}
