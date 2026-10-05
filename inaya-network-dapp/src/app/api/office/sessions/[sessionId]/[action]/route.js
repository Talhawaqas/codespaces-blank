// app/api/office/sessions/[sessionId]/[action]/route.js -- what the desktop helper calls while a person edits in Word, Excel or PowerPoint. No cookie: the short-lived edit
// token (Authorization: Bearer ied_...) authorizes exactly this one session and nothing else.
//   POST renew { leaseMinutes? }      POST finish { newDocumentId }      POST abort      GET content    (the encrypted-content pointers of the file under edit)
import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../../lib/orgs.js";
import { slidingWindowCheck } from "../../../../../../lib/rateLimit.js";
import * as O from "../../../../../../lib/integrations/office.js";
export const dynamic = "force-dynamic";
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

async function handle(req, ctx) {
  try {
    const { sessionId, action } = await ctx.params; const auth = req.headers.get("authorization") || ""; const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    let body = {}; if (req.method === "POST") { try { body = await req.json(); } catch { body = {}; } }
    await ensureOrgIndexes(); const rl = await slidingWindowCheck({ action: "office:session", key: String(sessionId).slice(0, 24), max: 600, windowMs: 3600_000 }); if (!rl.allowed) return json({ error: "Too many requests." }, 429);
    if (action === "renew" && req.method === "POST") return json(await O.renewSession({ sessionId, token, leaseMinutes: body.leaseMinutes }));
    if (action === "finish" && req.method === "POST") return json(await O.finishSession({ sessionId, token, newDocumentId: body.newDocumentId }));
    if (action === "abort" && req.method === "POST") return json(await O.abortSession({ sessionId, token }));
    if (action === "content" && req.method === "GET") return json(await O.sessionContent({ sessionId, token }));
    return json({ error: "Not found." }, 404);
  } catch (err) {
    if (err instanceof O.OfficeError || typeof err?.status === "number") return json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
    console.error("office session failed:", err?.name, String(err?.message || "").slice(0, 200)); return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
export const GET = handle, POST = handle;
