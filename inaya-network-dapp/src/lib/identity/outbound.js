// src/lib/identity/outbound.js
//
// SOW §22: events Inaya SENDS to an organization's automation (Rewst trigger, an RMM, any HTTPS receiver):
//   organization.mapping_changed   sync.failed   sync.drift_detected   access.revoked   credential.revoked
// Each event is small and carries no secrets: id, type, version, occurredAt, organization, external tenant (when known), subject, correlation id,
// and a minimal `data` object. Delivery is signed exactly like the inbound webhooks (X-Inaya-Timestamp + X-Inaya-Signature: v1=HMAC-SHA256 of
// "<timestamp>.<raw body>"), goes only to https URLs that pass the same SSRF guard as the support webhooks, is queued and retried with backoff by
// the worker, and is idempotent per (subscription, event id). Inbound identity events (user.*) travel the other way, through /webhooks/:provider.

import { randomBytes } from "node:crypto";
import { toObjectId } from "../orgs.js";
import { encryptIntegrationSecret, decryptIntegrationSecret, isIntegrationCryptoConfigured } from "../integrationCrypto.js";
import { assertWebhookUrl, post } from "../support/webhooks.js";
import { getIdentityCollections, ensureIdentityIndexes } from "./db.js";
import { fail, nowIso, hmacHex } from "./common.js";

export const OUTBOUND_EVENTS = ["organization.mapping_changed", "sync.failed", "sync.drift_detected", "access.revoked", "credential.revoked"];
const MAX_ATTEMPTS = 6; const BACKOFF_MIN = [1, 5, 15, 60, 240, 720];
const oidOf = (id) => { try { return toObjectId(id); } catch { return null; } };
const pub = (w) => ({ webhookId: String(w._id), url: w.url, events: w.events, description: w.description, active: w.active, createdAt: w.createdAt, createdBy: w.createdBy, consecutiveFailures: w.consecutiveFailures || 0, lastDeliveryAt: w.lastDeliveryAt || null });

export async function createSubscription({ orgId, url, events, description = "", actorEmail }) {
  await ensureIdentityIndexes();
  try { assertWebhookUrl(url); } catch (e) { return fail(e.message); }
  const list = Array.isArray(events) ? [...new Set(events)] : [];
  if (!list.length || list.some((e) => !OUTBOUND_EVENTS.includes(e) && e !== "*")) return fail(`events must be a list drawn from: ${OUTBOUND_EVENTS.join(", ")} (or "*").`);
  if (!isIntegrationCryptoConfigured()) return fail("INTEGRATION_ENCRYPTION_KEY is not configured on this server.", 503);
  const { identityWebhooks } = await getIdentityCollections();
  if ((await identityWebhooks.countDocuments({ orgId: toObjectId(orgId), active: true })) >= 10) return fail("At most 10 active identity webhooks per organization.");
  const secret = `whsec_${randomBytes(24).toString("hex")}`;
  const doc = { orgId: toObjectId(orgId), url, events: list, description: String(description).slice(0, 200), secretEncrypted: encryptIntegrationSecret(secret), active: true, createdBy: actorEmail, createdAt: nowIso(), consecutiveFailures: 0 };
  doc._id = (await identityWebhooks.insertOne(doc)).insertedId;
  return { webhook: pub(doc), secret, note: "Save the signing secret now: it is shown once." };
}
export async function listSubscriptions({ orgId }) {
  const { identityWebhooks } = await getIdentityCollections();
  return { webhooks: (await identityWebhooks.find({ orgId: toObjectId(orgId) }).sort({ createdAt: -1 }).limit(50).toArray()).map(pub) };
}
export async function deleteSubscription({ orgId, webhookId }) {
  const id = oidOf(webhookId); const { identityWebhooks } = await getIdentityCollections();
  const r = id ? await identityWebhooks.deleteOne({ _id: id, orgId: toObjectId(orgId) }) : { deletedCount: 0 };
  return r.deletedCount ? { deleted: true } : fail("Webhook not found.", 404);
}
export async function listDeliveries({ orgId, status = null, limit = 50 }) {
  const { identityDeliveries } = await getIdentityCollections();
  const q = { orgId: toObjectId(orgId) }; if (status) q.status = status;
  const rows = await identityDeliveries.find(q).sort({ createdAt: -1 }).limit(Math.min(200, limit)).project({ payload: 0 }).toArray();
  return { deliveries: rows.map((d) => ({ deliveryId: String(d._id), webhookId: String(d.webhookId), event: d.event, eventId: d.eventId, status: d.status, attempts: d.attempts, lastError: d.lastError || null, nextAttemptAt: d.nextAttemptAt, deliveredAt: d.deliveredAt || null })) };
}

