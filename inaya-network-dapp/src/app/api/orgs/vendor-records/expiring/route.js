// app/api/orgs/vendor-records/expiring/route.js
// GET ?orgId=&withinDays= -> vendor certificates/contracts expiring soon (§66)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { listExpiringVendorItems } from "../../../../../lib/vendor-management.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const withinDays = parseInt(searchParams.get("withinDays") || "30", 10);
    const expiring = await listExpiringVendorItems(orgId, { withinDays });
    return NextResponse.json({ expiring });
  } catch (err) {
    console.error("orgs/vendor-records/expiring GET failed:", err);
    return NextResponse.json({ error: "Could not fetch expiring vendor items." }, { status: 500 });
  }
}
