// app/api/ai/voice-capability/route.js
// GET ?orgId= -> { enabled } -- lets the UI decide whether to render the
// mic control at all. Never trusted as the real authorization boundary by
// itself: /api/ai/voice-session and /api/ai/voice-tool-relay both
// re-check isVoiceEnabledForOrg() server-side on every request regardless
// of what this returns.

import { NextResponse } from "next/server";
import { requireMembership, getOrgCollections, toObjectId } from "../../../../lib/orgs.js";
import { getOrgProfile } from "../../../../lib/industry-config.js";
import { isVoiceEnabledForOrg } from "../../../../lib/ai-voice-session.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { orgs } = await getOrgCollections();
    const org = await orgs.findOne({ _id: toObjectId(orgId) });
    if (!org) return NextResponse.json({ error: "Company not found." }, { status: 404 });

    const profile = await getOrgProfile(orgId);
    return NextResponse.json({ enabled: isVoiceEnabledForOrg(profile) });
  } catch (err) {
    console.error("voice-capability GET failed:", err);
    return NextResponse.json({ enabled: false });
  }
}
