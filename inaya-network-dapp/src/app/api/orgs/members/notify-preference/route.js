// app/api/orgs/members/notify-preference/route.js
//
// POST /api/orgs/members/notify-preference
// Body: { orgId, notifyOnApprovals: boolean }
//
// Self-service only -- any active member can set THEIR OWN preference
// (never anyone else's; the update filter is scoped to the caller's own
// session email, not an email in the request body). Controls whether
// document-workflow.js's notifyApproversOfSubmission() emails this person
// when a document is submitted for their approval. Missing/undefined on
// the org_members doc means "on" (see that function's own comment) --
// this route is what lets someone actually turn it off.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, toObjectId } from "../../../../../lib/orgs.js";

export async function POST(req) {
  try {
    const { orgId, notifyOnApprovals } = await req.json();
    if (!orgId || typeof notifyOnApprovals !== "boolean") {
      return NextResponse.json({ error: "orgId and a boolean notifyOnApprovals are required." }, { status: 400 });
    }

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { orgMembers } = await getOrgCollections();
    await orgMembers.updateOne(
      { orgId: toObjectId(orgId), email: auth.session.email },
      { $set: { notifyOnApprovals } }
    );

    return NextResponse.json({ notifyOnApprovals });
  } catch (err) {
    console.error("orgs/members/notify-preference POST failed:", err);
    return NextResponse.json({ error: "Could not save your preference." }, { status: 500 });
  }
}
