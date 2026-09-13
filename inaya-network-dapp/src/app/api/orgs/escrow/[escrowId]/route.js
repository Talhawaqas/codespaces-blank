// app/api/orgs/escrow/[escrowId]/route.js
// GET /api/orgs/escrow/:escrowId?orgId=

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessEscrow } from "../../../../../lib/orgs.js";
import { getEscrow } from "../../../../../lib/escrow-workflow.js";

export async function GET(req, { params }) {
  try {
    const { escrowId } = params;
    const orgId = req.nextUrl.searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessEscrow(auth.membership)) return NextResponse.json({ error: "You don't have escrow access." }, { status: 403 });

    const e = await getEscrow({ orgId, escrowId });
    if (!e) return NextResponse.json({ error: "Escrow not found." }, { status: 404 });

    return NextResponse.json({
      id: e._id.toString(), purchaseOrderId: e.purchaseOrderId?.toString() || null, currency: e.currency,
      totalAmount: e.totalAmount, status: e.status,
      milestones: e.milestones.map((m) => ({ description: m.description, amount: m.amount, status: m.status, releasedPaymentId: m.releasedPaymentId?.toString() || null })),
      disputes: e.disputes || [], expiresAt: e.expiresAt, createdByEmail: e.createdByEmail, createdAt: e.createdAt,
    });
  } catch (err) {
    console.error("orgs/escrow/[escrowId] GET failed:", err);
    return NextResponse.json({ error: "Could not load the escrow." }, { status: 500 });
  }
}
