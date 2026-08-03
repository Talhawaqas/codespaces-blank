// app/api/egress-unlock-status/route.js
//
// GET /api/egress-unlock-status?fileHash=0x...  (email via cookie or ?email=)
//
// Checked before a card customer's Reconstruct actually fetches/decrypts —
// if this returns unlocked: false, the frontend should send them through
// create-egress-checkout-session first instead of proceeding.

import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../lib/mongodb";

export async function GET(req) {
  const email = req.nextUrl.searchParams.get("email") || req.cookies.get("inaya_customer_email")?.value;
  const fileHash = req.nextUrl.searchParams.get("fileHash");

  if (!email || !fileHash) {
    return NextResponse.json({ error: "email (or cookie) and fileHash are both required" }, { status: 400 });
  }

  const { db } = await connectToDatabase();
  const record = await db.collection("egress_unlocks").findOne({
    email: email.toLowerCase(),
    fileHash,
  });

  return NextResponse.json({ unlocked: !!record });
}