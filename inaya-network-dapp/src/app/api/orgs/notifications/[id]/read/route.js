// app/api/orgs/notifications/[id]/read/route.js
//
// POST /api/orgs/notifications/:id/read  Body: { orgId }
//
// Enterprise OS SOW, Phase 3.

import { NextResponse } from "next/server";
import { requireMembership } from "../../../../../../lib/orgs.js";
import { markRead } from "../../../../../../lib/notifications.js";

export async function POST(req, { params }) {
  try {
    const { orgId } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    await markRead({ scope: "org", orgId, email: auth.session.email, notificationId: params.id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("orgs/notifications/[id]/read failed:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
