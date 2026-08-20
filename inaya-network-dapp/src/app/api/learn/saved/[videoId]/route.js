// app/api/learn/saved/[videoId]/route.js
//
// DELETE /api/learn/saved/:videoId?walletAddress=0x... — unsave a video.

import { NextResponse } from "next/server";
import { ensureLearnIndexes, getLearnCollections, normalizeWallet } from "../../../../../lib/learn.js";

export const dynamic = "force-dynamic";

export async function DELETE(req, { params }) {
  try {
    const { videoId } = params;
    const { searchParams } = new URL(req.url);
    const walletAddress = normalizeWallet(searchParams.get("walletAddress") || "");

    if (!walletAddress) {
      return NextResponse.json({ error: "walletAddress is required." }, { status: 400 });
    }
    if (!videoId) {
      return NextResponse.json({ error: "videoId is required." }, { status: 400 });
    }

    await ensureLearnIndexes();
    const { saved } = await getLearnCollections();
    await saved.deleteOne({ walletAddress, videoId });

    return NextResponse.json({ removed: true });
  } catch (err) {
    console.error("learn/saved DELETE failed:", err);
    return NextResponse.json({ error: "Could not remove this saved video." }, { status: 500 });
  }
}
