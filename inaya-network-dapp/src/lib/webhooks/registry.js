// src/lib/webhooks/registry.js
//
// General signed webhook registry (Competitive Expansion SOW workstream X, WEBHOOK-001). The support module and the S3 bucket notifications each
// have their own narrow webhooks; this is the ORGANIZATION-LEVEL registry for the events integrators actually ask for, and it reuses their
// SSRF-safe sender (https only, no private/loopback/metadata addresses, no redirects, size and time limits, checked on every attempt) and the
// integration secret encryption.
//
// Delivery: one durable row per (endpoint, event id) so a retried emit never double-queues. Signed with HMAC-SHA256 over `${timestamp}.${body}`;
// headers: x-inaya-event, x-inaya-delivery-id (unique per delivery, for dedupe), x-inaya-timestamp (receivers should reject anything older than
// five minutes: replay protection), x-inaya-signature: "t=<ts>,v1=<new>[,v1=<previous>]". Retries with backoff (1, 5, 15, 60, 240, 720 minutes),
// then DEAD (the dead-letter list) where an admin can redeliver. After 20 consecutive failures an endpoint pauses itself.
// Secret rotation: the old secret keeps signing alongside the new one for 24 hours, so a receiver can switch without dropping events.
// Privacy: payloads carry identifiers and metadata only. Keys that look like content (text, body, plaintext, content, passkey, ...) are stripped, and
// chat events are metadata-only and delivered only to endpoints that explicitly opted in.
// Collections: org_webhooks, org_webhook_deliveries.

import { ObjectId } from "mongodb";
import { randomBytes, createHmac } from "node:crypto";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { hasAdminRole } from "../orgGates.js";
import { logOrgActivity } from "../org-activity-log.js";
import { assertWebhookUrl, post } from "../support/webhooks.js";
import { encryptIntegrationSecret, decryptIntegrationSecret, isIntegrationCryptoConfigured } from "../integrationCrypto.js";

export class WebhookError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); } }
const fail = (status, message, extra) => { throw new WebhookError(status, message, extra); };
const nowIso = () => new Date().toISOString();
export const EVENT_TYPES = ["file.uploaded", "file.updated", "file.deleted", "file.lifecycle_expired", "share.created", "share.revoked", "dlp.decision", "chat.metadata", "workflow.event", "backup.event", "resilience.event", "identity.event", "ransomware.signal", "device.revoked", "file_request.received", "webhook.test"];
const OPT_IN = new Set(["chat.metadata"]);
export const MAX_ATTEMPTS = 6; const BACKOFF_MIN = [1, 5, 15, 60, 240, 720]; export const AUTO_PAUSE_AFTER = 20; const ROTATION_GRACE_MS = 24 * 3600_000;
const CONTENT_KEYS = /^(text|body|plaintext|content|message|passkey|password|secret|token|ciphertext|payload|attachment|attachments|title)$/i;

let indexed = false;
async function cols() {
  const c = await getOrgCollections(); const hooks = c.db.collection("org_webhooks"); const deliveries = c.db.collection("org_webhook_deliveries");
  if (!indexed) { await Promise.all([hooks.createIndex({ orgId: 1, active: 1 }), deliveries.createIndex({ webhookId: 1, eventId: 1 }, { unique: true }), deliveries.createIndex({ status: 1, nextAttemptAt: 1 }), deliveries.createIndex({ orgId: 1, createdAt: -1 }), deliveries.createIndex({ createdAt: 1 }, { expireAfterSeconds: 30 * 86400, partialFilterExpression: { status: "DELIVERED" } })]); indexed = true; }
  return { c, hooks, deliveries };
}
const mustManage = (m) => { if (!hasAdminRole(m, "integrationAdmin")) fail(403, "Only an owner, admin or integration admin can manage webhooks."); };
const view = (w) => ({ webhookId: String(w._id), url: w.url, events: w.events, description: w.description, active: !!w.active, paused: !w.active, pausedReason: w.pausedReason || null, createdAt: w.createdAt, createdBy: w.createdBy, consecutiveFailures: w.consecutiveFailures || 0, lastSuccessAt: w.lastSuccessAt || null, lastFailureAt: w.lastFailureAt || null, chatMetadata: !!w.optIn?.chatMetadata, secretRotatedAt: w.secretRotatedAt || null, previousSecretUntil: w.previousSecretUntil || null });

