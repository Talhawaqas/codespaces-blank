// app/api/orgs/step-up/route.js -- POST { orgId, code }: confirm a fresh authenticator code to open a short step-up window for rules that require stronger authentication.
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { grantStepUp } from "../../../../lib/stepup.js";
import { slidingWindowCheck } from "../../../../lib/rateLimit.js";
export const dynamic = "force-dynamic";
export async function POST(req) {
  try {
    let body = {}; try { body = await req.json(); } catch { /* empty */ }
    if (!body.orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes(); const auth = await requireMembership(req, body.orgId); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const rl = await slidingWindowCheck({ action: "step-up", key: auth.session.email, max: 20, windowMs: 3600_000 }); if (!rl.allowed) return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
    return NextResponse.json(await grantStepUp({ email: auth.session.email, code: body.code }), { headers: { "Cache-Control": "no-store" } });
  } catch (e) { if (e?.code && e?.status) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status }); console.error("step-up failed:", e?.name); return NextResponse.json({ error: "Something went wrong." }, { status: 500 }); }
}
