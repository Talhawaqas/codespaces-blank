// app/api/m/unsubscribe/[token]/route.js -- PUBLIC unsubscribe.
//   POST  RFC 8058 one-click (mail apps send "List-Unsubscribe=One-Click") and the button on /u/{token}
//   GET   sends people to the confirmation page (a GET must never unsubscribe: link scanners prefetch URLs)
import { NextResponse } from "next/server";
import { unsubscribeByToken } from "../../../../../lib/engagement/suppression.js";

export const dynamic = "force-dynamic";

export async function POST(_req, ctx) {
  try {
    const { token } = await ctx.params;
    const r = await unsubscribeByToken(token, { source: "one-click" });
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.status || 400 });
    return NextResponse.json({ ok: true, businessName: r.businessName });
  } catch (err) {
    console.error("unsubscribe failed:", err?.message);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

export async function GET(req, ctx) {
  const { token } = await ctx.params;
  return NextResponse.redirect(new URL(`/u/${encodeURIComponent(token)}`, req.url), 302);
}
