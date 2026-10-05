// src/lib/chat/common.js
//
// Secure Chat (Competitive Expansion SOW workstream A). Shared constants, validators and the collection accessor for the
// server side of the chat: the MLS Delivery Service + Authentication Service described in
// docs/architecture/e2ee-chat-key-management.md. Nothing in src/lib/chat/** ever sees message plaintext or an MLS secret.

import { randomBytes } from "node:crypto";
import { connectToDatabase } from "../mongodb.js";
import { getOrgCollections, toObjectId } from "../orgs.js";

export const CHAT_SUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";

export const LIMITS = {
  maxCiphertextBytes: 96 * 1024,      // one encrypted message (text + attachment descriptors)
  maxCommitBytes: 512 * 1024,         // a commit with a path for a large group
  maxWelcomeBytes: 512 * 1024,
  maxKeyPackageBytes: 8 * 1024,
  keyPackagesPerUpload: 50,
  keyPackagesPerDevice: 200,
  devicesPerUser: 10,
  maxParticipants: 200,
  maxTitleBytes: 0,                   // titles are encrypted client side; the server never stores one
  typingTtlMs: 6000,
  presenceTtlMs: 90_000,
  longPollMaxMs: 25_000,
  pageSize: 100,
  maxPageSize: 300,
  attachmentMaxBytes: 25 * 1024 * 1024,
  editWindowMs: 24 * 60 * 60 * 1000,
  deleteWindowMs: 7 * 24 * 60 * 60 * 1000,
  messagesPerMinute: 120,
  conversationsPerHour: 40,
  contactRequestsPerHour: 30,
  deviceEnrollsPerDay: 20,
};

export class ChatError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || null; }
}
export const fail = (status, message, code) => { throw new ChatError(status, message, code); };
export const nowIso = () => new Date().toISOString();

export const b64 = {
  enc: (u8) => Buffer.from(u8).toString("base64"),
  dec: (s) => {
    if (typeof s !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(s) || s.length % 4 !== 0) throw new ChatError(400, "Malformed encoded payload.", "BAD_ENCODING");
    return new Uint8Array(Buffer.from(s, "base64"));
  },
};

export const newId = (bytes = 12) => randomBytes(bytes).toString("hex");
export const isId = (s, bytes = 12) => typeof s === "string" && new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(s);
export const normEmail = (e) => String(e || "").trim().toLowerCase();

// ---- MLS credential identity: inaya:v1:<orgId>:<email>:<deviceId> ----
export function deviceIdentity(orgId, email, deviceId) { return `inaya:v1:${String(orgId)}:${normEmail(email)}:${deviceId}`; }
export function parseIdentity(str) {
  const m = /^inaya:v1:([0-9a-f]{24}):([^:\s]+@[^:\s]+):([0-9a-f]{24})$/.exec(String(str || ""));
  return m ? { orgId: m[1], email: m[2], deviceId: m[3] } : null;
}

let indexed = false;
/** All chat collections, with indexes created once per process. */
export async function chatDb() {
  const { db } = await connectToDatabase();
  const c = {
    db,
    conversations: db.collection("chat_conversations"),
    participants: db.collection("chat_participants"),
    messages: db.collection("chat_messages"),
    attachments: db.collection("chat_message_attachments"),
    readStates: db.collection("chat_read_states"),
    presence: db.collection("chat_presence"),
    typing: db.collection("chat_typing"),
    envelopes: db.collection("chat_key_envelopes"),
    devices: db.collection("chat_devices"),
    keyPackages: db.collection("chat_key_packages"),
    securityEvents: db.collection("chat_security_events"),
    deliveries: db.collection("chat_notification_deliveries"),
    contacts: db.collection("chat_contacts"),
    contactRequests: db.collection("chat_contact_requests"),
    contactBlocks: db.collection("chat_contact_blocks"),
    prefs: db.collection("chat_preferences"),
  };
  if (!indexed) {
    await Promise.all([
      c.conversations.createIndex({ orgId: 1, updatedAt: -1 }),
      c.conversations.createIndex({ leaves: 1 }),
      c.conversations.createIndex({ orgId: 1, dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } }),
      c.participants.createIndex({ conversationId: 1, email: 1 }, { unique: true }),
      c.participants.createIndex({ email: 1, status: 1, orgId: 1 }),
      c.messages.createIndex({ conversationId: 1, seq: 1 }, { unique: true }),
      c.messages.createIndex({ conversationId: 1, senderEmail: 1, clientMsgId: 1 }, { unique: true, partialFilterExpression: { clientMsgId: { $type: "string" } } }),
      c.attachments.createIndex({ conversationId: 1, blobId: 1 }, { unique: true }),
      c.readStates.createIndex({ conversationId: 1, email: 1 }, { unique: true }),
      c.presence.createIndex({ orgId: 1, email: 1 }, { unique: true }),
      c.presence.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      c.typing.createIndex({ conversationId: 1, email: 1 }, { unique: true }),
      c.typing.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      c.envelopes.createIndex({ recipientDeviceId: 1, conversationId: 1, epoch: 1 }, { unique: true }),
      c.envelopes.createIndex({ recipientDeviceId: 1, consumedAt: 1 }),
      c.devices.createIndex({ deviceId: 1 }, { unique: true }),
      c.devices.createIndex({ orgId: 1, email: 1, status: 1 }),
      c.keyPackages.createIndex({ deviceId: 1, status: 1, lastResort: 1 }),
      c.keyPackages.createIndex({ refHex: 1 }, { unique: true }),
      c.securityEvents.createIndex({ orgId: 1, createdAt: -1 }),
      c.securityEvents.createIndex({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 }),
      c.deliveries.createIndex({ orgId: 1, email: 1, createdAt: -1 }),
      c.deliveries.createIndex({ createdAt: 1 }, { expireAfterSeconds: 14 * 24 * 3600 }),
      c.contacts.createIndex({ orgId: 1, a: 1, b: 1 }, { unique: true }),
      c.contacts.createIndex({ orgId: 1, b: 1 }),
      c.contactRequests.createIndex({ orgId: 1, from: 1, to: 1, status: 1 }),
      c.contactRequests.createIndex({ to: 1, status: 1 }),
      c.contactBlocks.createIndex({ blocker: 1, blocked: 1 }, { unique: true }),
      c.prefs.createIndex({ orgId: 1, email: 1 }, { unique: true }),
    ]);
    indexed = true;
  }
  return c;
}

/** Records a security-relevant chat event. Metadata only: ids, counts and reason codes, never content or keys. */
export async function recordSecurityEvent({ orgId, email, deviceId = null, conversationId = null, type, detail = null }) {
  try {
    const { securityEvents } = await chatDb();
    await securityEvents.insertOne({ orgId: String(orgId), email: normEmail(email), deviceId, conversationId, type, detail: detail ? String(detail).slice(0, 200) : null, createdAt: new Date() });
    import("../metrics/metrics.js").then((m) => m.metric("chat.security_event", { orgId, label: m.CATALOG["chat.security_event"].labels.includes(type) ? type : "OTHER" })).catch(() => {});
  } catch { /* best effort: never block the caller */ }
}

export { getOrgCollections, toObjectId };
