// app/api/apps/my-listings/route.js
//
// GET /api/apps/my-listings?address= — public, no auth required (mirrors
// /api/nft/backups' shape exactly). Returns every submission from one
// wallet regardless of status, so a developer (via the CLI/SDK or the
// web form) can check whether their own pending submission was approved
// or rejected without needing admin access. Scoped strictly to the
// querying address's own data — never returns another wallet's listings.

import { NextResponse } from "next/server";
import { listListingsBySubmitter } from "../../../../lib/appStoreListings";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const address = searchParams.get("address");
    if (!address) return NextResponse.json({ error: "address is required." }, { status: 400 });

    const listings = await listListingsBySubmitter(address);
    return NextResponse.json({ listings });
  } catch (err) {
    console.error("apps/my-listings GET failed:", err);
    return NextResponse.json({ error: "Could not load your listings." }, { status: 500 });
  }
}
