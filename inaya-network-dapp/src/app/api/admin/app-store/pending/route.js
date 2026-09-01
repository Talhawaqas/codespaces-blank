// app/api/admin/app-store/pending/route.js
//
// GET /api/admin/app-store/pending — admin-only (same passphrase-gated
// session as every other /admin/* surface). Lists every submission
// awaiting review, including its threatCheck result from submission time,
// so a reviewer sees the security signal immediately without a separate
// lookup.

import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../../lib/admin-auth.js";
import { listPendingListings } from "../../../../../lib/appStoreListings";

export const dynamic = "force-dynamic";

export async function GET(req) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const listings = await listPendingListings();
    return NextResponse.json({ listings });
  } catch (err) {
    console.error("admin/app-store/pending GET failed:", err);
    return NextResponse.json({ error: "Could not load pending listings." }, { status: 500 });
  }
}
