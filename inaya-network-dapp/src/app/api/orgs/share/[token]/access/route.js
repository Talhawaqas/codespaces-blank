// app/api/orgs/share/[token]/access/route.js -- PUBLIC. POST { password?, email?, code?, deviceId? } -> opens a Sharing 2.0 link.
// The password travels in the body (never in the URL), is checked with scrypt, and wrong guesses lock the link. Returns a short-lived
// access session for the viewer; never a storage pointer.
import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../../lib/orgs.js";
import { getClientIp } from "../../../../../../lib/rateLimit.js";
import { ShareError } from "../../../../../../lib/sharing/shares.js";
const json = (data, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
const fail = (err) => {
  if (err instanceof ShareError) return json({ error: err.message, ...(err.needs ? { needs: err.needs } : {}), ...(err.legacy ? { legacy: true } : {}) }, err.status);
  console.error("share public route failed:", err?.name, String(err?.message || "").slice(0, 200));
  return json({ error: "Something went wrong. Please try again." }, 500);
};
import { openShare } from "../../../../../../lib/sharing/shares.js";
export const dynamic = "force-dynamic";
export async function POST(req, { params }) {
  try {
    const { token } = await params; await ensureOrgIndexes();
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    const deviceId = typeof body.deviceId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(body.deviceId) ? body.deviceId : null;
    return json(await openShare({ token, password: body.password, email: body.email, code: body.code, ip: getClientIp(req), deviceId, userAgent: req.headers.get("user-agent") }));
  } catch (err) { return fail(err); }
}