/** Records and queues an event for every matching active subscription. Never throws (an outbound problem must not fail the change that caused it). */
export async function emitIdentityEvent({ orgId, type, tenant = null, subject = null, correlationId = null, data = {}, eventId = null }) {
  try {
    if (!OUTBOUND_EVENTS.includes(type)) return { queued: 0 };
    const { identityWebhooks, identityDeliveries } = await getIdentityCollections();
    const subs = await identityWebhooks.find({ orgId: toObjectId(orgId), active: true, $or: [{ events: type }, { events: "*" }] }).toArray();
    if (!subs.length) return { queued: 0 };
    const payload = { id: eventId || `ide_${randomBytes(10).toString("hex")}`, type, version: 1, occurredAt: nowIso(), organizationId: String(orgId), externalTenant: tenant, subject, correlationId, data };
    let queued = 0;
    for (const w of subs) {
      try { await identityDeliveries.insertOne({ orgId: toObjectId(orgId), webhookId: w._id, event: type, eventId: payload.id, payload, status: "PENDING", attempts: 0, nextAttemptAt: nowIso(), createdAt: new Date() }); queued++; }
      catch (e) { if (e?.code !== 11000) throw e; }
    }
    return { queued };
  } catch (e) { console.error("identity outbound emit failed (non-fatal):", e.message); return { queued: 0 }; }
}

/** One delivery pass. `orgId` narrows it (tests, operator "deliver now"). */
export async function processDeliveries({ limit = 25, orgId = null } = {}) {
  const { identityWebhooks, identityDeliveries } = await getIdentityCollections();
  const out = { delivered: 0, failed: 0, dead: 0 };
  for (let i = 0; i < limit; i++) {
    const q = { status: "PENDING", nextAttemptAt: { $lte: nowIso() } }; if (orgId) q.orgId = toObjectId(orgId);
    const d = await identityDeliveries.findOneAndUpdate(q, { $set: { status: "SENDING", lockedAt: nowIso() }, $inc: { attempts: 1 } }, { sort: { nextAttemptAt: 1 }, returnDocument: "after" });
    const doc = d?.value ?? d; if (!doc || !doc.eventId) break;
    const w = await identityWebhooks.findOne({ _id: doc.webhookId, orgId: doc.orgId });
    const finish = async (ok, err, status) => {
      if (ok) { await identityDeliveries.updateOne({ _id: doc._id }, { $set: { status: "DELIVERED", deliveredAt: nowIso(), lastError: null, responseStatus: status } }); if (w) await identityWebhooks.updateOne({ _id: w._id }, { $set: { lastDeliveryAt: nowIso(), consecutiveFailures: 0 } }); out.delivered++; return; }
      const last = doc.attempts >= MAX_ATTEMPTS;
      await identityDeliveries.updateOne({ _id: doc._id }, { $set: { status: last ? "DEAD" : "PENDING", lastError: String(err).slice(0, 200), nextAttemptAt: new Date(Date.now() + BACKOFF_MIN[Math.min(doc.attempts - 1, BACKOFF_MIN.length - 1)] * 60000).toISOString() } });
      if (w) await identityWebhooks.updateOne({ _id: w._id }, { $inc: { consecutiveFailures: 1 } });
      if (last) out.dead++; else out.failed++;
    };
    if (!w || !w.active) { await identityDeliveries.updateOne({ _id: doc._id }, { $set: { status: "DEAD", lastError: "The webhook was removed or disabled." } }); out.dead++; continue; }
    let secret; try { secret = decryptIntegrationSecret(w.secretEncrypted); } catch { await finish(false, "The signing secret could not be read."); continue; }
    try {
      const u = assertWebhookUrl(w.url); const body = JSON.stringify(doc.payload); const ts = Math.floor(Date.now() / 1000);
      const res = await post(u, body, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), "user-agent": "InayaIdentity/1.0", "x-inaya-event": doc.event, "x-inaya-delivery-id": String(doc._id), "x-inaya-timestamp": String(ts), "x-inaya-signature": `v1=${hmacHex(secret, `${ts}.${body}`)}` });
      if (res.status >= 200 && res.status < 300) await finish(true, null, res.status); else await finish(false, `The endpoint answered ${res.status}.`);
    } catch (e) { await finish(false, e.message); }
  }
  return out;
}
