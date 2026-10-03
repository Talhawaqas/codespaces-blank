// GET /api/cron/proof-spotcheck -- every 30 minutes (vercel.json). Audits a few wallet files per run:
// re-fetches their shards from the providers and checks they still hash to the Merkle root
// registered on-chain (see lib/proofOfStorage/spotcheck.js). Bounded per run so it stays well inside
// a serverless execution window; the least recently audited files go first, so everything is
// covered over time.

import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { runProofSpotChecks } from "../../../../lib/proofOfStorage/spotcheck.js";

export const maxDuration = 60;

export async function GET(request) {
  if (!isAuthorizedCron(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runProofSpotChecks({ limit: 3 });
    console.log("[proof-spotcheck]", JSON.stringify({ checked: result.checked, summary: result.summary }));
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error("cron/proof-spotcheck failed:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
