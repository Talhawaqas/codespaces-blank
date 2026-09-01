// app/api/apps/submit/route.js
//
// POST /api/apps/submit
// Body: { name, description, category, hostType, cid?, embedUrl?, address, message, signature, timestamp }
//
// Wallet-signed community App Store submission. See appStoreListings.js's
// header for the full security model — this route just wires the request
// into submitAppListing(), which does the real validation, signature
// verification, and threat check. Every submission lands as "pending";
// nothing here can make a listing publicly visible.

import { NextResponse } from "next/server";
import { submitAppListing } from "../../../../lib/appStoreListings";

export async function POST(req) {
  try {
    const body = await req.json();
    const listing = await submitAppListing(body);
    return NextResponse.json({ slug: listing.slug, status: listing.status });
  } catch (err) {
    console.error("apps/submit POST failed:", err);
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
