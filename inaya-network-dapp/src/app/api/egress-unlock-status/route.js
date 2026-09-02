// app/api/egress-unlock-status/route.js
//
// GET /api/egress-unlock-status?fileHash=0x...
//
// Checked before a card customer's Reconstruct actually fetches/decrypts —
// if this returns unlocked: false, the frontend should send them through
// create-egress-checkout-session first instead of proceeding.
//
// Identity comes ONLY from the inaya_customer_email cookie -- see
// payg-assets/route.js's header comment for why a client-supplied ?email=
// is no longer accepted as an alternative (it let anyone query any other
// customer's unlock status).

import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../lib/mongodb";

export async function GET(req) {
  const email = req.cookies.get("inaya_customer_email")?.value;
  const fileHash = req.nextUrl.searchParams.get("fileHash");

  if (!email || !fileHash) {
    return NextResponse.json({ error: "No inaya_customer_email cookie set, or fileHash is missing" }, { status: 401 });
  }

  const { db } = await connectToDatabase();
  const record = await db.collection("egress_unlocks").findOne({
    email: email.toLowerCase(),
    fileHash,
  });

  return NextResponse.json({ unlocked: !!record });
}