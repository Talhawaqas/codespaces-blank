// src/lib/bookkeeper/inbound.js
//
// AI Bookkeeper SOW sections 9, 10, 23, 35, 39: the two public doors into the bookkeeping pipeline, both authenticated by signature, never by
// a session, and both organization-routed by the SOURCE they name (a source belongs to exactly one organization and department).
//
//   ingestSigned     email relay / API: HMAC-SHA256 over "<timestamp>.<raw body>" with the source's ingest secret, +-5 minute window,
//                    event id replay guard, sender allow-list (email), size limits. Any mail provider or automation can relay into it.
//                    STATUS: signed relay only. Gmail / Microsoft 365 / IMAP polling connectors are not built (FUTURE); a live mail provider
//                    has not been used (UNVERIFIED).
//   whatsapp*        Meta WhatsApp Cloud API webhook: GET verification challenge, POST with X-Hub-Signature-256 (HMAC-SHA256 of the raw body
//                    with the app secret), message-id replay guard, business phone number check, sender allow-list REQUIRED, media fetched
//                    through the Graph API with the stored access token. STATUS: UNVERIFIED against a live WhatsApp Business account.

import { checkRateLimit } from "../rateLimit.js";
import { assertWebhookUrl } from "../support/webhooks.js";
import { getBookkeeperCollections } from "./db.js";
import { fail, nowIso, hmacHex, safeEqualHex, sha256 } from "./common.js";
import { secretOf } from "./sources.js";
import { ingestDocument } from "./documents.js";
import { ALLOWED_TYPES, detectInstructions } from "./extract.js";
import { audit } from "./record.js";

export const TOLERANCE_S = 300;
export const MAX_BODY_BYTES = 4 * 1024 * 1024; // the hosting platform's request-body ceiling: larger files must be uploaded in the console
const MAX_ATTACHMENTS = 10;

export function verifyIngestSignature({ secret, timestamp, signature, rawBody, now = Date.now() }) {
  if (!secret) return { ok: false, status: 503, reason: "not_configured" };
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) return { ok: false, status: 413, reason: "too_large" };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > TOLERANCE_S) return { ok: false, status: 401, reason: "bad_timestamp" };
  const sig = String(signature || "").replace(/^v1=/, "");
  if (!safeEqualHex(sig, hmacHex(secret, `${timestamp}.${rawBody}`))) return { ok: false, status: 401, reason: "bad_signature" };
  return { ok: true };
}

/** Records a provider event id once; a repeat is a DUPLICATE and does nothing. */
async function firstTime({ orgId, sourceId, eventId }) {
  const { bkEvents } = await getBookkeeperCollections();
  try { await bkEvents.insertOne({ orgId, sourceId, eventId: String(eventId).slice(0, 200), createdAt: new Date() }); return true; }
  catch (err) { if (err?.code === 11000) return false; throw err; }
}

const looksFinancial = (t) => /(invoice|receipt|amount due|total)/i.test(t) && /\d[\d.,]*\d/.test(t);

