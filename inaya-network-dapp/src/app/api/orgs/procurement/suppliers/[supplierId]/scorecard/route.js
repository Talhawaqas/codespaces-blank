// app/api/orgs/procurement/suppliers/[supplierId]/scorecard/route.js
//
// GET /api/orgs/procurement/suppliers/:supplierId/scorecard?orgId=...
//   -> fill rate, on-time rate, lead time and cancellation rate from real
//      purchase-order data (lib/supplier-scorecard.js). Same department
//      access rule as reading the supplier itself.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { computeSupplierScorecard } from "../../../../../../../lib/supplier-scorecard.js";

export async function GET(req, { params }) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await computeSupplierScorecard({ orgId, supplierId: params.supplierId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/procurement/suppliers/[supplierId]/scorecard failed:", err);
    return NextResponse.json({ error: "Could not compute the supplier scorecard." }, { status: 500 });
  }
}
