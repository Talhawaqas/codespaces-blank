// app/api/orgs/nas/appliances/[applianceId]/health/route.js
// POST { orgId } -> real, on-demand TCP reachability + service-status check

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { checkApplianceHealth } from "../../../../../../../lib/nas/appliances.js";

export async function POST(req, { params }) {
  try {
    const { applianceId } = await params;
    const body = await req.json().catch(() => ({}));
    const { orgId } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await checkApplianceHealth({ orgId, applianceId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/nas/appliances/[applianceId]/health POST failed:", err);
    return NextResponse.json({ error: "Health check failed." }, { status: 500 });
  }
}
