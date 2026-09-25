// GET /api/orgs/documents-automation/metrics?orgId=&sinceHours=168
//   -> generation/render/storage/evidence/delivery durations, failure and
//      retry counts, page/byte sizes, queue latency (numbers only; never content).
import { NextResponse } from "next/server";
import { authed, fail, respond } from "../_lib.js";
import { summarizeMetrics } from "../../../../../lib/documentAutomation/metrics.js";
import { documentHealthSnapshot } from "../../../../../lib/documentAutomation/briefIntegration.js";
import { canManageOrg } from "../../../../../lib/orgs.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const sp = new URL(req.url).searchParams;
    const orgId = sp.get("orgId");
    const a = await authed(req, orgId);
    if (a.response) return a.response;
    if (!canManageOrg(a.membership)) return respond({ error: "Only an owner or admin can view document metrics.", status: 403 });
    const hours = Math.min(Math.max(Number(sp.get("sinceHours")) || 168, 1), 24 * 90);
    const [metrics, health] = await Promise.all([summarizeMetrics({ orgId, sinceIso: new Date(Date.now() - hours * 3600000).toISOString() }), documentHealthSnapshot({ orgId })]);
    return NextResponse.json({ ...metrics, health });
  } catch (err) { return fail(err, "metrics GET"); }
}