/** Strip anything that looks like content from an event payload, recursively. */
export function sanitizePayload(v, depth = 0) {
  if (depth > 6) return null; if (Array.isArray(v)) return v.slice(0, 100).map((x) => sanitizePayload(x, depth + 1));
  if (v && typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) { if (CONTENT_KEYS.test(k)) continue; o[k] = sanitizePayload(x, depth + 1); } return o; }
  return typeof v === "string" ? v.slice(0, 500) : v;
}
/** Pure: the signature header value for a payload. Receivers verify v1 over `${t}.${body}`. */
export function signHeader({ secrets, body, ts }) { return `t=${ts},` + secrets.map((s) => `v1=${createHmac("sha256", s).update(`${ts}.${body}`).digest("hex")}`).join(","); }

export async function createWebhook({ orgId, membership, actorEmail, url, events, description = "", chatMetadata = false }) {
  mustManage(membership); const { hooks } = await cols();
  try { assertWebhookUrl(url); } catch (e) { fail(400, e.message); }
  const list = Array.isArray(events) ? [...new Set(events)] : []; if (!list.length || list.some((e) => e !== "*" && !EVENT_TYPES.includes(e))) fail(400, `events must be drawn from: ${EVENT_TYPES.join(", ")} (or "*").`);
  if (list.includes("chat.metadata") && !chatMetadata) fail(400, "chat.metadata is delivered only when you explicitly opt in (chatMetadata: true). Chat events carry sender, conversation and time, never message content.");
  if (!isIntegrationCryptoConfigured()) fail(503, "INTEGRATION_ENCRYPTION_KEY is not configured on this server.");
  if ((await hooks.countDocuments({ orgId: toObjectId(orgId), deletedAt: null })) >= 20) fail(409, "At most 20 webhooks per organization.");
  const secret = `whsec_${randomBytes(24).toString("hex")}`;
  const doc = { _id: new ObjectId(), orgId: toObjectId(orgId), url, events: list, description: String(description).slice(0, 200), secretEncrypted: encryptIntegrationSecret(secret), active: true, optIn: { chatMetadata: !!chatMetadata }, createdBy: actorEmail, createdAt: nowIso(), consecutiveFailures: 0, deletedAt: null };
  await hooks.insertOne(doc); await logOrgActivity({ orgId, recordType: "WEBHOOK", recordId: doc._id, actorEmail, action: "CREATED", previousState: null, newState: null, metadata: { events: list, host: new URL(url).host } }).catch(() => {});
  return { webhook: view(doc), secret, note: "Save the signing secret now: it is shown once." };
}
export async function listWebhooks({ orgId, membership }) { mustManage(membership); const { hooks } = await cols(); return { webhooks: (await hooks.find({ orgId: toObjectId(orgId), deletedAt: null }).sort({ createdAt: -1 }).limit(100).toArray()).map(view), events: EVENT_TYPES }; }
async function ownHook({ orgId, membership, webhookId }) { mustManage(membership); const { hooks } = await cols(); if (!/^[0-9a-f]{24}$/.test(String(webhookId))) fail(404, "Webhook not found."); const w = await hooks.findOne({ _id: new ObjectId(webhookId), orgId: toObjectId(orgId), deletedAt: null }); if (!w) fail(404, "Webhook not found."); return { w, hooks }; }
export async function updateWebhook({ orgId, membership, actorEmail, webhookId, url, events, description }) {
  const { w, hooks } = await ownHook({ orgId, membership, webhookId }); const set = {};
  if (url !== undefined) { try { assertWebhookUrl(url); } catch (e) { fail(400, e.message); } set.url = url; }
  if (events !== undefined) { if (!Array.isArray(events) || !events.length || events.some((e) => e !== "*" && !EVENT_TYPES.includes(e))) fail(400, "events is not valid."); if (events.includes("chat.metadata") && !w.optIn?.chatMetadata) fail(400, "chat.metadata needs the explicit opt-in set when the webhook was created."); set.events = [...new Set(events)]; }
  if (description !== undefined) set.description = String(description).slice(0, 200);
  await hooks.updateOne({ _id: w._id }, { $set: set }); await logOrgActivity({ orgId, recordType: "WEBHOOK", recordId: w._id, actorEmail, action: "UPDATED", previousState: null, newState: null, metadata: { fields: Object.keys(set) } }).catch(() => {}); return view(await hooks.findOne({ _id: w._id }));
}
export async function setPaused({ orgId, membership, actorEmail, webhookId, paused }) {
  const { w, hooks } = await ownHook({ orgId, membership, webhookId }); await hooks.updateOne({ _id: w._id }, { $set: { active: !paused, ...(paused ? { pausedReason: "Paused by an administrator." } : { consecutiveFailures: 0 }) }, ...(paused ? {} : { $unset: { pausedReason: "" } }) });
  await logOrgActivity({ orgId, recordType: "WEBHOOK", recordId: w._id, actorEmail, action: paused ? "PAUSED" : "RESUMED", previousState: null, newState: null, metadata: {} }).catch(() => {}); return view(await hooks.findOne({ _id: w._id }));
}
/** New secret now; the old one keeps signing alongside it for 24 hours so receivers can switch without losing events. */
export async function rotateSecret({ orgId, membership, actorEmail, webhookId }) {
  const { w, hooks } = await ownHook({ orgId, membership, webhookId }); const secret = `whsec_${randomBytes(24).toString("hex")}`; const until = new Date(Date.now() + ROTATION_GRACE_MS).toISOString();
  await hooks.updateOne({ _id: w._id }, { $set: { secretEncrypted: encryptIntegrationSecret(secret), previousSecretEncrypted: w.secretEncrypted, previousSecretUntil: until, secretRotatedAt: nowIso() } });
  await logOrgActivity({ orgId, recordType: "WEBHOOK", recordId: w._id, actorEmail, action: "SECRET_ROTATED", previousState: null, newState: null, metadata: { previousValidUntil: until } }).catch(() => {}); return { secret, previousSecretValidUntil: until, note: "Save the new secret now. The previous one is also used for signing until the time shown." };
}
export async function deleteWebhook({ orgId, membership, actorEmail, webhookId }) {
  const { w, hooks } = await ownHook({ orgId, membership, webhookId }); await hooks.updateOne({ _id: w._id }, { $set: { deletedAt: nowIso(), active: false } });
  await logOrgActivity({ orgId, recordType: "WEBHOOK", recordId: w._id, actorEmail, action: "DELETED", previousState: null, newState: null, metadata: {} }).catch(() => {}); return { ok: true };
}

