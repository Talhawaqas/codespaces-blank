// app/api/security/report/route.js
//
// POST /api/security/report
// Body: { nodeAddress, indicator, category, confidenceBps, evidenceHash, message, signature, timestamp }
//
// Public but signature-gated (verifySecurityReportAuth) — any Inaya node
// (mobile/desktop background service, or the node-daemon's `report`
// command) can submit a signed observation. Rate-limited per node, deduped
// per node+threat+day. Never blocks on the on-chain confirm call — that
// happens best-effort inside computeThreatConfidence and never throws back
// out to this route.

import { NextResponse } from "next/server";
import { ensureSecurityIndexes, recordSecurityReport } from "../../../../lib/security.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  try {
    const body = await req.json();
    await ensureSecurityIndexes();

    let result;
    try {
      result = await recordSecurityReport(body);
    } catch (validationErr) {
      return NextResponse.json({ error: validationErr.message }, { status: 400 });
    }

    return NextResponse.json({ recorded: true, ...result });
  } catch (err) {
    console.error("security/report POST failed:", err);
    return NextResponse.json({ error: "Could not record report." }, { status: 500 });
  }
}
