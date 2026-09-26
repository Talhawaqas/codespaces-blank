// src/app/api/orgs/finance/bookkeeper/_lib.js
//
// One wrapper for the AI Bookkeeper API: body limit -> authenticate (session cookie) -> organization scope (the caller's OWN membership,
// never a client-supplied role) -> rate limit -> Idempotency-Key replay protection on writes -> handleBookkeeper (permissions, department
// scope, validation, audit). Responses are no-store; downloads are served as attachments with nosniff.
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, getOrgCollections, toObjectId } from "../../../../../lib/orgs.js";
import { checkRateLimit } from "../../../../../lib/rateLimit.js";
import { handleBookkeeper, MAX_UPLOAD_JSON } from "../../../../../lib/bookkeeper/api.js";
import { ensureBookkeeperIndexes } from "../../../../../lib/bookkeeper/db.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const H = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function bookkeeperRoute(req, ctx) {
  const method = req.method; const mutating = method !== "GET";
  try {
    const { path = [] } = ctx?.params ? await ctx.params : {};
    const url = new URL(req.url); const query = Object.fromEntries(url.searchParams.entries());
    let body = {};
    if (mutating) {
      if (Number(req.headers.get("content-length") || 0) > MAX_UPLOAD_JSON) return NextResponse.json({ error: "Request body is too large." }, { status: 413, headers: H });
      try { const t = await req.text(); if (t.length > MAX_UPLOAD_JSON) return NextResponse.json({ error: "Request body is too large." }, { status: 413, headers: H }); body = t ? JSON.parse(t) : {}; if (!body || typeof body !== "object" || Array.isArray(body)) body = {}; }
      catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400, headers: H }); }
    }
    const orgId = query.orgId || body.orgId;
    if (!orgId || typeof orgId !== "string" || orgId.length > 40) return NextResponse.json({ error: "orgId is required." }, { status: 400, headers: H });
    await ensureOrgIndexes(); await ensureBookkeeperIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status, headers: H });
    const email = auth.session.email;
    try { await checkRateLimit({ action: `bk:${mutating ? "w" : "r"}`, key: `${orgId}:${email}`, max: mutating ? 120 : 600, windowMs: 60000 }); }
    catch { return NextResponse.json({ error: "Too many requests. Please wait a moment.", reasonCode: "RATE_LIMITED" }, { status: 429, headers: H }); }

    const idem = mutating ? req.headers.get("idempotency-key") : null; let requests = null; const fingerprint = `${method} ${url.pathname}`;
    if (idem) {
      if (idem.length < 8 || idem.length > 100) return NextResponse.json({ error: "Idempotency-Key must be 8-100 characters." }, { status: 400, headers: H });
      requests = (await getOrgCollections()).workflowRequests;
      const prev = await requests.findOne({ orgId: toObjectId(orgId), key: `bk:${idem}` });
      if (prev) { if (prev.fingerprint !== fingerprint || prev.email !== email) return NextResponse.json({ error: "This Idempotency-Key was already used for a different request." }, { status: 409, headers: H }); return NextResponse.json({ ...prev.response, replayed: true }, { status: prev.status, headers: H }); }
    }
    const result = await handleBookkeeper({ method, path, query, body, orgId, membership: auth.membership, email });
    if (result?.raw) return new NextResponse(result.raw.body, { status: 200, headers: { ...H, "Content-Type": result.raw.contentType, "Content-Disposition": `attachment; filename="${String(result.raw.filename).replace(/["\\\r\n]/g, "_")}"` } });
    let status = 200; let out = result;
    if (result?.error) { const { error, status: st, ...rest } = result; const safe = {}; for (const k of ["errors", "reasonCode", "columns", "invalid", "checklist"]) if (rest[k] !== undefined) safe[k] = rest[k]; status = st || 400; out = { error, ...safe }; }
    else if (method === "POST" && (result?.source || result?.rule) && !result.replayed) status = 201;
    if (requests && status < 500) await requests.insertOne({ orgId: toObjectId(orgId), key: `bk:${idem}`, fingerprint, email, status, response: JSON.parse(JSON.stringify(out)), createdAt: new Date() }).catch(() => {});
    return NextResponse.json(out, { status, headers: H });
  } catch (err) {
    console.error(`bookkeeper ${req.method} ${req.url} failed:`, err?.message || err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500, headers: H });
  }
}
