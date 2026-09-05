// app/api/orgs/settings/route.js
// GET   ?orgId= -> the org's profile (vertical, industry, policies) + classification levels
// PATCH { orgId, ...updates } -> update profile fields (owner/admin only)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { getOrgProfile, updateOrgProfile } from "../../../../lib/industry-config.js";
import { getOrgClassificationLevels } from "../../../../lib/classification.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const [profile, classificationLevels] = await Promise.all([getOrgProfile(orgId), getOrgClassificationLevels(orgId)]);
    return NextResponse.json({
      profile: { vertical: profile.vertical, industry: profile.industry, organizationType: profile.organizationType, timeZone: profile.timeZone, branding: profile.branding },
      classificationLevels: classificationLevels.map((l) => ({ key: l.key, label: l.label, restricted: l.restricted })),
    });
  } catch (err) {
    console.error("orgs/settings GET failed:", err);
    return NextResponse.json({ error: "Could not fetch organization settings." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const body = await req.json();
    const { orgId, ...updates } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await updateOrgProfile({ orgId, updates, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ profile: { vertical: result.org.vertical, industry: result.org.industry } });
  } catch (err) {
    console.error("orgs/settings PATCH failed:", err);
    return NextResponse.json({ error: "Could not update organization settings." }, { status: 500 });
  }
}
