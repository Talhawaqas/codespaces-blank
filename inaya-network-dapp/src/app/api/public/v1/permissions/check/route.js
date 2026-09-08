// app/api/public/v1/permissions/check/route.js
//
// GET /api/public/v1/permissions/check?gate=canManageFinance — Authorization: Bearer <apiKey>
//
// Institutional Trust Infrastructure SOW, Phase 4. Wraps orgGates.js
// directly rather than reimplementing any rule. HONESTY NOTE: an API key
// always acts with full organizational authority (the same synthetic
// owner-level membership ai-action-requests.js's cron executor already
// uses for the identical reason — the key IS the org's own credential,
// not a specific member's), so most of these gates will report true for
// any valid key. This endpoint verifies a capability NAME is real and
// currently enabled for the org, not a specific human's personal role —
// a genuinely different, narrower question than the org's own signed-in
// member-permission checks answer.

import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../../lib/orgs.js";
import { requireApiKey } from "../../../../../../lib/api-keys.js";
import * as orgGates from "../../../../../../lib/orgGates.js";

const ALLOWED_GATES = [
  "canManageOrg", "canManageFinance", "canAccessFinance", "canManageHR", "canAccessHR",
  "canManageHealth", "canAccessHealthRecords", "canManageLegal", "canAccessLegalMatters",
  "canManageCompliance", "canAccessCompliance", "canManageAudit", "canAccessAudit",
  "canManageFinancialEntities", "canAccessFinancialEntities", "canManageGovernment", "canAccessGovernment",
];

export async function GET(req) {
  try {
    await ensureOrgIndexes();
    const auth = await requireApiKey(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const gate = new URL(req.url).searchParams.get("gate");
    if (!gate || !ALLOWED_GATES.includes(gate)) {
      return NextResponse.json({ error: `gate is required and must be one of: ${ALLOWED_GATES.join(", ")}.` }, { status: 400 });
    }

    const allowed = orgGates[gate](auth.membership);
    return NextResponse.json({ gate, allowed });
  } catch (err) {
    console.error("public/v1/permissions/check GET failed:", err);
    return NextResponse.json({ error: "Could not check the permission." }, { status: 500 });
  }
}
