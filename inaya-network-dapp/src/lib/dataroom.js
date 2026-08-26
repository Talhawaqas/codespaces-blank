// src/lib/dataroom.js
//
// Investor Data Room — a single, founder-owned room (not multi-tenant like
// Business Workspace's orgs) gated by a name+email verification step and
// an NDA click-through, replacing ad-hoc Google Drive sharing with
// tracked, revocable access.
//
// Deliberately NOT built on Business Workspace's document system
// (document-permissions.js / document-workflow.js): those documents are
// encrypted client-side with a passkey before upload, which is the right
// model for zero-knowledge internal storage but the wrong one here — a
// data room's whole point is investors casually viewing a PDF inline with
// duration tracking, which requires the server to actually be able to
// serve viewable bytes. Data room documents are therefore stored
// unencrypted but access-controlled (gated by the visitor-session + NDA
// layer below, not by encryption).
//
// Storage: MongoDB GridFS (the same database this whole app already
// depends on), not IPFS/Pinata — this feature has no need for a pinning
// service or a third-party credential at all: it isn't trying to be
// decentralized (see the paragraph above), it's an admin-only upload of a
// handful of investor PDFs, and GridFS handles files well past this
// module's own 50MB cap natively. One less external dependency, one less
// credential to rotate.
//
// Token/session mechanics deliberately reuse orgs.js's exact helpers
// (hashToken/generateToken/isValidEmail/normalizeEmail) rather than
// duplicating them — they're pure and generic, not org-coupled.

import { randomBytes, createHash } from "node:crypto";
import { ObjectId, GridFSBucket } from "mongodb";
import { get as getBlob, del as deleteBlob } from "@vercel/blob";
import { connectToDatabase } from "./mongodb.js";
import { hashToken, generateToken, isValidEmail, normalizeEmail } from "./orgs.js";

const GRIDFS_BUCKET_NAME = "dataroom_files";

export const DATAROOM_SESSION_COOKIE = "inaya_dataroom_session";
export const DATAROOM_MAGIC_LINK_TTL_MS = 30 * 60 * 1000; // 30 minutes, same as org login links
export const DATAROOM_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — investors shouldn't have to re-verify every visit

const MAX_TITLE_LEN = 200;
const MAX_CATEGORY_LEN = 100;
const MAX_NAME_LEN = 200;

// Mirrors the founder's existing Google Drive data room folder structure,
// so migrating off Drive doesn't also mean re-inventing how documents are
// organized. The admin upload form offers these as a dropdown; validation
// itself stays permissive (any non-empty string under the length cap) so
// a one-off category doesn't hard-block an upload.
export const DATAROOM_CATEGORIES = ["Executive Documents", "Fundraising", "Operations", "Product & Demo", "Technical"];
export const MAX_DOCUMENT_SIZE_BYTES = 50 * 1024 * 1024; // 50MB — generous enough for a financial model PDF
export const ALLOWED_DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "image/png",
  "image/jpeg",
];

// Video demo files (Product & Demo category) go through a completely
// different storage path than the document types above — see the header
// comment on storeVideoFile() below for why. Kept as a separate list/cap
// rather than folding into ALLOWED_DOCUMENT_MIME_TYPES/MAX_DOCUMENT_SIZE_
// BYTES, since a 50MB document cap would reject nearly every demo video.
export const ALLOWED_VIDEO_MIME_TYPES = ["video/mp4"];
export const MAX_VIDEO_SIZE_BYTES = 500 * 1024 * 1024; // 500MB — comfortable headroom over the largest current demo (~130MB)

export function validateVideoUploadInput(input) {
  const { title, category, sizeBytes, mimeType } = input || {};
  if (!isNonEmptyString(title, MAX_TITLE_LEN)) {
    throw new Error(`Title is required (max ${MAX_TITLE_LEN} characters).`);
  }
  if (category != null && !isNonEmptyString(category, MAX_CATEGORY_LEN)) {
    throw new Error(`Category must be under ${MAX_CATEGORY_LEN} characters.`);
  }
  if (typeof sizeBytes !== "number" || sizeBytes <= 0) {
    throw new Error("File is empty or unreadable.");
  }
  if (sizeBytes > MAX_VIDEO_SIZE_BYTES) {
    throw new Error(`Video is too large (max ${MAX_VIDEO_SIZE_BYTES / (1024 * 1024)}MB).`);
  }
  if (!ALLOWED_VIDEO_MIME_TYPES.includes(mimeType)) {
    throw new Error("Unsupported video type. Upload an MP4.");
  }
  return { title: title.trim(), category: category ? category.trim() : "Product & Demo" };
}

