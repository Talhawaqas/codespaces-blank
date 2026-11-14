// app/api/book/manage/[token]/route.js -- PUBLIC: the customer's own appointment, from the link in their email.
//   GET  ?slots=1&from&to      appointment (+ free slots for rescheduling)
//   POST { action: "confirm" | "cancel" | "reschedule", start?, reason? }
// The token is single-purpose and rotates when the appointment is moved, so an old email link stops working.
import { NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "../../../../../lib/rateLimit.js";
import * as A from "../../../../../lib/engagement/appointments.js";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
const out = (r, ok = 200) => (r?.error ? json({ error: r.error }, r.status || 400) : json(r, ok));

export async function GET(req, ctx) {
  try {
    const { token } = await ctx.params;
    try { await checkRateLimit({ action: "book:manage", key: getClientIp(req) || "unknown", max: 200, windowMs: 3600000 }); } catch { return json({ error: "Too many requests." }, 429); }
    const q = Object.fromEntries(new URL(req.url).searchParams.entries());
    const view = await A.customerView(token);
    if (view.error || q.slots !== "1") return out(view);
    const slots = await A.customerSlots({ token, from: q.from, to: q.to });
    return out(slots.error ? slots : { ...view, slots: slots.slots });
  } catch (err) {
    console.error("manage booking GET failed:", err?.message);
    return json({ error: "Something went wrong." }, 500);
  }
}

export async function POST(req, ctx) {
  try {
    const { token } = await ctx.params;
    try { await checkRateLimit({ action: "book:manage:act", key: getClientIp(req) || "unknown", max: 30, windowMs: 3600000 }); } catch { return json({ error: "Too many requests." }, 429); }
    let body = {}; try { body = await req.json(); } catch { return json({ error: "Body must be JSON." }, 400); }
    const r = await A.customerAction({ token, action: body.action, start: body.start, reason: body.reason });
    if (r.error) return out(r);
    return json({ appointment: r.appointment, newToken: r.manageToken || null, alreadyConfirmed: !!r.alreadyConfirmed });
  } catch (err) {
    console.error("manage booking POST failed:", err?.message);
    return json({ error: "Something went wrong." }, 500);
  }
}
