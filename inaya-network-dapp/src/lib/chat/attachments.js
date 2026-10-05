// src/lib/chat/attachments.js
//
// Encrypted attachment blobs for chat (SOW A5). The client encrypts a file with a fresh 256-bit key BEFORE upload and sends
// the ciphertext in parts small enough for the platform's per-request limit; the key, nonce, name, type and ciphertext hash
// travel only inside the end-to-end encrypted message. The server stores opaque bytes tied to
// (conversation, uploader) and serves them only to people who are active participants and who joined before the upload.
// Files that already live in Inaya are NOT copied: the message carries a document reference and the document's own
// permission checks apply when the recipient opens it (see docs/architecture/e2ee-chat-key-management.md section 5).

import { Binary } from "mongodb";
import { slidingWindowCheck } from "../rateLimit.js";
import { logOrgActivity } from "../org-activity-log.js";
import { LIMITS, chatDb, fail, isId, newId, nowIso, normEmail } from "./common.js";
import { assertAccess } from "./conversations.js";

export const PART_BYTES = 1536 * 1024;           // ciphertext bytes per request part
const MAX_PARTS = Math.ceil(LIMITS.attachmentMaxBytes / PART_BYTES) + 1;

async function parts() { const { db } = await chatDb(); const c = db.collection("chat_blob_parts"); await c.createIndex({ blobId: 1, index: 1 }, { unique: true }); return c; }

export async function beginAttachment({ orgId, email, conversationId, size, partCount }) {
  const { conv } = await assertAccess({ orgId, email, conversationId, statuses: ["active"] });
  if (conv.status !== "active") fail(404, "Conversation not found.");
  if (!Number.isInteger(size) || size < 1 || size > LIMITS.attachmentMaxBytes + 1024) fail(413, `Attachments can be at most ${Math.floor(LIMITS.attachmentMaxBytes / 1048576)} MB.`, "TOO_LARGE");
  if (!Number.isInteger(partCount) || partCount < 1 || partCount > MAX_PARTS || partCount < Math.ceil(size / PART_BYTES)) fail(400, "Invalid part count.");
  const rl = await slidingWindowCheck({ action: "chat:attach", key: `${orgId}:${normEmail(email)}`, max: 60, windowMs: 3600_000 });
  if (!rl.allowed) fail(429, "Too many uploads. Try again later.", "RATE_LIMITED");
  const { attachments } = await chatDb();
  const blobId = newId(12);
  await attachments.insertOne({ conversationId, blobId, orgId: conv.orgId, uploaderEmail: normEmail(email), size, partCount, received: 0, status: "uploading", createdAt: nowIso(), purged: false });
  return { blobId, partBytes: PART_BYTES };
}

export async function uploadPart({ orgId, email, conversationId, blobId, index, data }) {
  await assertAccess({ orgId, email, conversationId, statuses: ["active"] });
  if (!isId(blobId, 12)) fail(404, "Attachment not found.");
  const { attachments } = await chatDb();
  const att = await attachments.findOne({ conversationId, blobId, uploaderEmail: normEmail(email), status: "uploading", purged: false });
  if (!att) fail(404, "Attachment not found.");
  if (!Number.isInteger(index) || index < 0 || index >= att.partCount) fail(400, "Invalid part index.");
  if (typeof data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) fail(400, "Malformed part.", "BAD_ENCODING");
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > PART_BYTES + 64 || bytes.length < 1) fail(413, "Part too large.", "TOO_LARGE");
  const col = await parts();
  try { await col.insertOne({ blobId, conversationId, index, data: new Binary(bytes), createdAt: new Date() }); }
  catch (err) { if (err?.code === 11000) return { index, duplicate: true }; throw err; }
  await attachments.updateOne({ _id: att._id }, { $inc: { received: 1 } });
  return { index };
}

export async function completeAttachment({ orgId, email, conversationId, blobId }) {
  const { conv } = await assertAccess({ orgId, email, conversationId, statuses: ["active"] });
  const { attachments } = await chatDb();
  const att = await attachments.findOne({ conversationId, blobId, uploaderEmail: normEmail(email), purged: false });
  if (!att) fail(404, "Attachment not found.");
  const col = await parts();
  const have = await col.countDocuments({ blobId });
  if (have !== att.partCount) fail(409, `Upload incomplete: ${have} of ${att.partCount} parts received.`, "INCOMPLETE");
  const agg = await col.aggregate([{ $match: { blobId } }, { $group: { _id: null, bytes: { $sum: { $binarySize: "$data" } } } }]).toArray();
  if (agg[0]?.bytes !== att.size) fail(409, "The uploaded size does not match.", "SIZE_MISMATCH");
  await attachments.updateOne({ _id: att._id }, { $set: { status: "ready", completedAt: nowIso() } });
  await logOrgActivity({ orgId: conv.orgId, recordType: "CHAT_ATTACHMENT", recordId: att._id, actorEmail: email, action: "UPLOADED", previousState: null, newState: null, metadata: { size: att.size } });
  return { blobId, size: att.size, partCount: att.partCount };
}

/** Participants only, and only for blobs uploaded after they joined (no history for newcomers). */
export async function readPart({ orgId, email, conversationId, blobId, index }) {
  const { participant } = await assertAccess({ orgId, email, conversationId, statuses: ["active"] });
  if (!isId(blobId, 12)) fail(404, "Attachment not found.");
  const { attachments } = await chatDb();
  const att = await attachments.findOne({ conversationId, blobId, status: "ready", purged: false });
  if (!att) fail(404, "Attachment not found.");
  if (participant.joinedAt && att.createdAt < participant.joinedAt) fail(404, "Attachment not found.");
  const i = parseInt(index, 10);
  if (!Number.isInteger(i) || i < 0 || i >= att.partCount) fail(400, "Invalid part index.");
  const col = await parts();
  const row = await col.findOne({ blobId, index: i });
  if (!row) fail(404, "Attachment not found.");
  return { index: i, partCount: att.partCount, size: att.size, data: Buffer.from(row.data.buffer).toString("base64") };
}

export async function purgeConversationBlobs(conversationId) {
  const col = await parts(); await col.deleteMany({ conversationId });
}
