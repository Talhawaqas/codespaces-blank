// app/api/orgs/share/[token]/content/route.js -- PUBLIC (needs the access session). GET ?part=alpha|beta, header x-share-session.
// Serves one CIPHERTEXT shard through Inaya so revocation, expiry, IP range and download limits apply to every fetch.
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
import { readShareContent } from "../../../../../../lib/sharing/shares.js";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
export async function GET(req, { params }) {
  try {
    const { token } = await params; await ensureOrgIndexes();
    const part = new URL(req.url).searchParams.get("part");
    return json(await readShareContent({ token, sessionToken: req.headers.get("x-share-session"), part, ip: getClientIp(req) }));
  } catch (err) { return fail(err); }
}
