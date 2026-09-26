// src/app/api/orgs/workflows/_lib.js
//
// One wrapper for every workflow endpoint (AI Business Operations Manager SOW section 51). In this order, for every route:
// authenticate (session cookie) -> organization scope (requireMembership: the
// org is checked against the CALLER's own membership, never trusted from the
// client) -> rate limit (per user) -> input size limit -> replay protection
// (Idempotency-Key on mutating requests) -> the library function, which
// enforces the workflow permission, validates input, audits, and never leaks
// secrets. Route files stay thin wrappers over src/lib/workflows/*.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, getOrgCollections, toObjectId } from "../../../../lib/orgs.js";
import { checkRateLimit } from "../../../../lib/rateLimit.js";

export const dynamic = "force-dynamic";
const MAX_JSON_BYTES = 512 * 1024;

function toResponse(result, okStatus) {
  if (result?.error) {
    const { error, status, ...rest } = result;
    const safe = {};
    for (const k of ["errors", "warnings", "reasonCode", "security", "current"]) if (rest[k] !== undefined) safe[k] = rest[k];
    return { status: status || 400, body: { error, ...safe } };
  }
  return { status: okStatus, body: result };
}

async function readBody(req) {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > MAX_JSON_BYTES) return { error: "Request body is too large.", status: 413 };
  try {
    const text = await req.text();
    if (text.length > MAX_JSON_BYTES) return { error: "Request body is too large.", status: 413 };
    return { body: text ? JSON.parse(text) : {} };
  } catch {
    return { error: "Request body must be valid JSON.", status: 400 };
  }
}

/**
 * workflowRoute(handler, { okStatus }) -> a Next.js route handler.
 * handler receives { orgId, membership, email, query, params, body, req }.
 */
export function workflowRoute(handler, { okStatus = 200 } = {}) {
  return async function route(req, ctx) {
    const method = req.method;
    const mutating = method !== "GET" && method !== "HEAD";
    try {
      const url = new URL(req.url);
      const query = Object.fromEntries(url.searchParams.entries());
      let body = {};
      if (mutating && method !== "DELETE") {
        const parsed = await readBody(req);
        if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
        body = parsed.body;
      } else if (method === "DELETE") {
        const parsed = await readBody(req);
        body = parsed.body || {};
      }
      const orgId = query.orgId || body.orgId;
      if (!orgId || typeof orgId !== "string" || orgId.length > 40) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

      await ensureOrgIndexes();
      const auth = await requireMembership(req, orgId);
      if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
      const email = auth.session.email;

      try {
        await checkRateLimit({ action: `wf:${mutating ? "write" : "read"}`, key: email, max: mutating ? 90 : 400, windowMs: 15 * 60 * 1000 });
      } catch {
        return NextResponse.json({ error: "Too many requests. Please wait a moment and try again." }, { status: 429 });
      }

      // Replay protection: a repeated Idempotency-Key returns the recorded
      // response instead of repeating a consequential action.
      const idemKey = mutating ? req.headers.get("idempotency-key") : null;
      let requests = null;
      if (idemKey) {
        if (idemKey.length < 8 || idemKey.length > 100) return NextResponse.json({ error: "Idempotency-Key must be 8-100 characters." }, { status: 400 });
        requests = (await getOrgCollections()).workflowRequests;
        const fingerprint = `${method} ${url.pathname}`;
        const prev = await requests.findOne({ orgId: toObjectId(orgId), key: idemKey });
        if (prev) {
          if (prev.fingerprint !== fingerprint || prev.email !== email) return NextResponse.json({ error: "This Idempotency-Key was already used for a different request." }, { status: 409 });
          return NextResponse.json({ ...prev.response, replayed: true }, { status: prev.status });
        }
      }

      const params = ctx?.params ? await ctx.params : {};
      const result = await handler({ orgId, membership: auth.membership, email, query, params, body, req });
      const out = toResponse(result, okStatus);
      if (requests && out.status < 500) {
        await requests.insertOne({ orgId: toObjectId(orgId), key: idemKey, fingerprint: `${method} ${url.pathname}`, email, status: out.status, response: JSON.parse(JSON.stringify(out.body)), createdAt: new Date() }).catch(() => {});
      }
      return NextResponse.json(out.body, { status: out.status });
    } catch (err) {
      console.error(`workflow route ${req.method} ${req.url} failed:`, err?.message || err);
      return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
    }
  };
}
