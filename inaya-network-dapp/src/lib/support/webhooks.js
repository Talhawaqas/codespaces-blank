// src/lib/support/webhooks.js
//
// SOW §28: outbound support events. A subscription names an https endpoint and the event types it wants.
// Every matching event becomes a durable delivery row (unique per webhook + event, so a retried emit can
// never double-queue), signed with HMAC-SHA256 over `${timestamp}.${body}` and retried with backoff by the
// support worker; after the last attempt it is dead-lettered where an admin can see and redeliver it.
// The endpoint is checked with the same SSRF rules as the workflow HTTP connector (https only, no private,
// loopback or metadata addresses, no redirects, size and time limits) on every attempt.

import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import { toObjectId } from "../orgs.js";
import { getSupportCollections, ensureSupportIndexes } from "./db.js";
import { fail, nowIso, hmacHex, SUPPORT_EVENTS } from "./common.js";
import { isPrivateAddress, localTestHostsAllowed } from "../workflows/http.js";
import { encryptIntegrationSecret, decryptIntegrationSecret, isIntegrationCryptoConfigured } from "../integrationCrypto.js";
import { randomBytes } from "node:crypto";

const MAX_ATTEMPTS = 6;
const BACKOFF_MIN = [1, 5, 15, 60, 240, 720];

export function assertWebhookUrl(raw) {
  let u; try { u = new URL(raw); } catch { throw new Error("The URL is not valid."); }
  const local = localTestHostsAllowed();
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("Only https URLs are allowed.");
  if (u.username || u.password) throw new Error("Credentials must not be embedded in the URL.");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!local) {
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("Local and internal host names are blocked.");
    if (net.isIP(host) && isPrivateAddress(host)) throw new Error("Private, loopback and link-local addresses are blocked.");
    if (["169.254.169.254", "metadata.google.internal"].includes(host)) throw new Error("Cloud metadata endpoints are blocked.");
  }
  return u;
}

function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: 4 }];
    if (!localTestHostsAllowed() && (!list.length || list.some((a) => isPrivateAddress(a.address)))) return cb(Object.assign(new Error("The host resolves to a private address."), { code: "SSRF_BLOCKED" }));
    return options?.all ? cb(null, list) : cb(null, list[0].address, list[0].family);
  });
}

function post(u, body, headers, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request({ protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ""), port: u.port || undefined, path: `${u.pathname}${u.search}`, method: "POST", headers, lookup: safeLookup, timeout: timeoutMs, agent: false }, (res) => {
      let n = 0; res.on("data", (c) => { n += c.length; if (n > 64 * 1024) req.destroy(new Error("Response too large.")); });
      res.on("end", () => resolve({ status: res.statusCode })); res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`Timed out after ${timeoutMs} ms.`)));
    req.on("error", reject); req.write(body); req.end();
  });
}

export async function createWebhook({ orgId, url, events, description = "", actorEmail }) {
  await ensureSupportIndexes();
  try { assertWebhookUrl(url); } catch (e) { return fail(e.message); }
  const list = Array.isArray(events) ? [...new Set(events)] : [];
  if (!list.length || list.some((e) => !SUPPORT_EVENTS.includes(e) && e !== "*")) return fail(`events must be a list drawn from: ${SUPPORT_EVENTS.join(", ")} (or "*").`);
  if (!isIntegrationCryptoConfigured()) return fail("INTEGRATION_ENCRYPTION_KEY is not configured on this server.", 503);
  const { supportWebhooks } = await getSupportCollections();
  if ((await supportWebhooks.countDocuments({ orgId: toObjectId(orgId), active: true })) >= 20) return fail("At most 20 active webhooks per organization.");
  const secret = `whsec_${randomBytes(24).toString("hex")}`;
  const doc = { orgId: toObjectId(orgId), url, events: list, description: String(description).slice(0, 200), secretEncrypted: encryptIntegrationSecret(secret), active: true, createdBy: actorEmail, createdAt: nowIso(), consecutiveFailures: 0 };
  const r = await supportWebhooks.insertOne(doc);
  return { webhook: pub({ ...doc, _id: r.insertedId }), secret, note: "Save the signing secret now: it is shown once." };
}
const pub = (w) => ({ webhookId: String(w._id), url: w.url, events: w.events, description: w.description, active: w.active, createdAt: w.createdAt, createdBy: w.createdBy, consecutiveFailures: w.consecutiveFailures || 0, lastDeliveryAt: w.lastDeliveryAt || null });

