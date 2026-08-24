// app/api/hackathon/status/route.js
//
// GET /api/hackathon/status
//
// Public, no auth -- this is what powers the dApp's "Hackathon" tab for
// every visitor. Returns the fixed prize pool + the current winners list
// (place, wallet, amount, claimed), pulled from the same hackathon_winners
// collection the admin fills in via POST /api/hackathon/winners.

import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../../lib/mongodb";
import { ensureHackathonIndexes, getWinners, HACKATHON_TOTAL_POOL, PRIZE_SLOTS } from "../../../../lib/hackathon";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { db } = await connectToDatabase();
    await ensureHackathonIndexes(db);
    const winners = await getWinners(db);
    return NextResponse.json({ totalPool: HACKATHON_TOTAL_POOL, prizeSlots: PRIZE_SLOTS, winners });
  } catch (err) {
    console.error("hackathon/status GET failed:", err);
    return NextResponse.json({ error: "Could not load hackathon status." }, { status: 500 });
  }
}
