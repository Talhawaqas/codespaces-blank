// app/api/admin/customers/route.js
//
// GET /api/admin/customers
//
// Lists every Corporate Reserve customer. Active/expired is computed
// with the EXACT same check as corporate-plan-status/route.js
// (`plan.expiresAt < Date.now()`) — deliberately not reimplemented
// differently here, per the SOW's explicit instruction, so the two
// routes can never silently disagree about whether a plan is active.

import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../../lib/mongodb";
import { isAdminAuthenticated } from "../../../../lib/admin-auth";

export async function GET(req) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { db } = await connectToDatabase();
  const plans = await db.collection("corporate_plans").find({}).sort({ activatedAt: -1 }).toArray();

  const now = Date.now();
  const customers = plans.map((plan) => ({
    email: plan.email,
    tier: plan.tier,
    status: plan.expiresAt < now ? "expired" : "active", // same check as corporate-plan-status/route.js, on purpose
    activatedAt: plan.activatedAt,
    expiresAt: plan.expiresAt,
    amountUsd: typeof plan.amountUsd === "number" ? plan.amountUsd : null,
  }));

  return NextResponse.json({
    customers,
    totalCount: customers.length,
    activeCount: customers.filter((c) => c.status === "active").length,
    expiredCount: customers.filter((c) => c.status === "expired").length,
  });
}