export async function listWebhooks({ orgId }) {
  const { supportWebhooks } = await getSupportCollections();
  return { webhooks: (await supportWebhooks.find({ orgId: toObjectId(orgId) }).sort({ createdAt: -1 }).limit(100).toArray()).map(pub) };
}
export async function setWebhookActive({ orgId, webhookId, active }) {
  const { supportWebhooks } = await getSupportCollections();
  let r; try { r = await supportWebhooks.findOneAndUpdate({ _id: toObjectId(webhookId), orgId: toObjectId(orgId) }, { $set: { active: !!active, ...(active ? { consecutiveFailures: 0 } : {}) } }, { returnDocument: "after" }); } catch { r = null; }
  return r ? { webhook: pub(r) } : fail("Webhook not found.", 404);
}
export async function deleteWebhook({ orgId, webhookId }) {
  const { supportWebhooks } = await getSupportCollections();
  let r; try { r = await supportWebhooks.deleteOne({ _id: toObjectId(webhookId), orgId: toObjectId(orgId) }); } catch { r = { deletedCount: 0 }; }
  return r.deletedCount ? { deleted: true } : fail("Webhook not found.", 404);
}
export async function listDeliveries({ orgId, webhookId = null, status = null, limit = 50 }) {
  const { supportWebhookDeliveries } = await getSupportCollections();
  const q = { orgId: toObjectId(orgId) };
  if (webhookId) q.webhookId = toObjectId(webhookId);
  if (status) q.status = status;
  const rows = await supportWebhookDeliveries.find(q).sort({ createdAt: -1 }).limit(Math.min(limit, 200)).project({ payload: 0 }).toArray();
  return { deliveries: rows.map((d) => ({ deliveryId: String(d._id), webhookId: String(d.webhookId), event: d.event, eventId: d.eventId, status: d.status, attempts: d.attempts, lastError: d.lastError || null, nextAttemptAt: d.nextAttemptAt || null, createdAt: d.createdAt, deliveredAt: d.deliveredAt || null })) };
}
export async function redeliver({ orgId, deliveryId }) {
  const { supportWebhookDeliveries } = await getSupportCollections();
  let r; try { r = await supportWebhookDeliveries.findOneAndUpdate({ _id: toObjectId(deliveryId), orgId: toObjectId(orgId), status: { $in: ["DEAD", "FAILED"] } }, { $set: { status: "PENDING", nextAttemptAt: nowIso(), attempts: 0, lastError: null } }, { returnDocument: "after" }); } catch { r = null; }
  return r ? { queued: true } : fail("Only a failed or dead-lettered delivery can be redelivered.", 409);
}

/** Queues one delivery per matching, active webhook. Idempotent per (webhook, eventId). */
export async function enqueueDeliveries({ orgId, event }) {
  const { supportWebhooks, supportWebhookDeliveries } = await getSupportCollections();
  const subs = await supportWebhooks.find({ orgId: toObjectId(orgId), active: true, $or: [{ events: event.type }, { events: "*" }] }).toArray();
  let queued = 0;
  for (const w of subs) {
    try {
      await supportWebhookDeliveries.insertOne({ orgId: toObjectId(orgId), webhookId: w._id, event: event.type, eventId: String(event.id), payload: event, status: "PENDING", attempts: 0, nextAttemptAt: nowIso(), createdAt: nowIso() });
      queued++;
    } catch (err) { if (err?.code !== 11000) throw err; }
  }
  return { queued };
}

/** One worker pass: delivers due rows. Returns counts. */
export async function processDeliveries({ limit = 25 } = {}) {
  const { supportWebhooks, supportWebhookDeliveries } = await getSupportCollections();
  let delivered = 0; let failed = 0; let dead = 0;
  for (let i = 0; i < limit; i++) {
    const d = await supportWebhookDeliveries.findOneAndUpdate({ status: "PENDING", nextAttemptAt: { $lte: nowIso() } }, { $set: { status: "SENDING", lockedAt: nowIso() }, $inc: { attempts: 1 } }, { sort: { nextAttemptAt: 1 }, returnDocument: "after" });
    if (!d) break;
    const w = await supportWebhooks.findOne({ _id: d.webhookId, orgId: d.orgId });
    const finish = async (ok, err, status) => {
      if (ok) { await supportWebhookDeliveries.updateOne({ _id: d._id }, { $set: { status: "DELIVERED", deliveredAt: nowIso(), lastError: null, responseStatus: status } }); if (w) await supportWebhooks.updateOne({ _id: w._id }, { $set: { lastDeliveryAt: nowIso(), consecutiveFailures: 0 } }); delivered++; return; }
      const last = d.attempts >= MAX_ATTEMPTS;
      await supportWebhookDeliveries.updateOne({ _id: d._id }, { $set: { status: last ? "DEAD" : "PENDING", lastError: String(err).slice(0, 200), nextAttemptAt: new Date(Date.now() + BACKOFF_MIN[Math.min(d.attempts - 1, BACKOFF_MIN.length - 1)] * 60000).toISOString() } });
      if (w) await supportWebhooks.updateOne({ _id: w._id }, { $inc: { consecutiveFailures: 1 } });
      if (last) dead++; else failed++;
    };
    if (!w || !w.active) { await supportWebhookDeliveries.updateOne({ _id: d._id }, { $set: { status: "DEAD", lastError: "The webhook was removed or disabled." } }); dead++; continue; }
    let secret; try { secret = decryptIntegrationSecret(w.secretEncrypted); } catch { await finish(false, "The signing secret could not be read."); continue; }
    try {
      const u = assertWebhookUrl(w.url);
      const body = JSON.stringify(d.payload);
      const ts = Math.floor(Date.now() / 1000);
      const res = await post(u, body, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), "user-agent": "InayaSupport/1.0", "x-inaya-event": d.event, "x-inaya-delivery-id": String(d._id), "x-inaya-timestamp": String(ts), "x-inaya-signature": `v1=${hmacHex(secret, `${ts}.${body}`)}` });
      if (res.status >= 200 && res.status < 300) await finish(true, null, res.status); else await finish(false, `The endpoint answered ${res.status}.`);
    } catch (e) { await finish(false, e.message); }
  }
  return { delivered, failed, dead };
}
