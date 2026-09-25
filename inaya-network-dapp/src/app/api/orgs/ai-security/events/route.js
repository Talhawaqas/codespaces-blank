// app/api/orgs/ai-security/events/route.js
// GET ?orgId=&limit=&category=&decision= -> lists AI security events (SOW Phase 22 dashboard feed)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessAiSecurity } from "../../../../../lib/orgs.js";
import { listAiSecurityEvents } from "../../../../../lib/aiSecurity/events.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessAiSecurity(auth.membership)) return NextResponse.json({ error: "You don't have access to AI security events." }, { status: 403 });

    const limit = Number(searchParams.get("limit")) || 100;
    const category = searchParams.get("category") || undefined;
    const decision = searchParams.get("decision") || undefined;

    const events = await listAiSecurityEvents({ orgId, limit, category, decision });
    return NextResponse.json({ events });
  } catch (err) {
    console.error("orgs/ai-security/events GET failed:", err);
    return NextResponse.json({ error: "Could not list AI security events." }, { status: 500 });
  }
}
