// app/api/payg-assets/route.js
//
// GET /api/payg-assets
//
// Lists the files a card-paying customer has uploaded via PAYG, so the
// Dashboard/Vault can show them something to download without a wallet.
//
// Identity comes ONLY from the inaya_customer_email cookie -- httpOnly, and
// only ever set by resolve-checkout-session/route.js after independently
// verifying a real Stripe checkout session server-side. This used to also
// accept a plain ?email= query param as an equally-trusted alternative,
// which meant anyone could read any other customer's file metadata just by
// guessing/knowing their email — the query param is gone now; a request
// with no valid cookie has no identity here.

import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../lib/mongodb";

export async function GET(req) {
  const email = req.cookies.get("inaya_customer_email")?.value;
  if (!email) {
    return NextResponse.json({ error: "No inaya_customer_email cookie set" }, { status: 401 });
  }

  const { db } = await connectToDatabase();
  const assets = await db
    .collection("payg_assets")
    .find({ email: email.toLowerCase() })
    .sort({ uploadedAt: -1 })
    .toArray();

  return NextResponse.json({
    assets: assets.map((a) => ({
      filename: a.filename,
      fileHash: a.fileHash,
      sizeBytes: a.sizeBytes,
      txHash: a.txHash,
      uploadedAt: a.uploadedAt,
    })),
  });
}