// app/api/book/[slug]/[[...path]]/route.js -- PUBLIC customer self-service booking portal API (no sign-in).
//   GET  /api/book/{slug}                       page, appointment types (staff emails never exposed)
//   GET  /api/book/{slug}/slots?typeId&from&to&staffKey
//   POST /api/book/{slug}/start                 funnel counter (visitor opened the details form)
//   POST /api/book/{slug}/book { typeId, start, staffKey?, name, email, phone?, note?, answers?, timeZone, consentMarketing? }
//   POST /api/book/{slug}/enquiry { name, email, phone?, company?, message, consentMarketing? }
// Rate limited per IP; honeypot field `website` must be empty.
import { NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "../../../../../lib/rateLimit.js";
import * as B from "../../../../../lib/engagement/booking.js";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });
const out = (r, ok = 200) => (r?.error ? json({ error: r.error }, r.status || 400) : json(r, ok));
const limited = async (action, key, max, windowMs) => { try { await checkRateLimit({ action, key, max, windowMs }); return null; } catch { return json({ error: "Too many requests. Please wait a few minutes and try again." }, 429); } };

async function handle(req, ctx) {
  try {
    const { slug, path = [] } = await ctx.params; const [a] = path; const method = req.method;
    const q = Object.fromEntries(new URL(req.url).searchParams.entries());
    const ip = getClientIp(req) || "unknown";
    if (method === "GET" && !a) { const l = await limited("book:page", ip, 300, 3600000); if (l) return l; return out(await B.publicPage(slug)); }
    if (method === "GET" && a === "slots") { const l = await limited("book:slots", ip, 600, 3600000); if (l) return l; return out(await B.publicSlots(slug, { typeId: q.typeId, from: q.from, to: q.to, staffKey: q.staffKey })); }
    if (method !== "POST") return json({ error: "Not found." }, 404);
    let body = {}; try { body = await req.json(); } catch { return json({ error: "Body must be JSON." }, 400); }
    if (body.website) return json({ ok: true }); // honeypot: silently drop bots
    if (a === "start") return out(await B.publicStart(slug));
    if (a === "book") {
      const l = (await limited("book:submit:ip", ip, 20, 3600000)) || (await limited("book:submit:email", String(body.email || "").toLowerCase(), 6, 3600000)); if (l) return l;
      return out(await B.publicBook(slug, body), 201);
    }
    if (a === "enquiry") {
      const l = (await limited("book:enquiry:ip", ip, 10, 3600000)) || (await limited("book:enquiry:email", String(body.email || "").toLowerCase(), 3, 3600000)); if (l) return l;
      return out(await B.publicEnquiry(slug, body), 201);
    }
    return json({ error: "Not found." }, 404);
  } catch (err) {
    console.error("public booking route failed:", err?.message);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}

export const GET = handle; export const POST = handle;
