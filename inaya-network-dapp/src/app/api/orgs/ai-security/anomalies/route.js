// app/api/orgs/ai-security/anomalies/route.js
// GET ?orgId=&windowMinutes= -> spike / anomaly findings over the AI security event log (SOW Phase 11.3)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canManageAiSecurity } from "../../../../../lib/orgs.js";
import { analyzeOrg } from "../../../../../lib/aiSecurity/anomaly.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canManageAiSecurity(auth.membership)) return NextResponse.json({ error: "Only an owner or admin can view AI security anomalies." }, { status: 403 });

    const requested = Number(searchParams.get("windowMinutes"));
    const windowMinutes = Number.isFinite(requested) && requested >= 5 && requested <= 24 * 60 ? requested : 60;
    return NextResponse.json(await analyzeOrg({ orgId, windowMinutes }));
  } catch (err) {
    console.error("orgs/ai-security/anomalies GET failed:", err);
    return NextResponse.json({ error: "Could not analyze AI security events." }, { status: 500 });
  }
}
