// app/api/reserve/manage/[token]/route.js -- PUBLIC: a guest's own reservation, from the link in their confirmation email.
//   GET                                            the reservation (guest-safe fields only)
//   POST { action: "cancel", reason }              cancel within the restaurant's notice period
//   POST { action: "feedback", rating, comment }   after the visit
// Only a SHA-256 hash of the token is stored; links stop working a week after the visit.
import { NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "../../../../../lib/rateLimit.js";
import * as RES from "../../../../../lib/hospitality/reservations.js";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" } });
const out = (r) => (r?.error ? json({ error: r.error }, r.status || 400) : json(r));
const limited = async (action, key, max) => { try { await checkRateLimit({ action, key, max, windowMs: 3600000 }); return false; } catch { return true; } };

export async function GET(req, ctx) {
  try {
    const { token } = await ctx.params;
    if (await limited("reserve:manage", getClientIp(req) || "unknown", 120)) return json({ error: "Too many requests." }, 429);
    return out(await RES.publicManageView(token));
  } catch (err) { console.error("reserve manage GET failed:", err?.message); return json({ error: "Something went wrong." }, 500); }
}

export async function POST(req, ctx) {
  try {
    const { token } = await ctx.params;
    if (await limited("reserve:manage:act", getClientIp(req) || "unknown", 20)) return json({ error: "Too many requests." }, 429);
    let body = {}; try { body = await req.json(); } catch { return json({ error: "Body must be JSON." }, 400); }
    return out(await RES.publicManageAction(token, body || {}));
  } catch (err) { console.error("reserve manage POST failed:", err?.message); return json({ error: "Something went wrong." }, 500); }
}
