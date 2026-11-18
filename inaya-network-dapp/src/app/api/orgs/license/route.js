// app/api/orgs/license/route.js
//
// GET /api/orgs/license?orgId=  -> Owner/Admin: the company's license as Billing shows it (SOW 7.1): package, state,
// cycle, amount, dates, deadline + remaining time, payment history, payment instructions and export jobs.
// Never internal admin notes, admin names or full payment references. Open while restricted (licensing/gate.js).
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { companyPaymentHistory, getLicense, publicLicenseView } from "../../../../lib/licensing/service.js";
import { STATE_LABELS } from "../../../../lib/licensing/state.js";
import { formatBillingDateLong, formatDeadline, remaining } from "../../../../lib/licensing/dates.js";
import { GRACE_DAYS, BILLING_TZ_LABEL } from "../../../../lib/licensing/config.js";
import { ACTIVATION_INBOX } from "../../../../lib/billingRequests.js";
import { listExports } from "../../../../lib/licensing/exports.js";
import { getPaymentChannels } from "../../../../lib/invoicing.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const now = new Date();
    const lic = await getLicense(orgId);
    const [payments, exports, channels] = await Promise.all([lic ? companyPaymentHistory(orgId) : [], listExports(orgId), getPaymentChannels().catch(() => null)]);
    // Inaya's own receiving accounts (set on /admin/billing, the same details printed on invoices) -- payment
    // destinations meant for customers, never Inaya's credentials.
    const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k] || ""]).filter(([, v]) => v));
    const bank = pick(channels?.bank, ["bankName", "accountTitle", "accountNumber", "iban", "swift", "branch"]);
    const nayapay = pick(channels?.nayapay, ["accountName", "nayapayId", "iban"]);
    const v = publicLicenseView(lic, now);
    const fmt = (d) => (d ? formatBillingDateLong(d) : null);
    return NextResponse.json({
      license: v && {
        ...v, label: STATE_LABELS[v.state] || v.state,
        paidThroughText: fmt(v.paidThroughDate), nextPaymentDueText: fmt(v.nextPaymentDueDate),
        paymentDueText: v.paymentDueAt ? formatDeadline(v.paymentDueAt) : null,
        graceEndsText: v.graceEndsAt ? formatDeadline(v.graceEndsAt) : null,
        graceRemaining: v.state === "grace_period" && v.graceEndsAt ? remaining(v.graceEndsAt, now).label : null,
        cancelEffectiveText: v.cancelEffectiveAt ? formatDeadline(v.cancelEffectiveAt) : null,
      },
      payments, exports,
      policy: { graceDays: GRACE_DAYS, timezone: BILLING_TZ_LABEL },
      paymentInstructions: { methods: ["NayaPay", "Bank transfer"], contact: ACTIVATION_INBOX, bank: Object.keys(bank).length ? bank : null, nayapay: Object.keys(nayapay).length ? nayapay : null, text: `Pay by NayaPay or bank transfer. If you do not have Inaya's payment details, write to ${ACTIVATION_INBOX} with your company name. Your payment is confirmed by the Inaya team, usually within one working day.` },
    });
  } catch (err) {
    console.error("orgs/license failed:", err?.message);
    return NextResponse.json({ error: "Could not load billing." }, { status: 500 });
  }
}