export async function getDataroomCollections() {
  const { db } = await connectToDatabase();
  return {
    db,
    documents: db.collection("dataroom_documents"),
    visitors: db.collection("dataroom_visitors"),
    magicLinks: db.collection("dataroom_magic_links"),
    sessions: db.collection("dataroom_sessions"),
    views: db.collection("dataroom_views"),
  };
}

let indexesEnsured = false;

export async function ensureDataroomIndexes() {
  if (indexesEnsured) return;
  const { documents, visitors, magicLinks, sessions, views } = await getDataroomCollections();

  await Promise.all([
    documents.createIndex({ order: 1 }),
    visitors.createIndex({ email: 1 }, { unique: true }),
    magicLinks.createIndex({ tokenHash: 1 }, { unique: true }),
    magicLinks.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    sessions.createIndex({ tokenHash: 1 }, { unique: true }),
    sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    views.createIndex({ visitorId: 1 }),
    views.createIndex({ documentId: 1 }),
    views.createIndex({ visitorId: 1, documentId: 1, closedAt: 1 }),
  ]);

  indexesEnsured = true;
}

function isNonEmptyString(v, maxLen) {
  return typeof v === "string" && v.trim().length > 0 && v.length <= maxLen;
}

export function toObjectId(id) {
  return id instanceof ObjectId ? id : new ObjectId(id);
}

/** Throws a descriptive Error on any violation — same fail-closed
 *  convention as validateFeedbackInput/validateSaveInput. */
export function validateVisitorInput(input) {
  const { name, email } = input || {};
  if (!isNonEmptyString(name, MAX_NAME_LEN)) {
    throw new Error(`Name is required (max ${MAX_NAME_LEN} characters).`);
  }
  if (!isNonEmptyString(email, 320) || !isValidEmail(normalizeEmail(email))) {
    throw new Error("A valid email address is required.");
  }
  return { name: name.trim(), email: normalizeEmail(email) };
}

export function validateDocumentUploadInput(input) {
  const { title, category, sizeBytes, mimeType } = input || {};
  if (!isNonEmptyString(title, MAX_TITLE_LEN)) {
    throw new Error(`Title is required (max ${MAX_TITLE_LEN} characters).`);
  }
  if (category != null && !isNonEmptyString(category, MAX_CATEGORY_LEN)) {
    throw new Error(`Category must be under ${MAX_CATEGORY_LEN} characters.`);
  }
  if (typeof sizeBytes !== "number" || sizeBytes <= 0) {
    throw new Error("File is empty or unreadable.");
  }
  if (sizeBytes > MAX_DOCUMENT_SIZE_BYTES) {
    throw new Error(`File is too large (max ${MAX_DOCUMENT_SIZE_BYTES / (1024 * 1024)}MB).`);
  }
  if (!ALLOWED_DOCUMENT_MIME_TYPES.includes(mimeType)) {
    throw new Error("Unsupported file type. Upload a PDF, PPTX, XLSX, DOCX, PNG, or JPEG.");
  }
  return { title: title.trim(), category: category ? category.trim() : "General" };
}

// ============================================================
// Visitor identity + magic-link verification
// ============================================================

/** Upserts a visitor by email, issues a fresh magic-link token. Returns the
 *  raw token — the caller (route) decides whether to email it via
 *  sendMagicLinkEmail or, in dev/no-email-configured fallback, return it
 *  directly, same pattern orgs.js's routes already use. */
export async function requestDataroomAccess({ name, email }) {
  await ensureDataroomIndexes();
  const { visitors, magicLinks } = await getDataroomCollections();
  const now = new Date().toISOString();

  const existing = await visitors.findOne({ email });
  let visitorId;
  if (existing) {
    visitorId = existing._id;
    if (existing.revokedAt) {
      // A revoked visitor can still request access again — re-verifying
      // clears the revocation, same "revoke isn't permanent exile" model
      // as any access-control system that doesn't want to hard-ban an
      // email typo or a legitimately reinstated investor.
      await visitors.updateOne({ _id: visitorId }, { $set: { name, revokedAt: null } });
    } else {
      await visitors.updateOne({ _id: visitorId }, { $set: { name } });
    }
  } else {
    const { insertedId } = await visitors.insertOne({
      name,
      email,
      emailVerifiedAt: null,
      ndaAcceptedAt: null,
      createdAt: now,
      lastActiveAt: now,
      revokedAt: null,
    });
    visitorId = insertedId;
  }

  const token = generateToken();
  await magicLinks.insertOne({
    tokenHash: hashToken(token),
    email,
    visitorId,
    expiresAt: new Date(Date.now() + DATAROOM_MAGIC_LINK_TTL_MS).toISOString(),
    usedAt: null,
    createdAt: now,
  });

  return { token, visitorId };
}

/** Validates + consumes a magic-link token, marks the visitor's email
 *  verified, and issues a session. Returns {error,status} or
 *  {visitorId, sessionToken}. */
