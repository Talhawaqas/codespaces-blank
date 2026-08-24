// app/api/hackathon/winners/route.js
//
// GET  /api/hackathon/winners — admin view of all 6 prize slots (same data
//      as /api/hackathon/status, just behind auth for the admin dashboard's
//      edit view -- no extra sensitive fields exist beyond what's already
//      public there).
// POST /api/hackathon/winners — Body: { place, walletAddress, projectName }
//      Upserts the winner for one fixed prize slot. This is the "record on
//      backend so rewards can be transferred easily on mainnet" mechanism:
//      fill this in as winners are finalized, well before mainnet, then at
//      launch read this collection to feed configureWinnersBatch() on the
//      deployed InayaHackathonRewards contract.
//
// isAdminAuthenticated-gated, same pattern as api/admin/security/policy.

import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../lib/admin-auth";
import { connectToDatabase } from "../../../../lib/mongodb";
import { ensureHackathonIndexes, getWinners, upsertWinner } from "../../../../lib/hackathon";

export const dynamic = "force-dynamic";

export async function GET(req) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const { db } = await connectToDatabase();
    await ensureHackathonIndexes(db);
    const winners = await getWinners(db);
    return NextResponse.json({ winners });
  } catch (err) {
    console.error("hackathon/winners GET failed:", err);
    return NextResponse.json({ error: "Could not load winners." }, { status: 500 });
  }
}

export async function POST(req) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const { place, walletAddress, projectName } = await req.json();
    const { db } = await connectToDatabase();
    await ensureHackathonIndexes(db);
    const winners = await upsertWinner(db, { place, walletAddress, projectName });
    return NextResponse.json({ winners });
  } catch (err) {
    console.error("hackathon/winners POST failed:", err);
    return NextResponse.json({ error: err.message || "Could not save winner." }, { status: 400 });
  }
}
