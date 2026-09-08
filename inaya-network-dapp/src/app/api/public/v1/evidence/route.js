// app/api/public/v1/evidence/route.js
//
// GET /api/public/v1/evidence?recordType=&recordId= — Authorization: Bearer <apiKey>
//
// Institutional Trust Infrastructure SOW, Phase 4. Same org-binding
// guarantee as audit/verify: orgId always comes from the key, never the
// request. recordType/recordId are required — this is a per-record
// evidence lookup, not an org-wide dump, so a key can only ever pull the
// trail for one record it already knows the id of.

import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../lib/orgs.js";
import { requireApiKey } from "../../../../../lib/api-keys.js";
import { getEvidenceTrail } from "../../../../../lib/evidence.js";

export async function GET(req) {
  try {
    await ensureOrgIndexes();
    const auth = await requireApiKey(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { searchParams } = new URL(req.url);
    const recordType = searchParams.get("recordType");
    const recordId = searchParams.get("recordId");
    if (!recordType || !recordId) return NextResponse.json({ error: "recordType and recordId are required." }, { status: 400 });

    const result = await getEvidenceTrail({ orgId: auth.orgId, recordType, recordId });
    return NextResponse.json(result);
  } catch (err) {
    console.error("public/v1/evidence GET failed:", err);
    return NextResponse.json({ error: "Could not load the evidence trail." }, { status: 500 });
  }
}