/** Email relay or API ingestion. body = { eventId, from?, subject?, messageId?, text?, attachments:[{ filename, contentType, contentBase64 }] }. */
export async function ingestSigned({ source, headers, rawBody }) {
  if (!source || source.status !== "ACTIVE" || !["EMAIL_INBOX", "API"].includes(source.type)) return { status: 401, body: { error: "The request could not be authenticated." } };
  try { await checkRateLimit({ action: "bk-ingest", key: String(source._id), max: 120, windowMs: 60000 }); } catch { return { status: 429, body: { error: "Too many requests.", reasonCode: "RATE_LIMITED" } }; }
  const v = verifyIngestSignature({ secret: secretOf(source.ingestSecretEncrypted), timestamp: headers["x-inaya-timestamp"], signature: headers["x-inaya-signature"], rawBody });
  if (!v.ok) { await audit({ orgId: source.orgId, recordId: source._id, action: "BOOKKEEPER_INGEST_REJECTED", actorEmail: `source:${source.name}`, metadata: { sourceId: String(source._id), reason: v.reason } }); return v.status === 413 ? { status: 413, body: { error: "The payload is too large." } } : { status: 401, body: { error: "The request could not be authenticated." } }; }
  let b; try { b = JSON.parse(rawBody); } catch { return { status: 400, body: { error: "The body must be valid JSON." } }; }
  if (!b || typeof b !== "object" || !b.eventId || typeof b.eventId !== "string" || b.eventId.length < 6 || b.eventId.length > 200) return { status: 400, body: { error: "eventId (6-200 characters) is required." } };
  if (source.type === "EMAIL_INBOX" && source.allowedSenders?.length) {
    const from = String(b.from || "").toLowerCase().match(/[^\s<>]+@[^\s<>]+/)?.[0] || "";
    if (!source.allowedSenders.includes(from)) { await audit({ orgId: source.orgId, recordId: source._id, action: "BOOKKEEPER_INGEST_REJECTED", actorEmail: `source:${source.name}`, metadata: { sourceId: String(source._id), reason: "sender_not_allowed" } }); return { status: 403, body: { error: "That sender is not allowed for this inbox.", reasonCode: "SENDER_NOT_ALLOWED" } }; }
  }
  if (!(await firstTime({ orgId: source.orgId, sourceId: source._id, eventId: b.eventId }))) return { status: 200, body: { status: "DUPLICATE", eventId: b.eventId } };

  const channel = source.type === "EMAIL_INBOX" ? "EMAIL" : "API";
  const atts = Array.isArray(b.attachments) ? b.attachments.slice(0, MAX_ATTACHMENTS) : [];
  const results = [];
  for (const [i, a] of atts.entries()) {
    const buffer = typeof a?.contentBase64 === "string" ? Buffer.from(a.contentBase64, "base64") : null;
    if (!buffer || !buffer.length) { results.push({ filename: a?.filename || null, error: "empty attachment" }); continue; }
    const type = String(a.contentType || "").toLowerCase().split(";")[0];
    const r = await ingestDocument({ orgId: source.orgId, source, channel, filename: a.filename, contentType: type, buffer, externalId: `${b.messageId || b.eventId}:${i}:${sha256(buffer).slice(0, 12)}`, meta: { messageId: b.messageId, from: b.from, subject: b.subject }, actor: `source:${source.name}` });
    results.push(r.error ? { filename: a.filename, error: r.error, status: r.status } : { filename: a.filename, documentId: r.document.documentId, status: r.document.status, duplicate: !!r.duplicate });
  }
  if (!atts.length && typeof b.text === "string" && b.text.length > 20 && b.text.length < 200000 && looksFinancial(b.text)) {
    const r = await ingestDocument({ orgId: source.orgId, source, channel, filename: "email-body.txt", contentType: "text/plain", buffer: Buffer.from(b.text, "utf8"), externalId: `${b.messageId || b.eventId}:body`, meta: { messageId: b.messageId, from: b.from, subject: b.subject }, actor: `source:${source.name}` });
    results.push(r.error ? { filename: "email-body.txt", error: r.error } : { filename: "email-body.txt", documentId: r.document.documentId, status: r.document.status, duplicate: !!r.duplicate });
  }
  const storageFail = results.some((r) => r.status === 502);
  if (storageFail) { const { bkEvents } = await getBookkeeperCollections(); await bkEvents.deleteOne({ orgId: source.orgId, sourceId: source._id, eventId: String(b.eventId).slice(0, 200) }); return { status: 502, body: { error: "A document could not be stored; retry the same event.", results } }; }
  return { status: 200, body: { status: "PROCESSED", eventId: b.eventId, results, note: detectInstructions(b.text || "").length ? "The message text contained instruction-like content; it is treated as untrusted data." : undefined } };
}

// ------------------------------------------------------------------------------------------------------------------ WhatsApp
const GRAPH = () => (process.env.WHATSAPP_GRAPH_BASE_URL || "https://graph.facebook.com").replace(/\/$/, "");
export const whatsappVerify = ({ source, query }) => {
  if (!source || source.status !== "ACTIVE" || source.type !== "WHATSAPP") return { status: 403, text: "Forbidden" };
  const token = secretOf(source.verifyTokenEncrypted);
  if (query["hub.mode"] === "subscribe" && token && query["hub.verify_token"] === token && query["hub.challenge"]) return { status: 200, text: String(query["hub.challenge"]).slice(0, 200) };
  return { status: 403, text: "Forbidden" };
};

