// app/api/watcher/enroll/route.js
//
// POST /api/watcher/enroll
// Body: { walletAddress, followedX, joinedTelegram, message, signature, timestamp }
//
// One-time enrollment into the testnet-only Watcher Pioneer Program — capped
// at 2,500 wallets, one per wallet. Requires a wallet signature over the
// exact attestation claim (see watcherPioneer.js's buildWatcherMessage), so
// "I followed X and joined Telegram" is at least non-repudiably tied to the
// wallet, not just an unauthenticated POST body.

import { NextResponse } from "next/server";
import {
  ensureWatcherIndexes,
  verifyWatcherAuth,
  enrollWallet,
  normalizeWallet,
} from "../../../../lib/watcherPioneer.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  try {
    const { walletAddress, followedX, joinedTelegram, message, signature, timestamp } = await req.json();
    const wallet = normalizeWallet(walletAddress);
    if (!wallet) {
      return NextResponse.json({ error: "walletAddress is required." }, { status: 400 });
    }

    try {
      verifyWatcherAuth({
        action: "enroll",
        extra: { followedX: !!followedX, joinedTelegram: !!joinedTelegram },
        address: wallet,
        message,
        signature,
        timestamp,
      });
    } catch (authErr) {
      return NextResponse.json({ error: authErr.message }, { status: 400 });
    }

    await ensureWatcherIndexes();

    try {
      const { pioneer, alreadyEnrolled } = await enrollWallet({ walletAddress: wallet, followedX, joinedTelegram });
      return NextResponse.json({
        alreadyEnrolled,
        totalPoints: pioneer.totalPoints,
        enrolledAt: pioneer.enrolledAt,
      });
    } catch (programErr) {
      return NextResponse.json({ error: programErr.message }, { status: 409 });
    }
  } catch (err) {
    console.error("watcher/enroll failed:", err);
    return NextResponse.json({ error: "Could not enroll. Please try again." }, { status: 500 });
  }
}
