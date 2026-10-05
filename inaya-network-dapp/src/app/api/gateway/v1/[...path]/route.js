// app/api/gateway/v1/[...path]/route.js -- the API a Sovereign Gateway agent calls (outbound from the customer's network; Inaya never connects in).
//
//   POST enroll                              one-time token + public key + proof of possession  -> registration (no session, no secret returned)
//   POST heartbeat                           health report in; desired connector configuration, queued commands and approved transfers out
//   POST inventory                           file listing (metadata only) for one approved folder
//   POST acl                                 permission snapshot and directory identities for one approved folder
//   POST events                              the agent's hash-chained audit events
//   GET  transfers/{id}                      which parts Inaya holds (resume)
//   POST transfers/{id}/begin | complete     start (with the opaque key envelope) and finish an encrypted transfer
//   PUT  transfers/{id}/parts/{n}            one encrypted part with its SHA-256
//   GET  transfers/{id}/parts/{n}            read a stored part back (restore, same organization only)
//
// Every call except enroll carries Ed25519 signature headers (see gateway.js). The organization is the gateway's own, never a request field.

import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../lib/orgs.js";
import { requireFeature } from "../../../../../lib/featureFlags.js";
import { slidingWindowCheck, getClientIp } from "../../../../../lib/rateLimit.js";
import * as G from "../../../../../lib/gateway/gateway.js";
import * as A from "../../../../../lib/gateway/acl.js";
import * as T from "../../../../../lib/gateway/transfers.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const MAX_BODY = 3 * 1024 * 1024;
const H = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: H });

// Per-gateway request budget, kept in memory so it costs no database round trip. It is best effort per server instance; the signature, nonce and clock checks are what
// stop impersonation, and this only bounds how fast a single (possibly compromised) gateway can hammer one instance.
const budget = new Map(); const CALLS_PER_MINUTE = 1200;
function withinCallBudget(id, now = Date.now()) { const b = budget.get(id); if (!b || now - b.start >= 60_000) { budget.set(id, { start: now, n: 1 }); if (budget.size > 5000) for (const [k, v] of budget) if (now - v.start >= 60_000) budget.delete(k); return true; } b.n++; return b.n <= CALLS_PER_MINUTE; }

async function handle(req, ctx) {
  try {
    const { path = [] } = await ctx.params; const method = req.method; const url = new URL(req.url);
    const rawBody = method === "GET" ? "" : await req.text(); if (rawBody.length > MAX_BODY) return json({ error: "Request body is too large." }, 413);
    let body = {}; if (rawBody) { try { body = JSON.parse(rawBody); } catch { return json({ error: "Request body must be valid JSON." }, 400); } }
    await ensureOrgIndexes();
    const [a, b, c, d] = path;

    if (method === "POST" && a === "enroll" && path.length === 1) {
      const rl = await slidingWindowCheck({ action: "gateway:enroll", key: getClientIp(req) || "?", max: 30, windowMs: 3600_000 }); if (!rl.allowed) return json({ error: "Too many attempts. Try again later." }, 429);
      return json(await G.enroll({ token: body.token, publicKey: body.publicKey, proof: body.proof, ts: body.ts, label: body.label, version: body.version, platform: body.platform, capabilities: body.capabilities }));
    }

    const auth = await G.authenticateGateway({ method, path: url.pathname + url.search, headers: req.headers, rawBody });
    if (auth.error) return json({ error: auth.error, ...(auth.revoked ? { code: "REVOKED" } : {}) }, auth.status);
    const gateway = auth.gateway;
    const off = await requireFeature("FEATURE_SOVEREIGN_GATEWAY", String(gateway.orgId)); if (off) return json({ error: off.error }, off.status);
    if (!withinCallBudget(String(gateway._id))) return json({ error: "Too many requests." }, 429);

    if (method === "POST" && a === "heartbeat") return json(await G.heartbeat({ gateway, report: body }));
    if (method === "POST" && a === "inventory") return json(await G.recordInventory({ gateway, connectorId: body.connectorId, folderId: body.folderId, entries: body.entries, scanId: body.scanId, complete: body.complete === true }));
    if (method === "POST" && a === "acl") return json(await A.recordAcl({ gateway, folderId: body.folderId, entries: body.entries, principals: body.principals, source: body.source, takenAt: body.takenAt, failures: body.failures }));
    if (method === "POST" && a === "events") return json(await G.recordAuditEvents({ gateway, events: body.events }));
    if (a === "transfers" && b) {
      if (method === "GET" && path.length === 2) return json(await T.transferState({ gateway, transferId: b }));
      if (method === "POST" && c === "begin") return json(await T.beginTransfer({ gateway, transferId: b, partCount: body.partCount, cipherSize: body.cipherSize, keyEnvelope: body.keyEnvelope, plainSha256: body.plainSha256 }));
      if (method === "PUT" && c === "parts" && d !== undefined) return json(await T.putPart({ gateway, transferId: b, index: Number(d), data: body.data, sha256: body.sha256 }));
      if (method === "GET" && c === "parts" && d !== undefined) return json(await T.getPart({ gateway, transferId: b, index: Number(d) }));
      if (method === "POST" && c === "complete") return json(await T.completeTransfer({ gateway, transferId: b, chainHash: body.chainHash }));
    }
    return json({ error: "Not found." }, 404);
  } catch (err) {
    if (err instanceof G.GatewayError) return json({ error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.expectedSeq ? { expectedSeq: err.expectedSeq } : {}), ...(err.received ? { received: err.received } : {}) }, err.status);
    console.error("gateway api failed:", err?.name, String(err?.message || "").slice(0, 200)); return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
export const GET = handle, POST = handle, PUT = handle;
