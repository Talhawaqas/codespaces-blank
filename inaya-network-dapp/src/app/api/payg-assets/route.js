// app/api/payg-assets/route.js
//
// GET /api/payg-assets?email=customer@example.com  (or relies on the
// inaya_customer_email cookie, same fallback pattern as corporate-plan-status)
//
// Lists the files a card-paying customer has uploaded via PAYG, so the
// Dashboard/Vault can show them something to download without a wallet.

import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../lib/mongodb";

export async function GET(req) {
  const email = req.nextUrl.searchParams.get("email") || req.cookies.get("inaya_customer_email")?.value;
  if (!email) {
    return NextResponse.json({ error: "No email provided and no inaya_customer_email cookie set" }, { status: 400 });
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