async function fetchMedia({ mediaId, token }) {
  const meta = await fetch(`${GRAPH()}/v19.0/${encodeURIComponent(mediaId)}`, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!meta.ok) throw new Error(`media lookup ${meta.status}`);
  const m = await meta.json(); if (!m.url) throw new Error("no media url");
  assertWebhookUrl(m.url); // https only, no private/metadata addresses
  if (Number(m.file_size) > MAX_BODY_BYTES * 3) throw new Error("media too large");
  const res = await fetch(m.url, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`media download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer()); if (buf.length > 15 * 1024 * 1024) throw new Error("media too large");
  return { buffer: buf, mimeType: (m.mime_type || res.headers.get("content-type") || "").split(";")[0] };
}

export async function whatsappReceive({ source, headers, rawBody }) {
  if (!source || source.status !== "ACTIVE" || source.type !== "WHATSAPP") return { status: 401, body: { error: "The request could not be authenticated." } };
  try { await checkRateLimit({ action: "bk-whatsapp", key: String(source._id), max: 300, windowMs: 60000 }); } catch { return { status: 429, body: { error: "Too many requests." } }; }
  if (Buffer.byteLength(rawBody) > 1024 * 1024) return { status: 413, body: { error: "The payload is too large." } };
  const appSecret = secretOf(source.appSecretEncrypted);
  const sig = String(headers["x-hub-signature-256"] || "").replace(/^sha256=/, "");
  if (!appSecret || !safeEqualHex(sig, hmacHex(appSecret, rawBody))) { await audit({ orgId: source.orgId, recordId: source._id, action: "BOOKKEEPER_INGEST_REJECTED", actorEmail: `source:${source.name}`, metadata: { sourceId: String(source._id), reason: "bad_signature" } }); return { status: 401, body: { error: "The request could not be authenticated." } }; }
  let b; try { b = JSON.parse(rawBody); } catch { return { status: 400, body: { error: "The body must be valid JSON." } }; }
  const token = secretOf(source.accessTokenEncrypted); const out = { processed: 0, duplicates: 0, rejected: 0, failed: 0 };
  for (const entry of Array.isArray(b?.entry) ? b.entry.slice(0, 20) : []) for (const ch of Array.isArray(entry?.changes) ? entry.changes.slice(0, 20) : []) {
    const val = ch?.value; if (!val || val.metadata?.phone_number_id !== source.phoneNumberId) { if (val) out.rejected++; continue; } // another business number: never route it here
    for (const msg of Array.isArray(val.messages) ? val.messages.slice(0, 20) : []) {
      const from = String(msg.from || "").replace(/[^\d]/g, "");
      if (!source.allowedSenders?.includes(from)) { out.rejected++; await audit({ orgId: source.orgId, recordId: source._id, action: "BOOKKEEPER_INGEST_REJECTED", actorEmail: `source:${source.name}`, metadata: { sourceId: String(source._id), reason: "sender_not_allowed" } }); continue; }
      if (!msg.id || !["image", "document"].includes(msg.type)) { out.rejected++; continue; }
      if (!(await firstTime({ orgId: source.orgId, sourceId: source._id, eventId: msg.id }))) { out.duplicates++; continue; }
      const media = msg[msg.type]; if (!media?.id) { out.rejected++; continue; }
      try {
        const m = await fetchMedia({ mediaId: media.id, token });
        const type = ALLOWED_TYPES[m.mimeType] ? m.mimeType : (media.mime_type || m.mimeType);
        const r = await ingestDocument({ orgId: source.orgId, source, channel: "WHATSAPP", filename: media.filename || `whatsapp-${msg.id.slice(-8)}.${type === "application/pdf" ? "pdf" : type === "image/png" ? "png" : "jpg"}`, contentType: type, buffer: m.buffer, externalId: msg.id, meta: { messageId: msg.id, from: `+${from}`.replace(/\d(?=\d{4})/g, "*") }, actor: `source:${source.name}` });
        if (r.error) { if (r.status === 502) { out.failed++; const { bkEvents } = await getBookkeeperCollections(); await bkEvents.deleteOne({ orgId: source.orgId, sourceId: source._id, eventId: String(msg.id).slice(0, 200) }); } else out.rejected++; } else if (r.duplicate) out.duplicates++; else out.processed++;
      } catch (err) { out.failed++; console.error("whatsapp media failed:", err.message); const { bkEvents } = await getBookkeeperCollections(); await bkEvents.deleteOne({ orgId: source.orgId, sourceId: source._id, eventId: String(msg.id).slice(0, 200) }); }
    }
  }
  return { status: out.failed ? 500 : 200, body: { status: out.failed ? "RETRY" : "OK", ...out } };
}

void fail; void nowIso;
