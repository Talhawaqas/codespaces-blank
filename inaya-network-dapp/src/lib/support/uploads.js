// src/lib/support/uploads.js
//
// Large attachments (up to settings.attachments.maxBytes, at most 25 MB). The hosting platform limits a single
// request to about 4.5 MB, so a file is sent in chunks of exactly 3 MB (the last one shorter):
//
//   1. init     -> { filename, size, sha256? } is checked (type, size) BEFORE any bytes move; returns an upload token
//   2. chunk    -> PUT the raw bytes of chunk i; idempotent, so a dropped request is simply sent again
//   3. complete -> chunks are assembled, size and (if given) SHA-256 are verified, then the assembled file goes
//                  through the same policy checks, malware scan, encrypted storage and audit as any other attachment.
//
// The upload token is random, only its hash is stored, it is bound to one organization and one uploader, expires
// after an hour, and chunks live in a TTL collection, so abandoned uploads clean themselves up.

import { Binary } from "mongodb";
import { toObjectId } from "../orgs.js";
import { getSupportCollections, ensureSupportIndexes } from "./db.js";
import { fail, nowIso, sha256, newToken } from "./common.js";
import { preflightFile, addAttachment } from "./attachments.js";
import { addIdeaAttachment } from "./ideas.js";
import { audit } from "./record.js";

export const CHUNK_BYTES = 3 * 1024 * 1024;
const TTL_MS = 60 * 60 * 1000;
const chunkCount = (size) => Math.ceil(size / CHUNK_BYTES);

/** owner = { kind: portal|agent|api, id, email }; target = { type: ticket|idea, id, messageId?, visibility?, uploader }. Authorization of the target is the caller's job. */
export async function initUpload({ orgId, settings, owner, target, filename, size, sha256: declared = null }) {
  await ensureSupportIndexes();
  const pre = preflightFile({ filename, size: Number(size), settings });
  if (pre.error) return fail(pre.error, 400, { reasonCode: "ATTACHMENT_REJECTED" });
  if (declared !== null && !/^[0-9a-f]{64}$/i.test(String(declared))) return fail("sha256 must be 64 hex characters.");
  const token = newToken(32);
  const { supportUploads } = await getSupportCollections();
  await supportUploads.insertOne({ orgId: toObjectId(orgId), tokenHash: sha256(token), owner, target, filename: pre.name, size: Number(size), sha256: declared ? String(declared).toLowerCase() : null, chunks: chunkCount(Number(size)), status: "OPEN", createdAt: nowIso(), expiresAt: new Date(Date.now() + TTL_MS) });
  return { uploadId: token, chunkBytes: CHUNK_BYTES, chunks: chunkCount(Number(size)), filename: pre.name };
}

async function load(orgId, owner, token) {
  const { supportUploads } = await getSupportCollections();
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
  const u = await supportUploads.findOne({ orgId: toObjectId(orgId), tokenHash: sha256(token) });
  if (!u || u.owner.kind !== owner.kind || String(u.owner.id) !== String(owner.id)) return null; // not yours = not found
  return u;
}

export async function putChunk({ orgId, owner, token, index, buffer }) {
  const u = await load(orgId, owner, token);
  if (!u || u.status !== "OPEN") return fail("Upload not found.", 404);
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= u.chunks) return fail(`chunk index must be 0-${u.chunks - 1}.`);
  const expected = i === u.chunks - 1 ? u.size - i * CHUNK_BYTES : CHUNK_BYTES;
  if (!Buffer.isBuffer(buffer) || buffer.length !== expected) return fail(`Chunk ${i} must be exactly ${expected} bytes.`, 400, { reasonCode: "BAD_CHUNK" });
  const { supportUploadChunks } = await getSupportCollections();
  await supportUploadChunks.updateOne({ uploadId: u._id, index: i }, { $set: { data: new Binary(buffer), size: buffer.length, expiresAt: u.expiresAt } }, { upsert: true });
  return { received: i };
}

export async function completeUpload({ orgId, settings, owner, token }) {
  const { supportUploads, supportUploadChunks } = await getSupportCollections();
  const u0 = await load(orgId, owner, token);
  if (!u0) return fail("Upload not found.", 404);
  const u = await supportUploads.findOneAndUpdate({ _id: u0._id, status: "OPEN" }, { $set: { status: "COMPLETING" } }, { returnDocument: "after" }); // only one caller assembles
  if (!u) return fail("This upload was already completed.", 409);
  const cleanup = async () => { await supportUploadChunks.deleteMany({ uploadId: u._id }); await supportUploads.deleteOne({ _id: u._id }); };
  try {
    const rows = await supportUploadChunks.find({ uploadId: u._id }).sort({ index: 1 }).toArray();
    if (rows.length !== u.chunks || rows.some((r, k) => r.index !== k)) { await supportUploads.updateOne({ _id: u._id }, { $set: { status: "OPEN" } }); return fail(`Not all chunks arrived (${rows.length} of ${u.chunks}). Send the missing ones and complete again.`, 409, { reasonCode: "INCOMPLETE", received: rows.map((r) => r.index) }); }
    const buffer = Buffer.concat(rows.map((r) => Buffer.from(r.data.buffer)));
    if (buffer.length !== u.size) { await cleanup(); return fail("The assembled file is not the size that was declared.", 400, { reasonCode: "SIZE_MISMATCH" }); }
    if (u.sha256 && sha256(buffer) !== u.sha256) { await cleanup(); return fail("The file was damaged in transit (checksum does not match). Please try again.", 400, { reasonCode: "CHECKSUM_MISMATCH" }); }
    const file = { filename: u.filename, buffer };
    const t = u.target;
    const r = t.type === "idea"
      ? await addIdeaAttachment({ orgId, settings, user: t.user, ideaId: t.id, file })
      : await addAttachment({ orgId, settings, ticketId: t.id, messageId: t.messageId || null, file, uploader: t.uploader, visibility: t.visibility || "PUBLIC" });
    await cleanup();
    if (r.error) return r;
    await audit({ orgId, ticketId: t.type === "ticket" ? t.id : null, action: "SUPPORT_LARGE_UPLOAD", actorEmail: owner.email, metadata: { filename: u.filename, sizeBytes: u.size, chunks: u.chunks } });
    return r;
  } catch (err) {
    await supportUploads.updateOne({ _id: u._id }, { $set: { status: "OPEN" } }).catch(() => {});
    throw err;
  }
}
