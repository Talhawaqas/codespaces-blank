// app/api/learn/saved/route.js
//
// GET  /api/learn/saved?walletAddress=0x... — list a wallet's saved videos.
// POST /api/learn/saved — save (upsert) a video for a wallet.
//
// No session/auth system for Inaya Learn — walletAddress is a client-
// provided identifier, same trust model already used by referrals.js/
// watcherPioneer.js's non-signature-verified paths. Anonymous (no wallet)
// saves never reach this backend; the mobile app is the source of truth
// for those via AsyncStorage.

import { NextResponse } from "next/server";
import { ensureLearnIndexes, getLearnCollections, validateSaveInput, normalizeWallet } from "../../../../lib/learn.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const walletAddress = normalizeWallet(searchParams.get("walletAddress") || "");
    if (!walletAddress) {
      return NextResponse.json({ error: "walletAddress is required." }, { status: 400 });
    }

    await ensureLearnIndexes();
    const { saved } = await getLearnCollections();
    const items = await saved.find({ walletAddress }).sort({ savedAt: -1 }).toArray();

    return NextResponse.json({ items });
  } catch (err) {
    console.error("learn/saved GET failed:", err);
    return NextResponse.json({ error: "Could not load saved videos." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();

    let clean;
    try {
      clean = validateSaveInput(body);
    } catch (validationErr) {
      return NextResponse.json({ error: validationErr.message }, { status: 400 });
    }

    await ensureLearnIndexes();
    const { saved } = await getLearnCollections();
    const now = new Date();

    await saved.updateOne(
      { walletAddress: clean.walletAddress, videoId: clean.videoId },
      { $set: { ...clean, savedAt: now } },
      { upsert: true }
    );

    return NextResponse.json({ saved: true });
  } catch (err) {
    console.error("learn/saved POST failed:", err);
    return NextResponse.json({ error: "Could not save this video." }, { status: 500 });
  }
}
