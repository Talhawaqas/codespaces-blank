// app/api/learn/progress/route.js
//
// GET  /api/learn/progress?walletAddress=0x...&status=watching|completed —
//   "My Learning" read-model (continue watching / completed lists).
// POST /api/learn/progress — upsert watch position + status.

import { NextResponse } from "next/server";
import { ensureLearnIndexes, getLearnCollections, validateProgressInput, normalizeWallet, LEARN_STATUSES } from "../../../../lib/learn.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const walletAddress = normalizeWallet(searchParams.get("walletAddress") || "");
    const status = searchParams.get("status");

    if (!walletAddress) {
      return NextResponse.json({ error: "walletAddress is required." }, { status: 400 });
    }
    if (status && !LEARN_STATUSES.includes(status)) {
      return NextResponse.json({ error: `status must be one of: ${LEARN_STATUSES.join(", ")}.` }, { status: 400 });
    }

    await ensureLearnIndexes();
    const { progress } = await getLearnCollections();
    const filter = status ? { walletAddress, status } : { walletAddress };
    const items = await progress.find(filter).sort({ updatedAt: -1 }).toArray();

    return NextResponse.json({ items });
  } catch (err) {
    console.error("learn/progress GET failed:", err);
    return NextResponse.json({ error: "Could not load learning progress." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();

    let clean;
    try {
      clean = validateProgressInput(body);
    } catch (validationErr) {
      return NextResponse.json({ error: validationErr.message }, { status: 400 });
    }

    await ensureLearnIndexes();
    const { progress } = await getLearnCollections();
    const now = new Date();

    await progress.updateOne(
      { walletAddress: clean.walletAddress, videoId: clean.videoId },
      { $set: { ...clean, updatedAt: now }, $setOnInsert: { startedAt: now } },
      { upsert: true }
    );

    return NextResponse.json({ synced: true });
  } catch (err) {
    console.error("learn/progress POST failed:", err);
    return NextResponse.json({ error: "Could not sync progress." }, { status: 500 });
  }
}
