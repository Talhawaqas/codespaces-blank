// SCIM 2.0 server (Identity Integration SOW section 19). Bearer: an identity service credential with the identity:scim scope, bound to ONE
// SCIM provider (which fixes the organization and tenant). See src/lib/identity/scim.js for what is and is not supported.
import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../lib/orgs.js";
import { authenticateCredential } from "../../../../../lib/identity/credentials.js";
import { handleScim } from "../../../../../lib/identity/scim.js";
import { ensureIdentityIndexes } from "../../../../../lib/identity/db.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const MAX_JSON = 1024 * 1024;
const CT = "application/scim+json";
const out = (body, status = 200, extra = {}) => new NextResponse(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": CT, "Cache-Control": "no-store", ...extra } });
const scimErr = (status, detail) => out({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: String(status), detail }, status);

async function handle(req, ctx) {
  try {
    const { path = [] } = await ctx.params;
    const auth = await authenticateCredential(req, { scope: "identity:scim" });
    if (auth.error) return scimErr(auth.status, auth.error);
    if (Number(req.headers.get("content-length") || 0) > MAX_JSON) return scimErr(413, "Request body is too large.");
    let body = {};
    if (req.method !== "GET" && req.method !== "DELETE") {
      try { const t = await req.text(); if (t.length > MAX_JSON) return scimErr(413, "Request body is too large."); body = t ? JSON.parse(t) : {}; } catch { return scimErr(400, "Request body must be valid JSON."); }
    }
    await ensureOrgIndexes(); await ensureIdentityIndexes();
    const url = new URL(req.url);
    const base = `${url.origin}/api/scim/v2`;
    const r = await handleScim({ method: req.method, path, query: url.searchParams, body, ctx: auth.ctx, base });
    return out(r.body, r.status, r.headers || {});
  } catch (err) { console.error(`scim ${req.method} ${req.url} failed:`, err?.message || err); return scimErr(500, "Something went wrong."); }
}
export const GET = handle; export const POST = handle; export const PUT = handle; export const PATCH = handle; export const DELETE = handle;
