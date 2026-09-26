// src/app/api/integrations/identity/_lib.js
//
// One wrapper for the identity API. In this order: body limit -> authenticate (service credential OR signed-in session) -> organization scope
// (a session is checked against the caller's own membership or verified MSP delegation; a credential is bound to its organization or, for an MSP
// credential, to a customer with an active link) -> rate limit -> Idempotency-Key replay protection -> handleIdentityApi (capabilities, validation,
// audit). The route never trusts an organization id from the client.
import { NextResponse } from "next/server";
import { ensureOrgIndexes, getRawSessionToken, getSession, getMembership, getOrgCollections, toObjectId } from "../../../../lib/orgs.js";
import { checkRateLimit } from "../../../../lib/rateLimit.js";
import { canManageOrg } from "../../../../lib/orgGates.js";
import { authenticateCredential } from "../../../../lib/identity/credentials.js";
import { resolveMspAccess } from "../../../../lib/identity/msp.js";
import { handleIdentityApi, capsForHuman, capsForMsp, capsForScopes } from "../../../../lib/identity/api.js";
import { ensureIdentityIndexes } from "../../../../lib/identity/db.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const MAX_JSON_BYTES = 1024 * 1024;
const H = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

async function readBody(req) {
  if (Number(req.headers.get("content-length") || 0) > MAX_JSON_BYTES) return { error: "Request body is too large.", status: 413 };
  try { const t = await req.text(); if (t.length > MAX_JSON_BYTES) return { error: "Request body is too large.", status: 413 }; const b = t ? JSON.parse(t) : {}; return { body: b && typeof b === "object" && !Array.isArray(b) ? b : {} }; }
  catch { return { error: "Request body must be valid JSON.", status: 400 }; }
}

export async function identityRoute(req, ctx) {
  const method = req.method; const mutating = method !== "GET" && method !== "HEAD";
  try {
    const { path = [] } = ctx?.params ? await ctx.params : {};
    const url = new URL(req.url); const query = Object.fromEntries(url.searchParams.entries());
    let body = {};
    if (mutating) { const p = await readBody(req); if (p.error) return NextResponse.json({ error: p.error }, { status: p.status, headers: H }); body = p.body; }
    await ensureOrgIndexes(); await ensureIdentityIndexes();
    const requested = req.headers.get("x-inaya-organization") || query.orgId || body.orgId || null;
    let A = null;
    if ((req.headers.get("authorization") || "").startsWith("Bearer ")) {
      const r = await authenticateCredential(req, { requestedOrgId: requested });
      if (r.error) return NextResponse.json({ error: r.error, ...(r.reasonCode ? { reasonCode: r.reasonCode } : {}) }, { status: r.status, headers: H });
      A = { orgId: r.ctx.orgId, kind: "service", email: null, label: r.ctx.actor, caps: capsForScopes(r.ctx.scopes), humanAdmin: false, membership: null, providerId: r.ctx.providerId, credentialId: r.ctx.credentialId };
    } else {
      if (!requested || typeof requested !== "string" || requested.length > 40) return NextResponse.json({ error: "orgId is required." }, { status: 400, headers: H });
      const session = await getSession(getRawSessionToken(req));
      if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401, headers: H });
      let membership = null;
      try { membership = await getMembership(requested, session.email); } catch { return NextResponse.json({ error: "Invalid organization id." }, { status: 400, headers: H }); }
      if (membership && canManageOrg(membership)) A = { orgId: requested, kind: "human", email: session.email, label: session.email, caps: capsForHuman(membership), humanAdmin: true, membership };
      else {
        const msp = await resolveMspAccess({ email: session.email, customerOrgId: requested });
        if (!msp) return NextResponse.json({ error: membership ? "Only an owner or admin can use the identity API." : "You don't have access to this organization." }, { status: 403, headers: H });
        A = { orgId: requested, kind: "msp", email: session.email, label: `${session.email} (MSP ${msp.role})`, caps: capsForMsp(msp.role), humanAdmin: false, membership: { role: "owner", synthetic: true, mspRole: msp.role }, mspRole: msp.role };
      }
    }
    try { await checkRateLimit({ action: `identity-api:${mutating ? "w" : "r"}`, key: `${A.orgId}:${A.credentialId || A.email}`, max: mutating ? 120 : 600, windowMs: 60000 }); }
    catch { return NextResponse.json({ error: "Too many requests. Slow down and retry shortly.", reasonCode: "RATE_LIMITED" }, { status: 429, headers: H }); }

    const idem = mutating ? req.headers.get("idempotency-key") : null; let requests = null; const fingerprint = `${method} ${url.pathname}`;
    if (idem) {
      if (idem.length < 8 || idem.length > 100) return NextResponse.json({ error: "Idempotency-Key must be 8-100 characters." }, { status: 400, headers: H });
      requests = (await getOrgCollections()).workflowRequests;
      const prev = await requests.findOne({ orgId: toObjectId(A.orgId), key: `identity:${idem}` });
      if (prev) { if (prev.fingerprint !== fingerprint) return NextResponse.json({ error: "This Idempotency-Key was already used for a different request." }, { status: 409, headers: H }); return NextResponse.json({ ...prev.response, replayed: true }, { status: prev.status, headers: H }); }
    }
    const result = await handleIdentityApi({ A, method, path, query, body });
    let status = 200; let out = result;
    if (result?.error) { const { error, status: st, ...rest } = result; const safe = {}; for (const k of ["errors", "warnings", "reasonCode", "class"]) if (rest[k] !== undefined) safe[k] = rest[k]; status = st || 400; out = { error, ...safe }; }
    else if (method === "POST" && (result?.provider || result?.mapping || result?.credential || result?.webhook || result?.job || result?.review)) status = 201;
    if (requests && status < 500) await requests.insertOne({ orgId: toObjectId(A.orgId), key: `identity:${idem}`, fingerprint, email: A.email || A.label, status, response: JSON.parse(JSON.stringify(out)), createdAt: new Date() }).catch(() => {});
    return NextResponse.json(out, { status, headers: H });
  } catch (err) {
    console.error(`identity api ${req.method} ${req.url} failed:`, err?.message || err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500, headers: H });
  }
}
