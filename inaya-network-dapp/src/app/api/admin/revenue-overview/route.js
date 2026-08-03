// app/api/admin/revenue-overview/route.js
//
// GET /api/admin/revenue-overview
//
// Corporate Reserve revenue is a direct sum of corporate_plans.amountUsd
// (a real field, populated at checkout — see stripe-webhook.js).
// Egress revenue is a direct sum of egress_unlocks.amountUsd (same
// reasoning).
//
// PAYG revenue is NOT a direct sum: verified directly against the live
// payg_assets schema before building this (Phase 3 Tier 2 SOW itself
// flagged this as needing confirmation) — payg_assets has NO amountUsd
// field at all, only a stripeSessionId reference and sizeBytes. The two
// options were (a) look up each session's REAL charged amount via the
// Stripe API, or (b) re-derive an estimate from sizeBytes * the current
// live per-GB rate. (b) would not be the actual historical charged
// amount (create-payg-checkout-session prices off a live PancakeSwap
// spot price at charge time, which drifts) — presenting an estimate as
// "revenue" would violate the standing no-fabricated-numbers rule. So
// this route does (a): a real Stripe API lookup per session. At current
// real data volume (8 payg_assets documents) this is fast and well
// within Stripe's rate limits; if that volume grows substantially,
// revisit with caching or a stored-at-checkout-time amount instead.

import { NextResponse } from "next/server";
import Stripe from "stripe";
import { connectToDatabase } from "../../../../lib/mongodb";
import { isAdminAuthenticated } from "../../../../lib/admin-auth";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function GET(req) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { db } = await connectToDatabase();

  const corporatePlans = await db.collection("corporate_plans").find({}).toArray();
  const corporateByTier = {};
  let corporateTotalUsd = 0;
  let corporateUnavailableCount = 0;
  for (const plan of corporatePlans) {
    if (typeof plan.amountUsd !== "number") { corporateUnavailableCount++; continue; } // never fabricate — skip, don't assume 0
    corporateTotalUsd += plan.amountUsd;
    corporateByTier[plan.tier] = (corporateByTier[plan.tier] || 0) + plan.amountUsd;
  }

  const egressUnlocks = await db.collection("egress_unlocks").find({}).toArray();
  let egressTotalUsd = 0;
  let egressUnavailableCount = 0;
  for (const unlock of egressUnlocks) {
    if (typeof unlock.amountUsd !== "number") { egressUnavailableCount++; continue; }
    egressTotalUsd += unlock.amountUsd;
  }

  const paygAssets = await db.collection("payg_assets").find({}).toArray();
  let paygTotalUsd = 0;
  let paygUnavailableCount = 0;
  const paygLookupErrors = [];
  await Promise.all(
    paygAssets.map(async (asset) => {
      if (!asset.stripeSessionId) { paygUnavailableCount++; return; }
      try {
        const session = await stripe.checkout.sessions.retrieve(asset.stripeSessionId);
        if (typeof session.amount_total !== "number") { paygUnavailableCount++; return; }
        paygTotalUsd += session.amount_total / 100;
      } catch (err) {
        paygUnavailableCount++;
        paygLookupErrors.push({ stripeSessionId: asset.stripeSessionId, error: err.message });
      }
    })
  );

  // Same rule as custody-sdk's Analytics module: null (never a partial sum presented as
  // a total, and never 0 as a stand-in for "unknown") whenever even one record's real
  // amount couldn't be confirmed — a partial sum silently understates real revenue.
  return NextResponse.json({
    corporateReserve: {
      totalUsd: corporateUnavailableCount > 0 ? null : corporateTotalUsd,
      byTier: corporateByTier,
      planCount: corporatePlans.length,
      unavailableCount: corporateUnavailableCount,
    },
    payg: {
      totalUsd: paygUnavailableCount > 0 ? null : paygTotalUsd,
      source: "real Stripe checkout session amounts, looked up live per stripeSessionId",
      assetCount: paygAssets.length,
      unavailableCount: paygUnavailableCount,
      lookupErrors: paygLookupErrors,
    },
    egress: {
      totalUsd: egressUnavailableCount > 0 ? null : egressTotalUsd,
      unlockCount: egressUnlocks.length,
      unavailableCount: egressUnavailableCount,
    },
  });
}
