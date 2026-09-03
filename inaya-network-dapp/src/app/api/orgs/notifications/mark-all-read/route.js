// app/api/orgs/notifications/mark-all-read/route.js
//
// POST /api/orgs/notifications/mark-all-read  Body: { orgId }
//
// Enterprise OS SOW, Phase 3.

import { NextResponse } from "next/server";
import { requireMembership } from "../../../../../lib/orgs.js";
import { markAllRead } from "../../../../../lib/notifications.js";

export async function POST(req) {
  try {
    const { orgId } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await markAllRead({ scope: "org", orgId, email: auth.session.email });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/notifications/mark-all-read failed:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
