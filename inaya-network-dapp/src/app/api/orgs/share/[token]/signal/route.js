// POST /api/orgs/share/[token]/signal { type }  (x-share-session header) -- viewer signals from a Secure Sharing 2.0 viewer session. Public by design.
import { NextResponse } from "next/server";
import { recordShareSignal, ShareError } from "../../../../../../lib/sharing/shares.js";
import { getClientIp } from "../../../../../../lib/rateLimit.js";
export const dynamic = "force-dynamic";
export async function POST(req, { params }) {
  try {
    const { token } = await params; let body = {}; try { body = await req.json(); } catch { body = {}; }
    const r = await recordShareSignal({ token, sessionToken: req.headers.get("x-share-session"), type: body.type, ip: getClientIp(req) });
    return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof ShareError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
