// app/api/orgs/resilience/status/route.js
//
// GET /api/orgs/resilience/status?orgId= — the SOW's five-state
// dashboard summary (VERIFIED/DEGRADED/FAILED/UNKNOWN/TEST_DUE) per
// policy, always computed from real test-run data.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { getResilienceStatus } from "../../../../../lib/resilience-status.js";

export async function GET(req) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await getResilienceStatus(orgId);
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/resilience/status GET failed:", err);
    return NextResponse.json({ error: "Could not load resilience status." }, { status: 500 });
  }
}
