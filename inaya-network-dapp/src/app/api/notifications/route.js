// app/api/notifications/route.js
//
// GET /api/notifications?email=... -> a lightweight, read-only "what
// happened recently" feed for the in-app notification center (web +
// mobile). Deliberately computed on read from data that already exists
// (referral_rewards, kyc_identities) rather than a new stored event
// log -- no new collection, no hooks into existing write paths, so this
// carries zero risk to the referral/KYC flows it reads from.
//
// Wallet-only events (staking unlock ready, Genesis Airdrop cap reached)
// are NOT computed here -- the web/mobile client already reads that
// on-chain state directly (same pattern as the rest of the dApp), so
// duplicating it server-side would just be a slower, staler copy. This
// endpoint only covers the email-identified referral/KYC program, which
// has no equivalent client-side on-chain source.
//
// Same auth model as the rest of the referral feature: email only, no
// wallet, no password, accounting only (no funds exposed) -- see
// referrals/history/route.js's header comment for the same reasoning.

import { NextResponse } from "next/server";
import { getReferralCollections, normalizeEmail } from "../../../lib/referrals.js";

const LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export const dynamic = "force-dynamic";
export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const email = normalizeEmail(searchParams.get("email") || "");
    if (!email) return NextResponse.json({ notifications: [] });

    const { referralRewards, kycIdentities } = await getReferralCollections();
    const since = new Date(Date.now() - LOOKBACK_MS);

    const [recentRewards, identity] = await Promise.all([
      referralRewards.find({ user: email, role: "referrer", recordedAt: { $gte: since } }).sort({ recordedAt: -1 }).toArray(),
      kycIdentities.findOne({ email }),
    ]);

    const notifications = [];

    for (const reward of recentRewards) {
      notifications.push({
        id: `referral-${reward._id}`,
        type: "referral_converted",
        icon: "🎉",
        title: "Your referral just verified",
        body: `You earned ${reward.amount} $INAYA.`,
        occurredAt: reward.recordedAt,
      });
    }

    if (identity?.verifiedAt && new Date(identity.verifiedAt) >= since) {
      notifications.push({
        id: `kyc-${email}`,
        type: "kyc_verified",
        icon: "✅",
        title: "Identity verification complete",
        body: "You're verified and can now generate or redeem referral codes.",
        occurredAt: identity.verifiedAt,
      });
    }

    notifications.sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));

    return NextResponse.json({ notifications });
  } catch (err) {
    console.error("notifications failed:", err);
    return NextResponse.json({ error: "Could not fetch notifications." }, { status: 500 });
  }
}