// --------------------------------------------------------------------------------------------------------------- emit
/** Queue one delivery per matching, active endpoint. Best effort and idempotent per (endpoint, eventId). Never throws. */
export async function emitWebhookEvent({ orgId, type, data = {}, eventId = null }) {
  try {
    if (!EVENT_TYPES.includes(type)) return { queued: 0 }; const { hooks, deliveries } = await cols();
    const subs = await hooks.find({ orgId: toObjectId(orgId), active: true, deletedAt: null, $or: [{ events: type }, { events: "*" }] }).toArray(); if (!subs.length) return { queued: 0 };
    const id = eventId || new ObjectId().toHexString(); const payload = { id, type, createdAt: nowIso(), organizationId: String(orgId), data: sanitizePayload(data) }; let queued = 0;
    for (const w of subs) { if (OPT_IN.has(type) && !w.optIn?.chatMetadata) continue; if (type === "chat.metadata" && w.events.includes("*") && !w.optIn?.chatMetadata) continue;
      try { await deliveries.insertOne({ _id: new ObjectId(), orgId: toObjectId(orgId), webhookId: w._id, event: type, eventId: id, payload, status: "PENDING", attempts: 0, nextAttemptAt: nowIso(), createdAt: nowIso() }); queued++; } catch (e) { if (e?.code !== 11000) throw e; } }
    return { queued };
  } catch (err) { console.error("webhooks: emit failed (non-fatal):", err?.message); return { queued: 0 }; }
}

