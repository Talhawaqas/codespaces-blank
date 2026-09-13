// app/api/orgs/escrow/route.js
//
// POST /api/orgs/escrow  { orgId, purchaseOrderId?, vendorId?, currency?, milestones, expiresAt? }
// GET  /api/orgs/escrow?orgId=&purchaseOrderId=

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessEscrow } from "../../../../lib/orgs.js";
import { createEscrow, listEscrows } from "../../../../lib/escrow-workflow.js";

function serialize(e) {
  return {
    id: e._id.toString(), orgId: e.orgId.toString(), purchaseOrderId: e.purchaseOrderId?.toString() || null,
    vendorId: e.vendorId?.toString() || null, currency: e.currency, totalAmount: e.totalAmount, status: e.status,
    milestones: e.milestones.map((m) => ({ description: m.description, amount: m.amount, status: m.status, releasedPaymentId: m.releasedPaymentId?.toString() || null })),
    disputes: e.disputes || [], expiresAt: e.expiresAt, createdByEmail: e.createdByEmail, createdAt: e.createdAt,
  };
}

export async function POST(req) {
  try {
    const { orgId, purchaseOrderId, vendorId, currency, milestones, expiresAt } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await createEscrow({ orgId, purchaseOrderId, vendorId, currency, milestones, expiresAt, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ escrowId: result.escrowId.toString() });
  } catch (err) {
    console.error("orgs/escrow POST failed:", err);
    return NextResponse.json({ error: "Could not create the escrow." }, { status: 500 });
  }
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const purchaseOrderId = searchParams.get("purchaseOrderId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessEscrow(auth.membership)) return NextResponse.json({ error: "You don't have escrow access." }, { status: 403 });

    const list = await listEscrows({ orgId, purchaseOrderId });
    return NextResponse.json({ escrows: list.map(serialize) });
  } catch (err) {
    console.error("orgs/escrow GET failed:", err);
    return NextResponse.json({ error: "Could not fetch escrows." }, { status: 500 });
  }
}
