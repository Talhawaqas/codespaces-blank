// app/api/admin/app-store/[slug]/review/route.js
//
// POST /api/admin/app-store/:slug/review
// Body: { decision: "approve"|"reject", note? }
//
// Admin-only. reviewAppListing() re-runs the threat check at review time
// (not just trusting the submission-time result — a domain can turn
// malicious in between) before recording the decision.

import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../../../lib/admin-auth.js";
import { reviewAppListing } from "../../../../../../lib/appStoreListings";

export async function POST(req, { params }) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const { slug } = params;
    const { decision, note } = await req.json();
    const listing = await reviewAppListing({ slug, decision, note });
    return NextResponse.json({ listing });
  } catch (err) {
    console.error("admin/app-store review POST failed:", err);
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
