// app/api/orgs/finance/payments/[paymentId]/approve/route.js
//
// POST /api/orgs/finance/payments/:paymentId/approve
// Body: { orgId }
// The one manage-gated transition payments have — RECORDED -> APPROVED.
// Atomic findOneAndUpdate with a status:"RECORDED" filter, same
// replay-safety pattern as every workflow transition in this app, even
// though this is the only transition this record type has.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, canManageFinance, toObjectId } from "../../../../../../../lib/orgs.js";
import { logOrgActivity } from "../../../../../../../lib/org-activity-log.js";

export async function POST(req, { params }) {
  try {
    const { paymentId } = params;
    const { orgId } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { payments } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const paymentObjectId = toObjectId(paymentId);

    const payment = await payments.findOne({ _id: paymentObjectId, orgId: orgObjectId, deletedAt: null });
    if (!payment) return NextResponse.json({ error: "Payment not found." }, { status: 404 });
    if (!canAccessDepartment(auth.membership, payment.departmentId)) return NextResponse.json({ error: "Payment not found." }, { status: 404 });
    if (!canManageFinance(auth.membership)) return NextResponse.json({ error: "Only a Finance Manager or an owner/admin can approve payments." }, { status: 403 });

    const updated = await payments.findOneAndUpdate(
      { _id: paymentObjectId, orgId: orgObjectId, status: "RECORDED" },
      { $set: { status: "APPROVED" } },
      { returnDocument: "after" }
    );
    if (!updated) return NextResponse.json({ error: `This payment isn't in RECORDED state (it's ${payment.status}).` }, { status: 409 });

    await logOrgActivity({
      orgId: orgObjectId, recordType: "PAYMENT", recordId: paymentObjectId, actorEmail: auth.session.email,
      action: "PAYMENT_APPROVED", previousState: "RECORDED", newState: "APPROVED", metadata: {},
    });

    return NextResponse.json({ status: "APPROVED" });
  } catch (err) {
    console.error("orgs/finance/payments/[paymentId]/approve failed:", err);
    return NextResponse.json({ error: "Could not approve the payment." }, { status: 500 });
  }
}
