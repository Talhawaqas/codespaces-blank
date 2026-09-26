// app/api/workflow-hooks/[workflowId]/route.js
//
// POST -- the webhook trigger. Authenticated by an HMAC-SHA256 signature (per-workflow secret shown once at publish):
//   x-inaya-timestamp: <unix seconds>     x-inaya-signature: hex(HMAC(secret, `${timestamp}.${rawBody}`))
// A request older than 5 minutes, with a bad signature, or replayed (same signature seen before) is refused. The
// run executes as the workflow's owner, whose live membership and scopes are re-checked by the engine.
import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../lib/orgs.js";
import { checkRateLimit, getClientIp } from "../../../../lib/rateLimit.js";
import { verifyWebhook, triggerExternally } from "../../../../lib/workflows/service.js";

export const dynamic = "force-dynamic";
const MAX_BYTES = 64 * 1024;

export async function POST(req, ctx) {
  try {
    const { workflowId } = await ctx.params;
    try { await checkRateLimit({ action: "wf:webhook", key: `${getClientIp(req)}:${workflowId}`, max: 120, windowMs: 15 * 60 * 1000 }); } catch { return NextResponse.json({ error: "Too many requests." }, { status: 429 }); }
    const raw = await req.text();
    if (raw.length > MAX_BYTES) return NextResponse.json({ error: "Body too large." }, { status: 413 });
    await ensureOrgIndexes();
    const v = await verifyWebhook({ workflowId, timestamp: req.headers.get("x-inaya-timestamp"), signature: req.headers.get("x-inaya-signature"), rawBody: raw });
    if (!v.ok) return NextResponse.json({ error: v.status === 404 ? "Not found." : "Request refused." }, { status: v.status || 401 }); // never say why a signature failed
    let payload = null; try { payload = raw ? JSON.parse(raw) : null; } catch { return NextResponse.json({ error: "Body must be JSON." }, { status: 400 }); }
    const r = await triggerExternally({ orgId: String(v.workflow.orgId), workflowId, kind: "webhook", payload, idempotencyKey: `hook:${workflowId}:${req.headers.get("x-inaya-signature")}`, identity: { source: "webhook" } });
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.status || 400 });
    return NextResponse.json({ accepted: true, executionId: r.execution.executionId, duplicate: !!r.duplicate }, { status: 202 });
  } catch (err) {
    console.error("workflow-hooks POST failed:", err?.message);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
