// POST /api/integrations/identity/webhooks/:provider  (Identity Integration SOW section 23)
//
// The inbound door for Rewst, an RMM, an HR/PSA system, Entra change notifications relayed by a connector, or anything that can sign an HTTPS
// request. :provider is the identity provider id shown in Inaya. In order:
//   HTTPS only -> rate limit -> size limit (256 KB) -> signature (HMAC-SHA256 over "<timestamp>.<raw body>") -> timestamp window (5 minutes)
//   -> provider active -> schema (canonical or adapted) -> tenant binding (in the engine) -> idempotency (event id) -> lifecycle engine.
// Anything unsigned or unknown is refused with the same generic answer, so this endpoint does not reveal which providers exist.
import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../../lib/orgs.js";
import { checkRateLimit } from "../../../../../../lib/rateLimit.js";
import { getProviderById, signingSecretOf } from "../../../../../../lib/identity/providers.js";
import { verifySignature, normalizeEvent, MAX_BODY_BYTES } from "../../../../../../lib/identity/normalize.js";
import { processEvent } from "../../../../../../lib/identity/engine.js";
import { ensureIdentityIndexes } from "../../../../../../lib/identity/db.js";
import { RETRYABLE } from "../../../../../../lib/identity/common.js";
import { audit } from "../../../../../../lib/identity/record.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const H = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const json = (body, status) => NextResponse.json(body, { status, headers: H });
const UNAUTH = () => json({ error: "The request could not be authenticated." }, 401);

export async function POST(req, ctx) {
  try {
    const { provider: providerId } = await ctx.params;
    const url = new URL(req.url);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const proto = req.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
    if (proto !== "https" && !local) return json({ error: "HTTPS is required." }, 400);
    const ip = (req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
    try { await checkRateLimit({ action: "identity-webhook-ip", key: `${ip}:${String(providerId).slice(0, 40)}`, max: 300, windowMs: 60000 }); }
    catch { return json({ error: "Too many requests.", reasonCode: "RATE_LIMITED" }, 429); }
    if (Number(req.headers.get("content-length") || 0) > MAX_BODY_BYTES) return json({ error: "The payload is too large." }, 413);
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: "The payload is too large." }, 413);

    await ensureOrgIndexes(); await ensureIdentityIndexes();
    const provider = await getProviderById(providerId);
    const secret = provider ? signingSecretOf(provider) : null;
    if (!provider || !secret) return UNAUTH();
    try { await checkRateLimit({ action: "identity-webhook", key: String(provider._id), max: 1200, windowMs: 60000 }); }
    catch { return json({ error: "Too many requests.", reasonCode: "RATE_LIMITED" }, 429); }
    const sig = verifySignature({ secret, timestamp: req.headers.get("x-inaya-timestamp"), signature: req.headers.get("x-inaya-signature"), rawBody: raw });
    if (!sig.ok) {
      await audit({ orgId: provider.orgId, action: "IDENTITY_WEBHOOK_REJECTED", actorEmail: `identity:${provider.kind}`, metadata: { reason: sig.reason, providerId: String(provider._id) } });
      return sig.status === 413 ? json({ error: "The payload is too large." }, 413) : UNAUTH();
    }
    if (provider.status !== "ACTIVE") return json({ error: "This provider is disabled.", reasonCode: "PROVIDER_DISABLED" }, 403);

    let body; try { body = JSON.parse(raw); } catch { return json({ error: "The body must be valid JSON.", reasonCode: "SCHEMA" }, 400); }
    const n = normalizeEvent(provider.kind, body);
    if (n.error) { await audit({ orgId: provider.orgId, action: "IDENTITY_EVENT_REJECTED", actorEmail: `identity:${provider.kind}`, metadata: { reasonCode: "SCHEMA", reason: n.error } }); return json({ error: n.error, reasonCode: "SCHEMA" }, 400); }

    const r = await processEvent({ provider, event: n.event, origin: "webhook" });
    const base = { status: r.status, eventId: n.event.eventId, ...(r.runId ? { runId: String(r.runId) } : {}), ...(r.reason ? { reason: r.reason } : {}), ...(r.previous ? { previous: r.previous } : {}) };
    switch (r.status) {
      case "REJECTED": return json({ ...base, reasonCode: r.reasonCode }, r.reasonCode === "TENANT_MISMATCH" || r.reasonCode === "PROVIDER_DISABLED" ? 403 : 400);
      case "FAILED": return json({ ...base, failure: r.failure }, r.failure && RETRYABLE.has(r.failure.class) ? 503 : 422);
      case "PENDING": return json(base, 202);
      case "UNRESOLVED": return json({ ...base, reasonCode: r.reasonCode || "UNRESOLVED" }, 200);
      default: return json({ ...base, ...(r.state ? { state: r.state } : {}) }, 200);
    }
  } catch (err) {
    console.error("identity webhook failed:", err?.message || err);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
