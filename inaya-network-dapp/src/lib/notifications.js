// src/lib/notifications.js
//
// Enterprise OS SOW, Phase 3 — unified notifications. Confirmed before
// writing this: the only existing "notifications" are GET
// /api/notifications, computed on-read from referral_rewards +
// kyc_identities with no DB collection and no server-side read-state
// (unread tracked in localStorage), and GET /api/orgs/pending-approvals,
// a separate feed purpose-built for the desktop app's tray notifications.
// Neither is a general system. This is: one real collection, real
// read-state, one schema for both org-scoped and wallet-scoped
// notifications — `scope` tells a reader which of the two other targeting
// fields (orgId+targetEmail, or walletAddress) applies.
//
// Idempotent by design (createNotification upserts on dedupeKey, same
// discipline as ai-action-requests.js's idempotencyKey) so a write-hook
// can be called from a retried request or an overlapping cron run without
// spamming duplicate notifications.

import { connectToDatabase } from "./mongodb.js";
import { toObjectId } from "./orgs.js";

async function getNotificationCollections() {
  const { db } = await connectToDatabase();
  return {
    notifications: db.collection("notifications"),
    notificationReads: db.collection("notification_reads"),
  };
}

let indexesEnsured = false;

export async function ensureNotificationIndexes() {
  if (indexesEnsured) return;
  const { notifications, notificationReads } = await getNotificationCollections();
  await Promise.all([
    notifications.createIndex({ dedupeKey: 1 }, { unique: true }),
    notifications.createIndex({ scope: 1, orgId: 1, targetEmail: 1, createdAt: -1 }),
    notifications.createIndex({ scope: 1, walletAddress: 1, createdAt: -1 }),
    notificationReads.createIndex({ notificationId: 1, readerKey: 1 }, { unique: true }),
  ]);
  indexesEnsured = true;
}

export const NOTIFICATION_CATEGORIES = ["security", "approval", "ai", "data", "business", "web3", "system"];

/** Idempotent on dedupeKey — a repeat call with the same key upserts into
 *  the existing notification instead of creating a duplicate (matches
 *  ai-action-requests.js's idempotencyKey discipline). Callers that don't
 *  have a natural dedupe boundary should build one from stable inputs
 *  (e.g. `${orgId}:ai_action_proposed:${requestId}`), not a timestamp. */
export async function createNotification({
  scope, // "org" | "wallet"
  orgId,
  targetEmail, // null = every current member of orgId (org scope only)
  walletAddress,
  category,
  severity = "info", // "info" | "warning" | "critical"
  type,
  title,
  body,
  sourceModule,
  sourceId,
  actionUrl,
  metadata,
  dedupeKey,
}) {
  if (scope !== "org" && scope !== "wallet") throw new Error('createNotification: scope must be "org" or "wallet".');
  if (!dedupeKey) throw new Error("createNotification: dedupeKey is required.");
  await ensureNotificationIndexes();
  const { notifications } = await getNotificationCollections();

  const doc = {
    scope,
    orgId: orgId ? toObjectId(orgId) : null,
    targetEmail: targetEmail || null,
    walletAddress: walletAddress ? walletAddress.toLowerCase() : null,
    category,
    severity,
    type,
    title,
    body,
    sourceModule: sourceModule || null,
    sourceId: sourceId != null ? String(sourceId) : null,
    actionUrl: actionUrl || null,
    metadata: metadata || {},
    dedupeKey,
    createdAt: new Date().toISOString(),
  };

  const result = await notifications.findOneAndUpdate(
    { dedupeKey },
    { $setOnInsert: doc },
    { upsert: true, returnDocument: "after" }
  );
  return result;
}

function readerKeyFor({ scope, email, walletAddress }) {
  return scope === "org" ? email : walletAddress.toLowerCase();
}

/** listNotificationsFor({scope:"org", orgId, email, unreadOnly, limit}) or
 *  listNotificationsFor({scope:"wallet", walletAddress, unreadOnly, limit}).
 *  Org scope returns both org-wide (targetEmail:null) and this member's own
 *  targeted notifications. */
export async function listNotificationsFor({ scope, orgId, email, walletAddress, unreadOnly = false, limit = 50 }) {
  const { notifications, notificationReads } = await getNotificationCollections();
  const filter =
    scope === "org"
      ? { scope: "org", orgId: toObjectId(orgId), $or: [{ targetEmail: null }, { targetEmail: email }] }
      : { scope: "wallet", walletAddress: walletAddress.toLowerCase() };

  const items = await notifications.find(filter).sort({ createdAt: -1 }).limit(limit).toArray();
  if (items.length === 0) return [];

  const readerKey = readerKeyFor({ scope, email, walletAddress });
  const reads = await notificationReads
    .find({ notificationId: { $in: items.map((n) => n._id) }, readerKey })
    .toArray();
  const readIds = new Set(reads.map((r) => r.notificationId.toString()));

  const withReadState = items.map((n) => ({ ...n, read: readIds.has(n._id.toString()) }));
  return unreadOnly ? withReadState.filter((n) => !n.read) : withReadState;
}

export async function markRead({ scope, orgId, email, walletAddress, notificationId }) {
  await ensureNotificationIndexes();
  const { notificationReads } = await getNotificationCollections();
  const readerKey = readerKeyFor({ scope, email, walletAddress });
  await notificationReads.updateOne(
    { notificationId: toObjectId(notificationId), readerKey },
    { $setOnInsert: { notificationId: toObjectId(notificationId), readerKey, readAt: new Date().toISOString() } },
    { upsert: true }
  );
}

export async function markAllRead({ scope, orgId, email, walletAddress }) {
  const unread = await listNotificationsFor({ scope, orgId, email, walletAddress, unreadOnly: true, limit: 200 });
  if (unread.length === 0) return { markedCount: 0 };

  await ensureNotificationIndexes();
  const { notificationReads } = await getNotificationCollections();
  const readerKey = readerKeyFor({ scope, email, walletAddress });
  const now = new Date().toISOString();
  await notificationReads.bulkWrite(
    unread.map((n) => ({
      updateOne: {
        filter: { notificationId: n._id, readerKey },
        update: { $setOnInsert: { notificationId: n._id, readerKey, readAt: now } },
        upsert: true,
      },
    }))
  );
  return { markedCount: unread.length };
}
