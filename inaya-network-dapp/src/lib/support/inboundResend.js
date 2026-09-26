// src/lib/support/inboundResend.js
//
// Inbound email through Resend (the mail provider Inaya already sends with). Resend receives mail for a domain and calls a
// webhook (`email.received`) that carries only metadata; the full message and attachments are then fetched with the
// Resend API. This adapter:
//   1. verifies the webhook's Svix signature (svix-id / svix-timestamp / svix-signature, HMAC-SHA256 over
//      `${id}.${timestamp}.${rawBody}` with the base64 key inside the `whsec_...` secret, 5 minute tolerance) with
//      RESEND_WEBHOOK_SECRET, so nothing but Resend can inject a message;
//   2. routes the message to the organization named by the recipient address (`<portal address>@<inbound domain>`, or
//      `<portal address>+<ticket token>@...` for a reply);
//   3. hands it to the same processing as every other channel (lib/support/inbound.js): idempotent by Message-ID,
//      threaded only by the signed reply-address or stored Message-IDs, sender must be a participant and pass
//      DKIM/DMARC, otherwise it is quarantined for a person to review.
// Configuration (platform level): RESEND_API_KEY (already used for sending; must be allowed to read received email),
// RESEND_WEBHOOK_SECRET, and SUPPORT_INBOUND_DOMAIN (the domain Resend receives mail for).

import { createHmac, timingSafeEqual } from "node:crypto";
import { orgBySlug } from "./settings.js";
import { processInbound } from "./inbound.js";
import { parseAddress } from "./common.js";
import { assertWebhookUrl } from "./webhooks.js";

const TOLERANCE_S = 300;
const API = () => (process.env.RESEND_API_BASE || "https://api.resend.com").replace(/\/$/, "");

export function verifySvix({ id, timestamp, signature, rawBody, secret, now = Date.now() }) {
  if (!id || !timestamp || !signature || !secret) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > TOLERANCE_S) return false;
  const key = Buffer.from(String(secret).replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();
  for (const part of String(signature).split(" ")) {
    const [ver, sig] = part.split(",");
    if (ver !== "v1" || !sig) continue;
    let got; try { got = Buffer.from(sig, "base64"); } catch { continue; }
    if (got.length === expected.length && timingSafeEqual(got, expected)) return true;
  }
  return false;
}

/** Header list/object -> { lowercase-name: value }. */
export function normHeaders(h) {
  const out = {};
  if (Array.isArray(h)) for (const x of h) { if (x?.name) out[String(x.name).toLowerCase()] = String(x.value ?? ""); }
  else if (h && typeof h === "object") for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
  return out;
}

/** DKIM / SPF / DMARC verdicts from the receiving side's own headers. Missing evidence = not passed (the message is quarantined). */
export function authFromHeaders(headers) {
  const h = normHeaders(headers);
  const ar = `${h["authentication-results"] || ""} ${h["arc-authentication-results"] || ""}`.toLowerCase();
  const res = (k) => (new RegExp(`${k}=pass\\b`).test(ar) ? "pass" : new RegExp(`${k}=(fail|softfail|neutral|none|temperror|permerror)`).test(ar) ? "fail" : null);
  const ses = (k) => { const v = String(h[`x-ses-${k}-verdict`] || "").toLowerCase(); return v === "pass" ? "pass" : v ? "fail" : null; };
  return { dkim: res("dkim") || ses("dkim") || "none", spf: res("spf") || ses("spf") || (/^pass/i.test(h["received-spf"] || "") ? "pass" : "none"), dmarc: res("dmarc") || "none" };
}

async function resendGet(path) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not configured.");
  const res = await fetch(`${API()}${path}`, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Resend answered ${res.status} for ${path.split("/").slice(0, 3).join("/")}.`);
  return res.json();
}

/** The organization a message was addressed to, from its recipients. */
export async function routeToOrg(recipients) {
  const domain = String(process.env.SUPPORT_INBOUND_DOMAIN || "").toLowerCase();
  for (const raw of recipients) {
    const { email } = parseAddress(raw); if (!email) continue;
    const [local, dom] = email.split("@");
    if (domain && dom !== domain) continue;
    const slug = local.split("+")[0];
    const org = await orgBySlug(slug);
    if (org) return { org, address: email };
  }
  return null;
}

/**
 * Handles one verified `email.received` event. Returns { status, ... } for the HTTP layer. `fetchers` are injectable for tests.
 */
export async function handleReceived({ event, fetchers = {} }) {
  const get = fetchers.get || resendGet;
  const emailId = event?.data?.email_id;
  if (!emailId || !/^[A-Za-z0-9_-]{6,80}$/.test(String(emailId))) return { status: "IGNORED", reason: "NO_EMAIL_ID" };
  const meta = event.data || {};
  const first = await routeToOrg([...(Array.isArray(meta.to) ? meta.to : meta.to ? [meta.to] : [])]);
  const mail = await get(`/emails/receiving/${emailId}`);
  const recipients = [...(mail.to || []), ...(mail.cc || []), ...(mail.bcc || [])].map(String);
  const routed = first || (await routeToOrg(recipients));
  if (!routed) return { status: "IGNORED", reason: "NO_MATCHING_PORTAL" };
  const settings = routed.org.settings; settings.portalSlug = routed.org.portalSlug;
  const headers = normHeaders(mail.headers);
  const refs = String(headers.references || "").split(/\s+/).filter(Boolean);
  const attachments = [];
  const limit = settings.attachments?.maxBytes || 25 * 1048576;
  let budget = 30 * 1048576;
  const list = Array.isArray(mail.attachments) ? mail.attachments : [];
  if (list.length) {
    let details = list;
    if (!list.every((a) => a.download_url)) { try { const r = await get(`/emails/receiving/${emailId}/attachments`); details = Array.isArray(r) ? r : r.data || list; } catch { details = list; } }
    for (const a of details.slice(0, settings.attachments?.maxPerMessage || 5)) {
      if (!a.download_url || !a.filename) continue;
      if (Number(a.size) > limit || Number(a.size) > budget) { attachments.push({ filename: a.filename, contentBase64: "" }); continue; }
      try {
        assertWebhookUrl(a.download_url);
        const res = await (fetchers.download ? fetchers.download(a.download_url) : fetch(a.download_url, { redirect: "error", signal: AbortSignal.timeout(30000) }));
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > limit) continue;
        budget -= buf.length;
        attachments.push({ filename: a.filename, contentBase64: buf.toString("base64") });
      } catch { /* an attachment that cannot be fetched is skipped; the message itself is still processed */ }
    }
  }
  const message = { messageId: mail.message_id || headers["message-id"] || `resend:${emailId}`, from: mail.from || meta.from, to: mail.to || [], cc: mail.cc || [], subject: mail.subject || meta.subject || "", text: mail.text || "", html: mail.html || "", inReplyTo: mail.in_reply_to || headers["in-reply-to"] || null, references: refs, headers, attachments, auth: authFromHeaders(mail.headers), receivedAt: mail.created_at || new Date().toISOString() };
  const r = await processInbound({ orgId: String(routed.org.orgId), settings, message });
  return r.error ? { status: "FAILED", reason: r.error } : r;
}
