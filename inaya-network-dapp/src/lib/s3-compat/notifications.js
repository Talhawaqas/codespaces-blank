// S3 event notifications: signed webhook delivery when objects in an organization's buckets change.
//
// A notification config names a bucket, an https endpoint, the events it wants (S3's own names, with
// wildcards) and an optional key prefix/suffix. Each matching change becomes a durable delivery row
// (unique per config + event, so a retried write can never double-queue), signed with HMAC-SHA256 over
// `${timestamp}.${body}` exactly like the support webhooks, retried with backoff by a cron worker, and
// dead-lettered after the last attempt where an admin can see it and redeliver. The endpoint goes through
// the same SSRF rules as every other outbound connector (https only, no private or metadata addresses, no
// redirects, size and time limits), re-checked on EVERY attempt.
//
// The payload is AWS's S3 event shape (Records[0].s3.bucket / .object, eventName without the "s3:" prefix),
// so a consumer written for AWS S3 notifications reads these unchanged. `eventSource` is "inaya:s3" and the
// object key is URL-encoded, as in AWS.
//
// Emitting is best-effort by design: a notification problem must never fail or slow the write that caused it.

import { randomBytes } from "node:crypto";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { assertWebhookUrl, post } from "../support/webhooks.js";
import { hmacHex } from "../support/common.js";
import { encryptIntegrationSecret, decryptIntegrationSecret, isIntegrationCryptoConfigured } from "../integrationCrypto.js";

export const EVENT_NAMES = [
  "s3:ObjectCreated:Put",
  "s3:ObjectCreated:CompleteMultipartUpload",
  "s3:ObjectRemoved:Delete",
  "s3:ObjectRemoved:DeleteMarkerCreated",
  "s3:LifecycleExpiration:Delete",
];
const WILDCARDS = ["s3:*", "s3:ObjectCreated:*", "s3:ObjectRemoved:*", "s3:LifecycleExpiration:*"];

const MAX_ATTEMPTS = 6;
const BACKOFF_MIN = [1, 5, 15, 60, 240, 720];
const MAX_CONFIGS_PER_BUCKET = 10;
const MAX_CONFIGS_PER_ORG = 50;
const nowIso = () => new Date().toISOString();

let indexesEnsured = false;
async function collections() {
  const { db } = await getOrgCollections();
  const configs = db.collection("s3_notification_configs");
  const deliveries = db.collection("s3_notification_deliveries");
  if (!indexesEnsured) {
    await configs.createIndex({ orgId: 1, bucket: 1, active: 1 });
    await deliveries.createIndex({ configId: 1, eventKey: 1 }, { unique: true });
    await deliveries.createIndex({ status: 1, nextAttemptAt: 1 });
    await deliveries.createIndex({ orgId: 1, createdAt: -1 });
    await deliveries.createIndex({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });
    indexesEnsured = true;
  }
  return { configs, deliveries };
}

export function eventMatches(patterns, eventName) {
  return patterns.some((p) => p === eventName || (WILDCARDS.includes(p) && (p === "s3:*" || eventName.startsWith(p.slice(0, -1)))));
}

export function filterMatches(config, key) {
  if (config.prefix && !key.startsWith(config.prefix)) return false;
  if (config.suffix && !key.endsWith(config.suffix)) return false;
  return true;
}

