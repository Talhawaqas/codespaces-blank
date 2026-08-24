// app/api/hackathon/my-reports/route.js
//
// GET /api/hackathon/my-reports?walletAddress=0x... — public, no auth.
// Lets a developer see their OWN submission history/status in the dApp
// without needing admin access. Safe to leave unauthenticated: a caller
// can only ever see reports for the exact address they already know and
// pass in, never anyone else's list, and there's no admin-only triage
// data (finalSeverity/triageNotes) worth hiding from the person who filed
// the report in the first place.

import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../../lib/mongodb";
import { listMyBugReports } from "../../../../lib/hackathonReports";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const walletAddress = new URL(req.url).searchParams.get("walletAddress");
    if (!walletAddress) {
      return NextResponse.json({ error: "walletAddress query param is required." }, { status: 400 });
    }
    const { db } = await connectToDatabase();
    const reports = await listMyBugReports(db, walletAddress);
    return NextResponse.json({ reports });
  } catch (err) {
    console.error("hackathon/my-reports GET failed:", err);
    return NextResponse.json({ error: "Could not load your reports." }, { status: 500 });
  }
}
