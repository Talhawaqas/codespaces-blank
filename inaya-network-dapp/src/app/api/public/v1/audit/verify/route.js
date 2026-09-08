// app/api/public/v1/audit/verify/route.js
//
// GET /api/public/v1/audit/verify — Authorization: Bearer <apiKey>
//
// Institutional Trust Infrastructure SOW, Phase 4. API-key authenticated
// (not cookie-authenticated) — orgId is resolved from the key itself via
// requireApiKey(), never accepted as a request parameter, so a caller can
// never verify a different org's chain than the one their key belongs to.

import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../../lib/orgs.js";
import { requireApiKey } from "../../../../../../lib/api-keys.js";
import { verifyOrgEvidenceIntegrity } from "../../../../../../lib/evidence.js";

export async function GET(req) {
  try {
    await ensureOrgIndexes();
    const auth = await requireApiKey(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await verifyOrgEvidenceIntegrity(auth.orgId);
    return NextResponse.json(result);
  } catch (err) {
    console.error("public/v1/audit/verify GET failed:", err);
    return NextResponse.json({ error: "Could not verify the audit chain." }, { status: 500 });
  }
}