export function buildPayload({ configId, eventName, bucket, key, size = null, etag = null, versionId = null, actor = null, eventTime = nowIso() }) {
  return {
    Records: [{
      eventVersion: "2.1",
      eventSource: "inaya:s3",
      eventTime,
      eventName: eventName.replace(/^s3:/, ""),
      userIdentity: { principalId: actor || "unknown" },
      s3: {
        s3SchemaVersion: "1.0",
        configurationId: String(configId),
        bucket: { name: bucket, arn: `arn:inaya:s3:::${bucket}` },
        object: {
          key: encodeURIComponent(key).replace(/%2F/g, "/"),
          ...(size !== null ? { size } : {}),
          ...(etag ? { eTag: String(etag).replace(/"/g, "") } : {}),
          ...(versionId && versionId !== "null" ? { versionId } : {}),
          sequencer: Date.parse(eventTime).toString(16).toUpperCase(),
        },
      },
    }],
  };
}

const fail = (error, status = 400) => ({ error, status });
const pub = (c) => ({ configId: String(c._id), bucket: c.bucket, url: c.url, events: c.events, prefix: c.prefix || "", suffix: c.suffix || "", active: c.active, consecutiveFailures: c.consecutiveFailures || 0, createdAt: c.createdAt, createdBy: c.createdBy });

export async function createNotificationConfig({ orgId, bucket, url, events, prefix = "", suffix = "", actorEmail }) {
  if (!bucket || typeof bucket !== "string") return fail("bucket is required.");
  try { assertWebhookUrl(url); } catch (e) { return fail(e.message); }
  const list = Array.isArray(events) ? [...new Set(events)] : [];
  if (!list.length || list.some((e) => !EVENT_NAMES.includes(e) && !WILDCARDS.includes(e))) {
    return fail(`events must be a list drawn from: ${[...WILDCARDS, ...EVENT_NAMES].join(", ")}.`);
  }
  if (String(prefix).length > 1024 || String(suffix).length > 1024) return fail("prefix and suffix are limited to 1024 characters.");
  if (!isIntegrationCryptoConfigured()) return fail("INTEGRATION_ENCRYPTION_KEY is not configured on this server.", 503);

  const { configs } = await collections();
  const orgObjectId = toObjectId(orgId);
  if ((await configs.countDocuments({ orgId: orgObjectId, bucket, active: true })) >= MAX_CONFIGS_PER_BUCKET) return fail(`At most ${MAX_CONFIGS_PER_BUCKET} active notifications per bucket.`);
  if ((await configs.countDocuments({ orgId: orgObjectId, active: true })) >= MAX_CONFIGS_PER_ORG) return fail(`At most ${MAX_CONFIGS_PER_ORG} active notifications per organization.`);

  const secret = `whsec_${randomBytes(24).toString("hex")}`;
  const doc = { orgId: orgObjectId, bucket, url, events: list, prefix: String(prefix), suffix: String(suffix), secretEncrypted: encryptIntegrationSecret(secret), active: true, consecutiveFailures: 0, createdAt: nowIso(), createdBy: actorEmail || null };
  const { insertedId } = await configs.insertOne(doc);
  return { notification: pub({ ...doc, _id: insertedId }), secret, note: "Save the signing secret now: it is shown once." };
}

export async function listNotificationConfigs({ orgId, bucket = null }) {
  const { configs } = await collections();
  const q = { orgId: toObjectId(orgId), ...(bucket ? { bucket } : {}) };
  return { notifications: (await configs.find(q).sort({ createdAt: -1 }).limit(200).toArray()).map(pub) };
}

export async function setNotificationActive({ orgId, configId, active }) {
  const { configs } = await collections();
  let r;
  try { r = await configs.findOneAndUpdate({ _id: toObjectId(configId), orgId: toObjectId(orgId) }, { $set: { active: !!active, ...(active ? { consecutiveFailures: 0 } : {}) } }, { returnDocument: "after" }); } catch { r = null; }
  return r ? { notification: pub(r) } : fail("Notification not found.", 404);
}

export async function deleteNotificationConfig({ orgId, configId }) {
  const { configs } = await collections();
  let r;
  try { r = await configs.deleteOne({ _id: toObjectId(configId), orgId: toObjectId(orgId) }); } catch { r = { deletedCount: 0 }; }
  return r.deletedCount ? { deleted: true } : fail("Notification not found.", 404);
}

export async function listNotificationDeliveries({ orgId, configId = null, status = null, limit = 50 }) {
  const { deliveries } = await collections();
  const q = { orgId: toObjectId(orgId), ...(configId ? { configId: toObjectId(configId) } : {}), ...(status ? { status } : {}) };
  const rows = await deliveries.find(q).sort({ createdAt: -1 }).limit(Math.min(limit, 200)).project({ payload: 0 }).toArray();
  return { deliveries: rows.map((d) => ({ deliveryId: String(d._id), configId: String(d.configId), event: d.event, bucket: d.bucket, key: d.key, status: d.status, attempts: d.attempts, lastError: d.lastError || null, responseStatus: d.responseStatus ?? null, createdAt: d.createdAt, deliveredAt: d.deliveredAt || null, nextAttemptAt: d.status === "PENDING" ? d.nextAttemptAt : null })) };
}

export async function redeliverNotification({ orgId, deliveryId }) {
  const { deliveries } = await collections();
  let r;
  try { r = await deliveries.findOneAndUpdate({ _id: toObjectId(deliveryId), orgId: toObjectId(orgId), status: { $in: ["DEAD", "FAILED"] } }, { $set: { status: "PENDING", attempts: 0, nextAttemptAt: nowIso(), lastError: null } }); } catch { r = null; }
  return r ? { queued: true } : fail("Only a failed or dead-lettered delivery can be redelivered.", 409);
}

/** Queues a delivery for every matching active config. Never throws: a notification problem must not break the write. */
export async function emitObjectEvent({ orgId, bucket, key, eventName, eventKey, size = null, etag = null, versionId = null, actorEmail = null }) {
  try {
    const { configs, deliveries } = await collections();
    const subs = await configs.find({ orgId: toObjectId(orgId), bucket, active: true }).toArray();
    let queued = 0;
    for (const c of subs) {
      if (!eventMatches(c.events, eventName) || !filterMatches(c, key)) continue;
      try {
        await deliveries.insertOne({
          orgId: toObjectId(orgId), configId: c._id, bucket, key, event: eventName, eventKey: `${eventName}:${eventKey}`,
          payload: buildPayload({ configId: c._id, eventName, bucket, key, size, etag, versionId, actor: actorEmail }),
          status: "PENDING", attempts: 0, nextAttemptAt: nowIso(), createdAt: nowIso(),
        });
        queued += 1;
      } catch (err) { if (err?.code !== 11000) throw err; }
    }
    return { queued };
  } catch (err) {
    console.error("s3 notifications: emit failed (non-fatal):", err.message);
    return { queued: 0, error: err.message };
  }
}

async function send(config, deliveryId, event, payload) {
  const secret = decryptIntegrationSecret(config.secretEncrypted);
  const u = assertWebhookUrl(config.url);
  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  return post(u, body, {
    "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), "user-agent": "InayaS3Notifications/1.0",
    "x-inaya-event": event, "x-inaya-delivery-id": String(deliveryId), "x-inaya-timestamp": String(ts), "x-inaya-signature": `v1=${hmacHex(secret, `${ts}.${body}`)}`,
  });
}

/** Sends one synthetic event so an admin can confirm the endpoint and signature handling before real traffic. */
export async function sendTestNotification({ orgId, configId }) {
  const { configs } = await collections();
  let config;
  try { config = await configs.findOne({ _id: toObjectId(configId), orgId: toObjectId(orgId) }); } catch { config = null; }
  if (!config) return fail("Notification not found.", 404);
  try {
    const res = await send(config, "test", "s3:TestEvent", { Service: "Inaya S3", Event: "s3:TestEvent", Time: nowIso(), Bucket: config.bucket, configurationId: String(config._id) });
    return res.status >= 200 && res.status < 300 ? { ok: true, status: res.status } : { ok: false, status: res.status, error: `The endpoint answered ${res.status}.` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** One worker pass: delivers due rows with backoff, dead-letters after MAX_ATTEMPTS. */
export async function processNotificationDeliveries({ limit = 25 } = {}) {
  const { configs, deliveries } = await collections();
  let delivered = 0; let failed = 0; let dead = 0;
  for (let i = 0; i < limit; i++) {
    const d = await deliveries.findOneAndUpdate(
      { status: "PENDING", nextAttemptAt: { $lte: nowIso() } },
      { $set: { status: "SENDING", lockedAt: nowIso() }, $inc: { attempts: 1 } },
      { sort: { nextAttemptAt: 1 }, returnDocument: "after" }
    );
    if (!d) break;
    const config = await configs.findOne({ _id: d.configId, orgId: d.orgId });

    const finish = async (ok, err, status) => {
      if (ok) {
        await deliveries.updateOne({ _id: d._id }, { $set: { status: "DELIVERED", deliveredAt: nowIso(), lastError: null, responseStatus: status } });
        if (config?.consecutiveFailures) await configs.updateOne({ _id: config._id }, { $set: { consecutiveFailures: 0 } });
        delivered++; return;
      }
      const last = d.attempts >= MAX_ATTEMPTS;
      await deliveries.updateOne({ _id: d._id }, { $set: { status: last ? "DEAD" : "PENDING", lastError: String(err).slice(0, 200), responseStatus: status ?? null, nextAttemptAt: new Date(Date.now() + (BACKOFF_MIN[Math.min(d.attempts - 1, BACKOFF_MIN.length - 1)]) * 60_000).toISOString() } });
      if (config) await configs.updateOne({ _id: config._id }, { $inc: { consecutiveFailures: 1 } });
      if (last) dead++; else failed++;
    };

    if (!config || !config.active) {
      await deliveries.updateOne({ _id: d._id }, { $set: { status: "DEAD", lastError: "The notification was removed or disabled." } });
      dead++; continue;
    }
    try {
      const res = await send(config, d._id, d.event, d.payload);
      if (res.status >= 200 && res.status < 300) await finish(true, null, res.status);
      else await finish(false, `The endpoint answered ${res.status}.`, res.status);
    } catch (e) {
      await finish(false, e.message);
    }
  }
  return { delivered, failed, dead };
}
