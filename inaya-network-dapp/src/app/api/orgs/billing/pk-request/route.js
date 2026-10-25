// app/api/orgs/billing/pk-request/route.js
//
// POST { orgId, planId, interval?, pilot? } — a company asks for a PKR
// package, paid by bank transfer (src/lib/billingRequests.js). Owner/admin only.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { requestPkPlan } from "../../../../../lib/billingRequests.js";

export async function POST(req) {
  try {
    let body = {};
    try { body = await req.json(); } catch { body = {}; }
    const { orgId, planId, interval = "month", pilot = false } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await requestPkPlan({ orgId, planId, interval, pilot: !!pilot, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/billing/pk-request failed:", err);
    return NextResponse.json({ error: "Could not record your request. Please try again." }, { status: 500 });
  }
}
