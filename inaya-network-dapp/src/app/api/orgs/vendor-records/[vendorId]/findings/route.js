// app/api/orgs/vendor-records/[vendorId]/findings/route.js
// POST { orgId, description, severity? } -> append a vendor security finding (append-only)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { recordVendorFinding } from "../../../../../../lib/vendor-management.js";

export async function POST(req, { params }) {
  try {
    const { vendorId } = await params;
    const body = await req.json();
    const { orgId, description } = body;
    if (!orgId || !description) return NextResponse.json({ error: "orgId and description are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await recordVendorFinding({ ...body, vendorId, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ findings: result.vendor.findings });
  } catch (err) {
    console.error("orgs/vendor-records/[vendorId]/findings POST failed:", err);
    return NextResponse.json({ error: "Could not record vendor finding." }, { status: 500 });
  }
}