export async function consumeDataroomMagicLink(token) {
  if (!token) return { error: "missing_token", status: 400 };

  await ensureDataroomIndexes();
  const { magicLinks, visitors, sessions } = await getDataroomCollections();

  const link = await magicLinks.findOne({ tokenHash: hashToken(token) });
  if (!link || link.usedAt || new Date(link.expiresAt).getTime() < Date.now()) {
    return { error: "invalid_or_expired", status: 400 };
  }

  const now = new Date().toISOString();
  await magicLinks.updateOne({ _id: link._id }, { $set: { usedAt: now } });
  await visitors.updateOne({ _id: link.visitorId }, { $set: { emailVerifiedAt: now, lastActiveAt: now } });

  const sessionToken = generateToken();
  await sessions.insertOne({
    tokenHash: hashToken(sessionToken),
    visitorId: link.visitorId,
    expiresAt: new Date(Date.now() + DATAROOM_SESSION_TTL_MS).toISOString(),
    createdAt: now,
  });

  return { visitorId: link.visitorId, sessionToken };
}

/** Resolves a request's session cookie to the current visitor, or null.
 *  Defense-in-depth: checks the visitor's own revokedAt too, not just
 *  session expiry — so a revoke takes effect even if a session row
 *  somehow outlives the cleanup in revokeVisitor(). */
export async function getDataroomVisitor(req) {
  const rawToken = req.cookies.get(DATAROOM_SESSION_COOKIE)?.value;
  if (!rawToken) return null;

  const { sessions, visitors } = await getDataroomCollections();
  const session = await sessions.findOne({ tokenHash: hashToken(rawToken) });
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) return null;

  const visitor = await visitors.findOne({ _id: session.visitorId });
  if (!visitor || visitor.revokedAt) return null;

  return visitor;
}

export async function acceptDataroomNda(visitorId) {
  const { visitors } = await getDataroomCollections();
  const now = new Date().toISOString();
  await visitors.updateOne({ _id: toObjectId(visitorId) }, { $set: { ndaAcceptedAt: now, lastActiveAt: now } });
}

/** Deletes all active sessions for this visitor (immediate logout) and
 *  marks them revoked so a re-verification is required to get back in. */
export async function revokeDataroomVisitor(visitorId) {
  const { visitors, sessions } = await getDataroomCollections();
  const objectId = toObjectId(visitorId);
  await Promise.all([
    visitors.updateOne({ _id: objectId }, { $set: { revokedAt: new Date().toISOString() } }),
    sessions.deleteMany({ visitorId: objectId }),
  ]);
}

// ============================================================
// Document storage — plain (unencrypted) MongoDB GridFS
// ============================================================

async function getDataroomBucket() {
  const { db } = await connectToDatabase();
  return new GridFSBucket(db, { bucketName: GRIDFS_BUCKET_NAME });
}

/** Writes a document's raw bytes into GridFS. Returns the file's ObjectId
 *  (as a string) — stored on the dataroom_documents row as `fileId`,
 *  replacing what used to be a Pinata CID. */
export async function storeDocumentFile({ buffer, filename, mimeType }) {
  const bucket = await getDataroomBucket();
  return new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream(filename, { contentType: mimeType });
    uploadStream.on("error", reject);
    uploadStream.on("finish", () => resolve(uploadStream.id.toString()));
    uploadStream.end(buffer);
  });
}

/** Reads a document's raw bytes back out of GridFS. Buffered (not a raw
 *  stream passthrough) for the same reason the old Pinata-gateway proxy
 *  buffered its response — a consistent body type NextResponse always
 *  handles correctly, well within budget at this module's 50MB cap. */
