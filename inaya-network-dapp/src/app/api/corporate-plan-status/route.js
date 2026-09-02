// app/api/corporate-plan-status/route.js
//
// GET /api/corporate-plan-status
// The Dashboard calls this for card customers (no wallet connected, so
// getActiveCorporatePlan(walletAddress) — the existing localStorage
// lookup — has nothing to key off). Returns the same shape the existing
// wallet-based flow produces, so the Dashboard UI doesn't need two
// different rendering paths.
//
// Identity comes ONLY from the inaya_customer_email cookie -- see
// payg-assets/route.js's header comment for why a client-supplied ?email=
// is no longer accepted as an alternative (it let anyone query any other
// customer's plan/billing status).

import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../lib/mongodb";

export async function GET(req) {
  const email = req.cookies.get("inaya_customer_email")?.value;
  if (!email) {
    return NextResponse.json({ error: "No inaya_customer_email cookie set" }, { status: 401 });
  }

  const { db } = await connectToDatabase();
  const plan = await db.collection("corporate_plans").findOne({ email: email.toLowerCase() });

  if (!plan || plan.expiresAt < Date.now()) {
    return NextResponse.json({ active: false });
  }

  return NextResponse.json({
    active: true,
    tier: plan.tier,
    activatedAt: plan.activatedAt,
    expiresAt: plan.expiresAt,
    routerTxHash: plan.routerTxHash,
    escrowTxHash: plan.escrowTxHash,
  });
}