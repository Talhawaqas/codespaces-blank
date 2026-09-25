// app/api/orgs/ai-security/explain/[eventId]/route.js
// GET ?orgId= -> the "Why?" explanation for one AI security decision (SOW Phase 23, §28)
//
// Shows provenance (reasons, controls triggered, policy version, model,
// request id) -- never hidden chain-of-thought, never internal detection
// regex/thresholds that would let someone tune around them (SOW §15.3).

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessAiSecurity } from "../../../../../../lib/orgs.js";
import { getAiSecurityEvent } from "../../../../../../lib/aiSecurity/events.js";

export async function GET(req, { params }) {
  try {
    const { eventId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessAiSecurity(auth.membership)) return NextResponse.json({ error: "You don't have access to AI security explanations." }, { status: 403 });

    const event = await getAiSecurityEvent({ orgId, eventId });
    if (!event) return NextResponse.json({ error: "Event not found." }, { status: 404 });

    return NextResponse.json({
      decision: event.decision,
      severity: event.severity,
      why: event.reasons,
      evidence: {
        requestId: event.requestId,
        controlsTriggered: event.controlsTriggered,
        policyVersion: event.policyVersion,
        modelId: event.modelId,
        surface: event.surface,
        vertical: event.vertical,
        timestamp: event.timestamp,
      },
    });
  } catch (err) {
    console.error("orgs/ai-security/explain GET failed:", err);
    return NextResponse.json({ error: "Could not fetch explanation." }, { status: 500 });
  }
}
