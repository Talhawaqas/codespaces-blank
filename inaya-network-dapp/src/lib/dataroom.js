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
// layer below, not by encryption) — same PINATA_JWT credential as the
// rest of this codebase, just the plain-file pinning endpoint instead of
// the JSON-shard one.
//
// Token/session mechanics deliberately reuse orgs.js's exact helpers
// (hashToken/generateToken/isValidEmail/normalizeEmail) rather than
// duplicating them — they're pure and generic, not org-coupled.

import { randomBytes, createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { connectToDatabase } from "./mongodb.js";
import { hashToken, generateToken, isValidEmail, normalizeEmail } from "./orgs.js";

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
// Document storage — plain (unencrypted) Pinata pinning
// ============================================================

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

/** Pins a document's raw bytes to IPFS via Pinata's multipart file-upload
 *  endpoint — the sibling of the pinJSONToIPFS call the encrypted-shard
 *  upload route uses, but for plain files: no client-side encryption/
 *  sharding here, since data room access control is the visitor-session +
 *  NDA gate, not encryption. Same PINATA_JWT credential as the rest of
 *  this codebase. Never surfaces Pinata's raw error body — status only,
 *  same policy as didit.js (the call carries a credential). */
export async function pinDocumentFile({ buffer, filename, mimeType }) {
  const pinataJWT = requireEnv("PINATA_JWT");

  const formData = new FormData();
  formData.append("file", new Blob([buffer], { type: mimeType }), filename);
  formData.append("pinataMetadata", JSON.stringify({ name: `inaya_dataroom_${filename}` }));

  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${pinataJWT.trim()}` },
    body: formData,
  });

  if (!res.ok) {
    throw new Error(`Document upload failed (HTTP ${res.status}).`);
  }

  const data = await res.json();
  return data.IpfsHash;
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
