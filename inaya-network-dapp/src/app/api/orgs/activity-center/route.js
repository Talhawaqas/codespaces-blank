// app/api/orgs/activity-center/route.js
//
// GET /api/orgs/activity-center?orgId=&period=daily|weekly|monthly|yearly
//
// Enterprise OS SOW, Phase 5.

import { NextResponse } from "next/server";
import { requireMembership, getOrgCollections, toObjectId } from "../../../../lib/orgs.js";
import { generateWhatChanged } from "../../../../lib/activityCenter.js";

export async function GET(req) {
  try {
    const url = new URL(req.url);
    const orgId = url.searchParams.get("orgId");
    const period = url.searchParams.get("period") || "weekly";
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { orgs } = await getOrgCollections();
    const org = await orgs.findOne({ _id: toObjectId(orgId) });

    const digest = await generateWhatChanged({
      scope: "org",
      orgId,
      membership: auth.membership,
      email: auth.session.email,
      period,
      orgName: org?.name,
    });
    return NextResponse.json(digest);
  } catch (err) {
    console.error("orgs/activity-center failed:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
