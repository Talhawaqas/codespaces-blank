// src/lib/didit.js
//
// Server-only client for Didit's KYC API (docs.didit.me), used by the
// email-based referral program (no wallet-connect anywhere in that flow —
// participation is by email + Didit KYC only). DIDIT_API_KEY,
// DIDIT_WEBHOOK_SECRET, and DIDIT_WORKFLOW_ID are read fresh from
// process.env and never sent to the client.
//
// Base URL, endpoint shapes, and webhook signature algorithm confirmed
// directly against docs.didit.me rather than assumed:
//   - POST /v3/session/            -> { session_id, url, session_token, session_kind, status }
//   - GET  /v3/session/{id}/decision/ -> { session_id, session_kind, status, ...features }
//   - Auth: `x-api-key` header (Business Console -> Application -> API & Webhooks).
//   - Webhook idempotency key is `event_id` (a uuid on the payload) — NOT
//     session_id alone, since one session can fire more than one webhook
//     event (e.g. status transitions).

const DIDIT_BASE_URL = "https://verification.didit.me";
const MAX_WEBHOOK_AGE_SECONDS = 300; // Didit's own recommended freshness window

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

/** Creates a Didit KYC session for a referred user. vendorData is used purely for
 *  correlation on Didit's side (e.g. the referral doc's _id) — never PII. */
export async function createDiditSession({ vendorData, callback } = {}) {
  const apiKey = requireEnv("DIDIT_API_KEY");
  const workflowId = requireEnv("DIDIT_WORKFLOW_ID");

  const res = await fetch(`${DIDIT_BASE_URL}/v3/session/`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      workflow_id: workflowId,
      ...(vendorData ? { vendor_data: String(vendorData) } : {}),
      ...(callback ? { callback } : {}),
    }),
  });

  if (!res.ok) {
    // Per project policy: never surface a raw response body from a call that
    // carried a credential. Status only.
    throw new Error(`Didit session creation failed (HTTP ${res.status}).`);
  }

  const data = await res.json();
  return {
    sessionId: data.session_id,
    url: data.url,
    sessionToken: data.session_token,
    sessionKind: data.session_kind,
    status: data.status,
  };
}

/** Thrown by getDiditDecision specifically for a 404 — Didit has no record of this
 *  session at all (expired past its retention window, or never really existed).
 *  Distinguished from other errors (5xx, network) so callers can tell "this session
 *  is definitively dead, stop waiting on it" apart from "transient, try again later." */
export class DiditSessionNotFoundError extends Error {
  constructor(sessionId) {
    super(`Didit has no record of session ${sessionId} (HTTP 404).`);
    this.name = "DiditSessionNotFoundError";
  }
}

/** Retrieves the current decision/status for a Didit session. Used for
 *  status-check polling as a fallback to the webhook, not as the primary path. */
export async function getDiditDecision(sessionId) {
  const apiKey = requireEnv("DIDIT_API_KEY");

  const res = await fetch(`${DIDIT_BASE_URL}/v3/session/${encodeURIComponent(sessionId)}/decision/`, {
    method: "GET",
    headers: { "x-api-key": apiKey },
  });

  if (res.status === 404) throw new DiditSessionNotFoundError(sessionId);
  if (!res.ok) {
    throw new Error(`Didit decision fetch failed (HTTP ${res.status}).`);
  }

  return res.json();
}

// ============================================================
// Webhook signature verification
// ============================================================
//
// X-Signature-V2 (primary): HMAC-SHA256 over a canonical JSON form of the
// body — keys recursively sorted, compact separators, unicode preserved —
// hex-encoded. Confirmed via docs.didit.me/integration/webhooks. Didit's
// reference implementation also "shortens" whole-valued floats (100.0 -> 100)
// before signing; that step is a no-op in JS because JSON.parse never
// preserves the distinction between 100 and 100.0 as a JS number in the
// first place, so re-stringifying already produces "100".
//
// X-Signature (fallback): HMAC-SHA256 over the exact raw request bytes.
// Only usable if verification happens before any body parsing — which is
// what our route does (reads req.text() first), so we compute and check
// both when both headers are present, and require at least one to pass.

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortJsonValue(value[key]);
    return sorted;
  }
  return value;
}

async function hmacSha256Hex(message, secret) {
  const { createHmac } = await import("node:crypto");
  return createHmac("sha256", secret).update(message, "utf8").digest("hex");
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  // require('node:crypto').timingSafeEqual needs equal-length Buffers, guaranteed above.
  const { timingSafeEqual } = require("node:crypto");
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** Verifies a Didit webhook request. Call with the RAW body text (read via
 *  req.text(), before any JSON.parse) and the request's headers. Fails
 *  closed: any missing/malformed input is treated as invalid. */
export async function verifyDiditWebhook({ rawBody, headers }) {
  const secret = requireEnv("DIDIT_WEBHOOK_SECRET");

  const timestampHeader = headers.get("x-timestamp");
  if (!timestampHeader) return { valid: false, reason: "Missing X-Timestamp header." };
  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return { valid: false, reason: "Malformed X-Timestamp header." };
  const ageSeconds = Math.abs(Date.now() / 1000 - timestamp);
  if (ageSeconds > MAX_WEBHOOK_AGE_SECONDS) return { valid: false, reason: `Webhook timestamp too old (${Math.round(ageSeconds)}s).` };

  const signatureV2 = headers.get("x-signature-v2");
  const signatureRaw = headers.get("x-signature");

  if (!signatureV2 && !signatureRaw) {
    return { valid: false, reason: "No signature header present (expected X-Signature-V2 or X-Signature)." };
  }

  if (signatureV2) {
    let canonical;
    try {
      canonical = JSON.stringify(sortJsonValue(JSON.parse(rawBody)));
    } catch {
      return { valid: false, reason: "Body is not valid JSON — cannot verify X-Signature-V2." };
    }
    const expected = await hmacSha256Hex(canonical, secret);
    if (timingSafeEqualHex(expected, signatureV2)) return { valid: true, via: "X-Signature-V2" };
    // Fall through to try X-Signature only if V2 was present but didn't match
    // AND a raw fallback signature also exists — otherwise fail closed now.
    if (!signatureRaw) return { valid: false, reason: "X-Signature-V2 mismatch." };
  }

  if (signatureRaw) {
    const expected = await hmacSha256Hex(rawBody, secret);
    if (timingSafeEqualHex(expected, signatureRaw)) return { valid: true, via: "X-Signature" };
    return { valid: false, reason: "X-Signature mismatch." };
  }

  return { valid: false, reason: "Signature verification failed." };
}
