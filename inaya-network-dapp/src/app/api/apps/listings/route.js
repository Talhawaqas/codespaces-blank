// app/api/apps/listings/route.js
//
// GET /api/apps/listings — public. Only ever returns status:"approved"
// community App Store listings (listApprovedListings() itself hardcodes
// that filter, so this route can't accidentally leak pending/rejected
// submissions even if it forgot to ask).

import { NextResponse } from "next/server";
import { listApprovedListings } from "../../../../lib/appStoreListings";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const listings = await listApprovedListings();
    return NextResponse.json({ listings });
  } catch (err) {
    console.error("apps/listings GET failed:", err);
    return NextResponse.json({ error: "Could not load listings." }, { status: 500 });
  }
}
