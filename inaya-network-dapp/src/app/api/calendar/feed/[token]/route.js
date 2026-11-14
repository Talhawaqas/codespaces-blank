// app/api/calendar/feed/[token]/route.js -- PUBLIC private calendar address (ICS) for one staff member's appointments.
// Pasted into Google Calendar ("From URL") or Outlook ("Subscribe from web"); no app verification or paid API needed.
// The token is the secret; a trailing ".ics" is accepted because some calendar apps insist on it.
import { feedIcs } from "../../../../../lib/engagement/feeds.js";
import { checkRateLimit } from "../../../../../lib/rateLimit.js";

export const dynamic = "force-dynamic";

export async function GET(req, ctx) {
  try {
    const { token: raw } = await ctx.params;
    const token = String(raw || "").replace(/\.ics$/i, "");
    try { await checkRateLimit({ action: "calendar:feed", key: token.slice(0, 16), max: 120, windowMs: 3600000 }); } catch { return new Response("Too many requests", { status: 429 }); }
    const body = await feedIcs(token);
    if (!body) return new Response("Not found", { status: 404 });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'inline; filename="appointments.ics"', "Cache-Control": "private, max-age=300", "X-Robots-Tag": "noindex" } });
  } catch (err) {
    console.error("calendar feed failed:", err?.message);
    return new Response("Error", { status: 500 });
  }
}
