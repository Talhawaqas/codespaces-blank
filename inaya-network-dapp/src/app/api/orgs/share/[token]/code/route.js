// app/api/orgs/share/[token]/code/route.js -- PUBLIC. POST { email } -> emails a one-time code for a domain-restricted link.
// The answer is the same whether or not the address is eligible.
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
import { requestShareCode } from "../../../../../../lib/sharing/shares.js";
export const dynamic = "force-dynamic";
export async function POST(req, { params }) {
  try {
    const { token } = await params; await ensureOrgIndexes();
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    return json(await requestShareCode({ token, email: body.email, ip: getClientIp(req) }));
  } catch (err) { return fail(err); }
}
