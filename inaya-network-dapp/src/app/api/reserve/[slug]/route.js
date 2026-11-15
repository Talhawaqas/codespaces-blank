// app/api/reserve/[slug]/route.js -- PUBLIC: a restaurant location's online reservation page (Hospitality SOW 8.8).
//   GET                                 business, location, hours, public policy
//   GET ?date=YYYY-MM-DD&partySize=N    free times for that day
//   POST { name, email, phone, partySize, date, time, occasion, note, marketingConsent, idempotencyKey, website }
// Narrow by design: it can only read what a guest needs and create one reservation. Rate-limited per IP and per
// email; `website` is a honeypot field; a repeated idempotencyKey returns the first booking instead of a second.
import { NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "../../../../lib/rateLimit.js";
import * as RES from "../../../../lib/hospitality/reservations.js";
import { ensureHospitalityIndexes } from "../../../../lib/hospitality/store.js";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" } });
const out = (r, ok = 200) => (r?.error ? json({ error: r.error, ...(r.alternatives ? { alternatives: r.alternatives } : {}) }, r.status || 400) : json(r, ok));
const limited = async (action, key, max, windowMs) => { try { await checkRateLimit({ action, key, max, windowMs }); return false; } catch { return true; } };

export async function GET(req, ctx) {
  try {
    const { slug } = await ctx.params;
    if (await limited("reserve:view", getClientIp(req) || "unknown", 240, 3600000)) return json({ error: "Too many requests. Please try again later." }, 429);
    const q = Object.fromEntries(new URL(req.url).searchParams.entries());
    if (q.date) return out(await RES.publicSlots(slug, q.date, q.partySize));
    return out(await RES.publicInfo(slug));
  } catch (err) { console.error("reserve GET failed:", err?.message); return json({ error: "Something went wrong." }, 500); }
}

export async function POST(req, ctx) {
  try {
    const { slug } = await ctx.params;
    const ip = getClientIp(req) || "unknown";
    if (await limited("reserve:book:ip", ip, 8, 3600000)) return json({ error: "Too many booking attempts. Please try again later or call the restaurant." }, 429);
    const raw = await req.text();
    if (raw.length > 8000) return json({ error: "Request too large." }, 413);
    let body = {}; try { body = JSON.parse(raw); } catch { return json({ error: "Body must be JSON." }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Body must be JSON." }, 400);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 200) : "";
    if (email && (await limited("reserve:book:email", email, 4, 3600000))) return json({ error: "Too many booking attempts for this email address. Please try again later." }, 429);
    await ensureHospitalityIndexes();
    return out(await RES.publicBook(slug, body), 201);
  } catch (err) { console.error("reserve POST failed:", err?.message); return json({ error: "Something went wrong." }, 500); }
}
