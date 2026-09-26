// app/api/public/v1/workflows/[id]/run/route.js
//
// POST -- the API trigger. Authorization: Bearer <org API key> (same convention as every public/v1 route: the
// key IS the organization assertion). Only a workflow whose trigger is "API trigger" can be started this way. The
// run executes as the workflow's owner; the engine re-checks the owner's live membership and scopes.
import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../../../lib/orgs.js";
import { requireApiKey } from "../../../../../../../lib/api-keys.js";
import { triggerExternally } from "../../../../../../../lib/workflows/service.js";

export const dynamic = "force-dynamic";

export async function POST(req, ctx) {
  try {
    await ensureOrgIndexes();
    const auth = await requireApiKey(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { id } = await ctx.params;
    let payload = null;
    try { const t = await req.text(); if (t.length > 64 * 1024) return NextResponse.json({ error: "Body too large." }, { status: 413 }); payload = t ? JSON.parse(t) : null; } catch { return NextResponse.json({ error: "Body must be JSON." }, { status: 400 }); }
    const r = await triggerExternally({ orgId: auth.orgId, workflowId: id, kind: "api", payload, idempotencyKey: req.headers.get("idempotency-key") ? `api:${id}:${req.headers.get("idempotency-key")}` : null, identity: { source: "api_key" } });
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.status || 400 });
    return NextResponse.json({ accepted: true, executionId: r.execution.executionId, duplicate: !!r.duplicate }, { status: 202 });
  } catch (err) {
    console.error("public/v1/workflows run failed:", err?.message);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