// ------------------------------------------------------------------------------------------------------------ delivery
/** One worker pass over due deliveries (cron). `onlyOrgId` narrows it (used by tests and manual "send now"). */
export async function processDeliveries({ limit = 25, onlyOrgId = null, sender = post } = {}) {
  const { hooks, deliveries } = await cols(); let delivered = 0, failed = 0, dead = 0;
  for (let i = 0; i < limit; i++) {
    const q = { status: "PENDING", nextAttemptAt: { $lte: nowIso() } }; if (onlyOrgId) q.orgId = toObjectId(onlyOrgId);
    const r = await deliveries.findOneAndUpdate(q, { $set: { status: "SENDING", lockedAt: nowIso() }, $inc: { attempts: 1 } }, { sort: { nextAttemptAt: 1 }, returnDocument: "after" }); const d = r?.value ?? r; if (!d) break;
    const w = await hooks.findOne({ _id: d.webhookId, orgId: d.orgId });
    const finish = async (ok, err, status) => {
      if (ok) { await deliveries.updateOne({ _id: d._id }, { $set: { status: "DELIVERED", deliveredAt: nowIso(), lastError: null, responseStatus: status } }); if (w) await hooks.updateOne({ _id: w._id }, { $set: { consecutiveFailures: 0, lastSuccessAt: nowIso() } }); delivered++; return; }
      const last = d.attempts >= MAX_ATTEMPTS; await deliveries.updateOne({ _id: d._id }, { $set: { status: last ? "DEAD" : "PENDING", lastError: String(err).slice(0, 200), responseStatus: status ?? null, nextAttemptAt: new Date(Date.now() + BACKOFF_MIN[Math.min(d.attempts - 1, BACKOFF_MIN.length - 1)] * 60_000).toISOString() } });
      if (w) { const upd = await hooks.findOneAndUpdate({ _id: w._id }, { $inc: { consecutiveFailures: 1 }, $set: { lastFailureAt: nowIso() } }, { returnDocument: "after" }); const nw = upd?.value ?? upd; if (nw && nw.consecutiveFailures >= AUTO_PAUSE_AFTER && nw.active) await hooks.updateOne({ _id: w._id }, { $set: { active: false, pausedReason: `Paused automatically after ${AUTO_PAUSE_AFTER} failed deliveries in a row.` } }); }
      if (last) dead++; else failed++;
    };
    if (!w || !w.active || w.deletedAt) { await deliveries.updateOne({ _id: d._id }, { $set: { status: "DEAD", lastError: "The webhook was removed or paused." } }); dead++; continue; }
    try {
      const secrets = [decryptIntegrationSecret(w.secretEncrypted)]; if (w.previousSecretEncrypted && w.previousSecretUntil > nowIso()) secrets.push(decryptIntegrationSecret(w.previousSecretEncrypted));
      const u = assertWebhookUrl(w.url); const body = JSON.stringify(d.payload); const ts = Math.floor(Date.now() / 1000);
      const res = await sender(u, body, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), "user-agent": "InayaWebhooks/1.0", "x-inaya-event": d.event, "x-inaya-delivery-id": String(d._id), "x-inaya-timestamp": String(ts), "x-inaya-signature": signHeader({ secrets, body, ts }) });
      if (res.status >= 200 && res.status < 300) await finish(true, null, res.status); else await finish(false, `The endpoint answered ${res.status}.`, res.status);
    } catch (e) { await finish(false, e.message); }
  }
  return { delivered, failed, dead };
}
const dview = (d) => ({ deliveryId: String(d._id), webhookId: String(d.webhookId), event: d.event, eventId: d.eventId, status: d.status, attempts: d.attempts, lastError: d.lastError || null, responseStatus: d.responseStatus ?? null, createdAt: d.createdAt, nextAttemptAt: d.status === "PENDING" ? d.nextAttemptAt : null, deliveredAt: d.deliveredAt || null });
export async function listDeliveries({ orgId, membership, webhookId = null, status = null, limit = 50 }) {
  mustManage(membership); const { deliveries } = await cols(); const q = { orgId: toObjectId(orgId) }; if (webhookId) q.webhookId = new ObjectId(webhookId); if (status) q.status = status;
  return { deliveries: (await deliveries.find(q).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 50, 200)).project({ payload: 0 }).toArray()).map(dview) };
}
export async function redeliver({ orgId, membership, actorEmail, deliveryId }) {
  mustManage(membership); const { deliveries } = await cols(); const r = await deliveries.findOneAndUpdate({ _id: new ObjectId(deliveryId), orgId: toObjectId(orgId), status: { $in: ["DEAD", "FAILED"] } }, { $set: { status: "PENDING", nextAttemptAt: nowIso(), attempts: 0, lastError: null } }, { returnDocument: "after" });
  if (!(r?.value ?? r)) fail(409, "Only a failed or dead-lettered delivery can be redelivered."); await logOrgActivity({ orgId, recordType: "WEBHOOK", recordId: (r.value ?? r).webhookId, actorEmail, action: "REDELIVERED", previousState: null, newState: null, metadata: { deliveryId } }).catch(() => {}); return { queued: true };
}
/** A synthetic event so an admin can confirm the endpoint and signature handling before real traffic. */
export async function sendTest({ orgId, membership, webhookId, sender }) {
  const { w } = await ownHook({ orgId, membership, webhookId }); const id = `test_${randomBytes(6).toString("hex")}`; const { deliveries } = await cols();
  const payload = { id, type: "webhook.test", createdAt: nowIso(), organizationId: String(orgId), data: { note: "This is a test event from Inaya." } };
  await deliveries.insertOne({ _id: new ObjectId(), orgId: toObjectId(orgId), webhookId: w._id, event: "webhook.test", eventId: id, payload, status: "PENDING", attempts: 0, nextAttemptAt: nowIso(), createdAt: nowIso() });
  const r = await processDeliveries({ limit: 1, onlyOrgId: orgId, sender: sender || post }); return { queued: true, ...r };
}
