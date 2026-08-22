// app/api/security/threat/route.js
//
// GET /api/security/threat?indicator=<domain-or-ip>
//
// Public. Resolves a plaintext domain/IP against the current known verdict —
// fast Mongo read, never a live chain call (SOW §9: local decisions don't
// wait for blockchain confirmation).

import { NextResponse } from "next/server";
import { ensureSecurityIndexes, getThreatByIndicator } from "../../../../lib/security.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const indicator = searchParams.get("indicator");
    if (!indicator) {
      return NextResponse.json({ error: "indicator query param is required." }, { status: 400 });
    }

    await ensureSecurityIndexes();
    const threat = await getThreatByIndicator(indicator);
    return NextResponse.json(threat);
  } catch (err) {
    console.error("security/threat GET failed:", err);
    return NextResponse.json({ error: "Could not resolve threat." }, { status: 500 });
  }
}
