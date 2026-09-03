// app/api/orgs/notifications/route.js
//
// GET /api/orgs/notifications?orgId=&unreadOnly=true
//
// Enterprise OS SOW, Phase 3. Same auth shape as every other orgs/*
// route — requireMembership gates it, listNotificationsFor
// (src/lib/notifications.js) does the actual read. A deliberately new
// namespace: GET /api/notifications (referral/KYC feed) is untouched —
// different product, different schema, see notifications.js's header.

import { NextResponse } from "next/server";
import { requireMembership } from "../../../../lib/orgs.js";
import { listNotificationsFor } from "../../../../lib/notifications.js";

export async function GET(req) {
  try {
    const url = new URL(req.url);
    const orgId = url.searchParams.get("orgId");
    const unreadOnly = url.searchParams.get("unreadOnly") === "true";
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const notifications = await listNotificationsFor({ scope: "org", orgId, email: auth.session.email, unreadOnly });
    return NextResponse.json({ notifications });
  } catch (err) {
    console.error("orgs/notifications failed:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
