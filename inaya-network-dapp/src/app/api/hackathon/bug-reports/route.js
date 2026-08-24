// app/api/hackathon/bug-reports/route.js
//
// POST /api/hackathon/bug-reports — public, signature-gated. Body:
//   { title, layer, severity, description, stepsToReproduce, evidenceUrl,
//     walletAddress, message, signature, timestamp }
// Anyone can submit; verifyHackathonReportAuth proves the submission really
// came from the wallet it claims. See src/lib/hackathonReports.js for the
// canonical message shape (must match buildHackathonReportMessage() in
// HackathonSection.js exactly).
//
// GET /api/hackathon/bug-reports — admin-only. Full report list for
// triage. Deliberately no public listing anywhere — this is bug data about
// a live financial system, not something to expose before it's fixed.

import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../lib/admin-auth";
import { connectToDatabase } from "../../../../lib/mongodb";
import { verifyHackathonReportAuth, ensureHackathonReportIndexes, createBugReport, listBugReports } from "../../../../lib/hackathonReports";

export const dynamic = "force-dynamic";

export async function GET(req) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const { db } = await connectToDatabase();
    const reports = await listBugReports(db);
    return NextResponse.json({ reports });
  } catch (err) {
    console.error("hackathon/bug-reports GET failed:", err);
    return NextResponse.json({ error: "Could not load reports." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { title, layer, severity, description, stepsToReproduce, evidenceUrl, walletAddress, message, signature, timestamp } = body;

    verifyHackathonReportAuth({ walletAddress, title, layer, severity, message, signature, timestamp });

    const { db } = await connectToDatabase();
    await ensureHackathonReportIndexes(db);
    const report = await createBugReport(db, { title, layer, severity, description, stepsToReproduce, evidenceUrl, walletAddress });

    return NextResponse.json({ report });
  } catch (err) {
    console.error("hackathon/bug-reports POST failed:", err);
    return NextResponse.json({ error: err.message || "Could not submit report." }, { status: 403 });
  }
}
