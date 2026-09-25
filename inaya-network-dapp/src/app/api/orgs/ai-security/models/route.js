// app/api/orgs/ai-security/models/route.js
// GET ?orgId= -> the model/component registry (SOW Phase 5/15)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessAiSecurity } from "../../../../../lib/orgs.js";
import { listApprovedModels } from "../../../../../lib/aiSecurity/modelRegistry.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessAiSecurity(auth.membership)) return NextResponse.json({ error: "You don't have access to the model registry." }, { status: 403 });

    const models = await listApprovedModels();
    return NextResponse.json({ models });
  } catch (err) {
    console.error("orgs/ai-security/models GET failed:", err);
    return NextResponse.json({ error: "Could not fetch model registry." }, { status: 500 });
  }
}
