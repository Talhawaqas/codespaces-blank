// Visitor-side Data Room 2.0 routes. Deliberately outside src/app/api/orgs/* and requireMembership(): the caller is an external visitor whose
// identity is the room session cookie set when they opened their emailed link. Nothing here takes an orgId or roomId from the client.
import { NextResponse } from "next/server";
import { VdrError } from "../../../../lib/dataroom/vdr2.js";
import { getClientIp } from "../../../../lib/rateLimit.js";
export const SESSION_COOKIE = "inaya_data_room_session";
export const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });
export async function visitor(req, handler) {
  try {
    const token = req.cookies.get(SESSION_COOKIE)?.value; if (!token) return json({ error: "Your session is invalid or has expired." }, 401);
    let body = {}; if (req.method !== "GET") { try { body = await req.json(); } catch { body = {}; } }
    return json(await handler({ token, body, query: Object.fromEntries(new URL(req.url).searchParams.entries()), ip: getClientIp(req) }));
  } catch (err) {
    if (err instanceof VdrError) return json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
    console.error("data-room-access/v2 failed:", err?.name, String(err?.message || "").slice(0, 200)); return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