export async function readDocumentFile(fileId) {
  const bucket = await getDataroomBucket();
  const downloadStream = bucket.openDownloadStream(toObjectId(fileId));
  const chunks = [];
  for await (const chunk of downloadStream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Deletes a document's bytes from GridFS — called when the admin removes
 *  a document row, so storage doesn't silently accumulate orphaned files
 *  the way "don't bother unpinning" was an acceptable posture for IPFS. */
export async function deleteDocumentFile(fileId) {
  const bucket = await getDataroomBucket();
  await bucket.delete(toObjectId(fileId));
}

// ============================================================
// Video storage — Vercel Blob (private store)
// ============================================================
//
// Demo videos (Product & Demo category) don't fit through the same path
// as documents above: a single request into a Vercel serverless function
// is capped at roughly 4.5MB, and these are 2-130MB MP4s — a platform
// limit, unaffected by which storage backend receives the bytes.
//
// So video upload is a genuinely different flow: the admin's browser
// uploads DIRECTLY to Vercel Blob (see api/admin/dataroom/videos/
// upload-token/route.js's handleUpload, which only ever hands out a
// short-lived signed upload token — our server never touches the video
// bytes on the way in). The store itself was created with --access
// private, so a bare blob URL isn't independently fetchable; readVideoFile
// below still requires BLOB_READ_WRITE_TOKEN, which only our server has —
// preserving the same "investor never gets a bare shareable link" property
// documents already have, via the visitor-session + NDA gate in the
// stream route, same as before.

/** Reads a video's bytes back out of the private Blob store. Buffered for
 *  the same reason readDocumentFile() is — this codebase has already hit
 *  a documented Vercel runtime inconsistency piping a raw fetch stream
 *  straight into NextResponse (see the git history on the old Pinata
 *  gateway proxy), so buffering is the deliberately boring, reliable
 *  choice here too, video size notwithstanding. */
export async function readVideoFile(pathname) {
  const result = await getBlob(pathname, { access: "private", token: process.env.BLOB_READ_WRITE_TOKEN });
  if (!result) throw new Error("Video not found in storage.");
  const arrayBuffer = await new Response(result.stream).arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/** Deletes a video's bytes from Blob storage — same "an admin delete
 *  should actually free the storage" posture as deleteDocumentFile(). */
export async function deleteVideoFile(pathname) {
  await deleteBlob(pathname, { token: process.env.BLOB_READ_WRITE_TOKEN });
}

// ============================================================
// View/engagement tracking
// ============================================================

export async function recordViewOpened({ visitorId, documentId }) {
  const { views, visitors } = await getDataroomCollections();
  const now = new Date().toISOString();
  await views.insertOne({
    visitorId: toObjectId(visitorId),
    documentId: toObjectId(documentId),
    openedAt: now,
    lastHeartbeatAt: now,
    closedAt: null,
  });
  await visitors.updateOne({ _id: toObjectId(visitorId) }, { $set: { lastActiveAt: now } });
}

/** Heartbeat/close events target the most recent still-open view row for
 *  this visitor+document pair, rather than round-tripping a view ID to
 *  the client — simpler client, and the rare double-tab-open edge case
 *  (two opens racing) just merges into one row, which is an acceptable
 *  simplification for V1. */
export async function recordViewEvent({ visitorId, documentId, event }) {
  const { views, visitors } = await getDataroomCollections();
  const now = new Date().toISOString();
  const filter = { visitorId: toObjectId(visitorId), documentId: toObjectId(documentId), closedAt: null };
  const update = event === "closed" ? { $set: { closedAt: now, lastHeartbeatAt: now } } : { $set: { lastHeartbeatAt: now } };
  await views.findOneAndUpdate(filter, update, { sort: { openedAt: -1 } });
  await visitors.updateOne({ _id: toObjectId(visitorId) }, { $set: { lastActiveAt: now } });
}

/** Duration is always computed on the fly from (closedAt ?? lastHeartbeatAt)
 *  - openedAt rather than stored/finalized separately — an abrupt tab
 *  close (no clean "closed" event) still yields an accurate-enough
 *  duration from the last heartbeat, with no separate "finalize stale
 *  views" job needed. */
export async function getVisitorEngagementSummary() {
  const { views, visitors, documents } = await getDataroomCollections();

  const [visitorList, viewRows, documentList] = await Promise.all([
    visitors.find({}).sort({ lastActiveAt: -1 }).toArray(),
    views.find({}).toArray(),
    documents.find({}).toArray(),
  ]);

  const documentTitleById = new Map(documentList.map((d) => [d._id.toString(), d.title]));

  const viewsByVisitor = new Map();
  for (const v of viewRows) {
    const key = v.visitorId.toString();
    const endTime = v.closedAt || v.lastHeartbeatAt;
    const durationMs = Math.max(0, new Date(endTime).getTime() - new Date(v.openedAt).getTime());
    const entry = { documentId: v.documentId.toString(), documentTitle: documentTitleById.get(v.documentId.toString()) || "Deleted document", openedAt: v.openedAt, durationMs };
    if (!viewsByVisitor.has(key)) viewsByVisitor.set(key, []);
    viewsByVisitor.get(key).push(entry);
  }

  return visitorList.map((visitor) => {
    const visitorViews = viewsByVisitor.get(visitor._id.toString()) || [];
    return {
      visitorId: visitor._id.toString(),
      name: visitor.name,
      email: visitor.email,
      emailVerifiedAt: visitor.emailVerifiedAt,
      ndaAcceptedAt: visitor.ndaAcceptedAt,
      lastActiveAt: visitor.lastActiveAt,
      revokedAt: visitor.revokedAt,
      totalViews: visitorViews.length,
      totalDurationMs: visitorViews.reduce((sum, v) => sum + v.durationMs, 0),
      views: visitorViews.sort((a, b) => new Date(b.openedAt) - new Date(a.openedAt)),
    };
  });
}
