// src/lib/connect/graph.js -- the only file that talks to Meta's WhatsApp Cloud API (official Graph API endpoints only;
// no WhatsApp Web automation). Every call uses the company's own encrypted token; nothing here logs tokens or content.
// Tests replace the transport with __setGraphTransport().
import { secretOf, digits } from "./core.js";

const BASE = () => (process.env.WHATSAPP_GRAPH_BASE_URL || "https://graph.facebook.com").replace(/\/$/, "");
const VERSION = () => process.env.WHATSAPP_GRAPH_VERSION || "v21.0";
let transport = null;
export function __setGraphTransport(fn) { transport = fn; }

async function call(conn, path, { method = "GET", body = null, raw = false } = {}) {
  const tok = secretOf(conn.accessTokenEncrypted); if (!tok) throw Object.assign(new Error("The WhatsApp access token is missing or can't be read."), { code: "NO_TOKEN" });
  const url = path.startsWith("http") ? path : `${BASE()}/${VERSION()}/${path}`;
  if (transport) return transport({ url, method, body, raw, token: tok });
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${tok}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  if (raw) { if (!res.ok) throw Object.assign(new Error(`Media download failed (${res.status}).`), { status: res.status }); return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") || "" }; }
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { const e = d?.error || {}; throw Object.assign(new Error(e.message || `WhatsApp API error (${res.status}).`), { status: res.status, code: e.code, subcode: e.error_subcode, metaType: e.type }); }
  return d;
}

/** Checks the credentials: returns the number's display details (used by "Test connection"). */
export async function phoneInfo(conn) {
  return call(conn, `${conn.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,code_verification_status`);
}
/** Free-form text (allowed inside the 24-hour customer-service window). */
export async function sendText(conn, to, text) {
  const d = await call(conn, `${conn.phoneNumberId}/messages`, { method: "POST", body: { messaging_product: "whatsapp", recipient_type: "individual", to: digits(to), type: "text", text: { preview_url: false, body: String(text).slice(0, 4096) } } });
  return { waMessageId: d?.messages?.[0]?.id || null };
}
/** An approved template (needed outside the 24-hour window). */
export async function sendTemplate(conn, to, name, language = "en_US", components = []) {
  const d = await call(conn, `${conn.phoneNumberId}/messages`, { method: "POST", body: { messaging_product: "whatsapp", to: digits(to), type: "template", template: { name, language: { code: language }, ...(components.length ? { components } : {}) } } });
  return { waMessageId: d?.messages?.[0]?.id || null };
}
export async function markRead(conn, waMessageId) {
  try { await call(conn, `${conn.phoneNumberId}/messages`, { method: "POST", body: { messaging_product: "whatsapp", status: "read", message_id: waMessageId } }); } catch { /* best effort */ }
}
/** Media: first the URL (official endpoint), then the bytes with the same token; size checked before trusting it. */
export async function fetchMedia(conn, mediaId, maxBytes) {
  const meta = await call(conn, String(mediaId));
  if (meta?.file_size && maxBytes && Number(meta.file_size) > maxBytes) throw Object.assign(new Error("The file is too large."), { code: "TOO_LARGE" });
  const r = await call(conn, meta.url, { raw: true });
  if (maxBytes && r.buffer.length > maxBytes) throw Object.assign(new Error("The file is too large."), { code: "TOO_LARGE" });
  return { buffer: r.buffer, mimeType: meta.mime_type || r.contentType, sha256: meta.sha256 || null };
}
export async function listTemplates(conn) {
  if (!conn.wabaId) return { data: [] };
  return call(conn, `${conn.wabaId}/message_templates?fields=name,status,language,category&limit=100`);
}
