// app/api/watcher/qualify/route.js
//
// POST /api/watcher/qualify
// Body: { walletAddress, method: "upload"|"social", qualifyingRef, message, signature, timestamp }
//
// Starts a 24-hour Watcher session — the recurring qualifying action a
// wallet repeats every cycle. method:"upload" is verified against a real
// on-chain transaction receipt (see watcherPioneer.js's
// verifyUploadTxSucceeded); method:"social" is self-attested but still
// wallet-signed. Both paths are gated by a database-enforced one-active-
// session-per-wallet invariant (watcherPioneer.js's startSession), so this
// route can't be spammed into stacking rewards.

import { NextResponse } from "next/server";
import {
  ensureWatcherIndexes,
  verifyWatcherAuth,
  startSession,
  normalizeWallet,
} from "../../../../lib/watcherPioneer.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  try {
    const { walletAddress, method, qualifyingRef, message, signature, timestamp } = await req.json();
    const wallet = normalizeWallet(walletAddress);
    if (!wallet) {
      return NextResponse.json({ error: "walletAddress is required." }, { status: 400 });
    }
    if (method !== "upload" && method !== "social") {
      return NextResponse.json({ error: 'method must be "upload" or "social".' }, { status: 400 });
    }

    try {
      verifyWatcherAuth({
        action: method === "upload" ? "qualify_upload" : "qualify_social",
        extra: { qualifyingRef: qualifyingRef || "" },
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
      const session = await startSession({ walletAddress: wallet, qualifyingMethod: method, qualifyingRef });
      return NextResponse.json({
        started: true,
        startedAt: session.startedAt,
        expiresAt: session.expiresAt,
      });
    } catch (sessionErr) {
      return NextResponse.json(
        { error: sessionErr.message, activeSession: sessionErr.activeSession ? { expiresAt: sessionErr.activeSession.expiresAt } : undefined },
        { status: 409 }
      );
    }
  } catch (err) {
    console.error("watcher/qualify failed:", err);
    return NextResponse.json({ error: "Could not start a Watcher session. Please try again." }, { status: 500 });
  }
}
