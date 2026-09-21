// src/lib/s3-compat/walletStore.js
//
// The wallet-vault twin of store.js -- same S3 REST surface, same real
// custody-sdk crypto and pinning-provider pipeline, but backed by the
// personal/wallet vault's own metadata_files/metadata_folders collections
// instead of org_documents. Kept as a genuinely separate implementation
// rather than a branch inside store.js, mirroring this codebase's own
// existing split between the two ownership models (src/lib/orgs.js's own
// header comment: mixing them "risked silently breaking that system's
// on-chain-ownership invariant").
//
// A "bucket" here is a real, existing metadata_folders row at the vault's
// root (parentFolderId: null) -- the same folder tree the wallet's own UI
// already uses, just used at one level as the bucket/container concept.
// Object keys are stored as the full S3 key string in `filename` (S3 keys
// are flat strings; "directories" within a bucket are a shared-prefix
// convention, same simplification store.js makes for org buckets).
//
// Same disclosed scoping decision as store.js: objects written through
// this compatibility layer are not synchronously registered on-chain
// (mfaCrypto-style key custody makes that unnecessary for integrity, and a
// real confirmed transaction per object would make bulk `aws s3 sync`
// impractically slow) -- see store.js's header for the full reasoning.

import { randomUUID, createHash } from "node:crypto";
import { InayaKernel } from "@inaya-network/custody-sdk";
import { connectToDatabase } from "../mongodb.js";
import { getProvider, listAvailableProviders } from "../pinningProviders/index.js";
import { getOwnerS3Passphrase } from "./credentials.js";
import { replicateShard, getBackupStatus } from "../backupEngine.js";

export class ObjectProtectedError extends Error {
  constructor(message, reason) {
    super(message);
    this.reason = reason; // "LegalHold" | "ObjectLocked"
  }
}

function assertNotProtected(doc, actionLabel) {
  if (!doc) return;
  if (doc.legalHold) throw new ObjectProtectedError(`Cannot ${actionLabel}: object is under legal hold.`, "LegalHold");
  if (doc.retentionUntil && new Date(doc.retentionUntil).getTime() > Date.now()) {
    throw new ObjectProtectedError(`Cannot ${actionLabel}: object is retention-locked (${doc.retentionMode}) until ${doc.retentionUntil}.`, "ObjectLocked");
  }
}

// Same backward-compatible fallback as store.js -- pre-existing wallet
// S3-compat files have no isLatest field at all.
const IS_LATEST = { $ne: false };

function primaryProviderName() {
  const available = listAvailableProviders();
  if (available.includes("pinata")) return "pinata";
  if (available.length > 0) return available[0];
  throw new Error("No pinning provider is configured -- the S3-compatibility layer cannot store objects.");
}

function walletOwner(walletAddress) {
  return { type: "wallet", walletAddress: walletAddress.toLowerCase() };
}

export async function listS3Buckets(walletAddress) {
  const { db } = await connectToDatabase();
  const docs = await db
    .collection("metadata_folders")
    .find({ owner: walletAddress.toLowerCase(), parentFolderId: null, deletedAt: null })
    .sort({ createdAt: 1 })
    .toArray();
  return docs.map((f) => ({ name: f.name, createdAt: f.createdAt }));
}

export async function getS3Bucket({ walletAddress, bucket }) {
  const { db } = await connectToDatabase();
  return db.collection("metadata_folders").findOne({ owner: walletAddress.toLowerCase(), parentFolderId: null, name: bucket, deletedAt: null });
}

export async function ensureS3Bucket({ walletAddress, bucket }) {
  const existing = await getS3Bucket({ walletAddress, bucket });
  if (existing) return existing;
  const { db } = await connectToDatabase();
  const now = new Date().toISOString();
  const doc = { folderId: randomUUID(), owner: walletAddress.toLowerCase(), name: bucket, parentFolderId: null, createdAt: now, updatedAt: now, deletedAt: null };
  await db.collection("metadata_folders").insertOne(doc);
  return doc;
}

export async function deleteS3Bucket({ walletAddress, bucket }) {
  const bucketDoc = await getS3Bucket({ walletAddress, bucket });
  if (!bucketDoc) return { deleted: false, reason: "NoSuchBucket" };
  const { db } = await connectToDatabase();
  const count = await db.collection("metadata_files").countDocuments({ owner: walletAddress.toLowerCase(), folderId: bucketDoc.folderId, deletedAt: null });
  if (count > 0) return { deleted: false, reason: "BucketNotEmpty" };
  await db.collection("metadata_folders").updateOne({ folderId: bucketDoc.folderId }, { $set: { deletedAt: new Date().toISOString() } });
  return { deleted: true };
}

// ---------------------------------------------------------------------
// Versioning + Object Lock + Legal Hold (SOW §3/§4/§5) -- wallet-side twin
// of store.js's identical functions, over metadata_folders/metadata_files
// instead of projects/org_documents. See store.js for the full design
// rationale (kept there rather than duplicated in every comment here).
// ---------------------------------------------------------------------

export async function putBucketVersioning({ walletAddress, bucket, status }) {
  if (!["Enabled", "Suspended"].includes(status)) throw new Error('status must be "Enabled" or "Suspended".');
  const bucketDoc = await ensureS3Bucket({ walletAddress, bucket });
  const { db } = await connectToDatabase();
  if (bucketDoc.versioningStatus == null && status === "Suspended") {
    throw new Error("Versioning cannot be suspended before it has ever been enabled.");
  }
  await db.collection("metadata_folders").updateOne({ folderId: bucketDoc.folderId }, { $set: { versioningStatus: status } });
  return { bucket, versioningStatus: status };
}

export async function getBucketVersioning({ walletAddress, bucket }) {
  const bucketDoc = await getS3Bucket({ walletAddress, bucket });
  if (!bucketDoc) return null;
  return { versioningStatus: bucketDoc.versioningStatus || "Unversioned", objectLockEnabled: !!bucketDoc.objectLockEnabled };
}

export async function enableBucketObjectLock({ walletAddress, bucket }) {
  const bucketDoc = await ensureS3Bucket({ walletAddress, bucket });
  if (bucketDoc.versioningStatus !== "Enabled") throw new Error("Object Lock requires bucket Versioning to be Enabled first.");
  const { db } = await connectToDatabase();
  await db.collection("metadata_folders").updateOne({ folderId: bucketDoc.folderId }, { $set: { objectLockEnabled: true } });
  return { bucket, objectLockEnabled: true };
}

export async function putObjectRetention({ walletAddress, bucket, key, versionId, retentionMode, retentionUntil }) {
  if (!["GOVERNANCE", "COMPLIANCE"].includes(retentionMode)) throw new Error('retentionMode must be "GOVERNANCE" or "COMPLIANCE".');
  const bucketDoc = await getS3Bucket({ walletAddress, bucket });
  if (!bucketDoc?.objectLockEnabled) throw new Error("Object Lock is not enabled on this bucket.");
  const { db } = await connectToDatabase();
  const query = { owner: walletAddress.toLowerCase(), folderId: bucketDoc.folderId, filename: key, ...(versionId ? { versionId } : { isLatest: IS_LATEST }) };
  const doc = await db.collection("metadata_files").findOne(query);
  if (!doc) throw new Error("Object/version not found.");
  if (doc.retentionUntil && new Date(retentionUntil).getTime() < new Date(doc.retentionUntil).getTime()) {
    throw new Error("A retention period cannot be shortened, only extended.");
  }
  await db.collection("metadata_files").updateOne({ _id: doc._id }, { $set: { retentionMode, retentionUntil: new Date(retentionUntil).toISOString() } });
  return { bucket, key, versionId: doc.versionId, retentionMode, retentionUntil };
}

export async function putObjectLegalHold({ walletAddress, bucket, key, versionId, legalHold }) {
  const bucketDoc = await getS3Bucket({ walletAddress, bucket });
  if (!bucketDoc) throw new Error("NoSuchBucket");
  const { db } = await connectToDatabase();
  const query = { owner: walletAddress.toLowerCase(), folderId: bucketDoc.folderId, filename: key, ...(versionId ? { versionId } : { isLatest: IS_LATEST }) };
  const doc = await db.collection("metadata_files").findOne(query);
  if (!doc) throw new Error("Object/version not found.");
  await db.collection("metadata_files").updateOne({ _id: doc._id }, { $set: { legalHold: !!legalHold } });
  return { bucket, key, versionId: doc.versionId, legalHold: !!legalHold };
}

// AWS S3 Feature Expansion SOW, Phase 1 -- same tag validation as
// store.js's normalizeTags(), duplicated rather than imported since
// walletStore.js is a deliberately independent implementation from
// store.js (see this file's own module header / store.js's header on why
// org_documents and metadata_files stay genuinely separate).
const MAX_TAG_COUNT = 10;
const MAX_TAG_KEY_LEN = 128;
const MAX_TAG_VALUE_LEN = 256;
function normalizeTags(tags) {
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) throw new Error("tags must be a plain object of string key/value pairs.");
  const entries = Object.entries(tags);
  if (entries.length > MAX_TAG_COUNT) throw new Error(`A maximum of ${MAX_TAG_COUNT} tags is allowed per object.`);
  const out = {};
  for (const [key, value] of entries) {
    if (typeof key !== "string" || !key || key.length > MAX_TAG_KEY_LEN) throw new Error(`Invalid tag key "${key}".`);
    if (typeof value !== "string" || value.length > MAX_TAG_VALUE_LEN) throw new Error(`Invalid tag value for key "${key}".`);
    out[key] = value;
  }
  return out;
}

async function findObjectForTagging({ walletAddress, bucket, key, versionId }) {
  const bucketDoc = await getS3Bucket({ walletAddress, bucket });
  if (!bucketDoc) throw new Error("NoSuchBucket");
  const { db } = await connectToDatabase();
  const query = { owner: walletAddress.toLowerCase(), folderId: bucketDoc.folderId, filename: key, ...(versionId ? { versionId } : { isLatest: IS_LATEST }) };
  const doc = await db.collection("metadata_files").findOne(query);
  if (!doc) throw new Error("Object/version not found.");
  return { db, doc };
}

export async function putObjectTagging({ walletAddress, bucket, key, versionId, tags }) {
  const clean = normalizeTags(tags);
  const { db, doc } = await findObjectForTagging({ walletAddress, bucket, key, versionId });
  await db.collection("metadata_files").updateOne({ _id: doc._id }, { $set: { tags: clean } });
  return { bucket, key, versionId: doc.versionId, tags: clean };
}

export async function getObjectTagging({ walletAddress, bucket, key, versionId }) {
  const { doc } = await findObjectForTagging({ walletAddress, bucket, key, versionId });
  return { bucket, key, versionId: doc.versionId, tags: doc.tags || {} };
}

export async function deleteObjectTagging({ walletAddress, bucket, key, versionId }) {
  const { db, doc } = await findObjectForTagging({ walletAddress, bucket, key, versionId });
  await db.collection("metadata_files").updateOne({ _id: doc._id }, { $set: { tags: {} } });
  return { bucket, key, versionId: doc.versionId };
}

function bufferToFile(buffer, { key, contentType }) {
  return new File([buffer], key, { type: contentType || "application/octet-stream" });
}

export async function putS3Object({ walletAddress, bucket, key, bodyBuffer, contentType, tags }) {
  const bucketDoc = await ensureS3Bucket({ walletAddress, bucket });
  const passphrase = await getOwnerS3Passphrase(walletOwner(walletAddress));
  const { db } = await connectToDatabase();
  const owner = walletAddress.toLowerCase();

  const versioningEnabled = bucketDoc.versioningStatus === "Enabled";
  const existing = await db.collection("metadata_files").findOne({ owner, folderId: bucketDoc.folderId, filename: key, isLatest: IS_LATEST, deletedAt: null });
  if (!versioningEnabled) assertNotProtected(existing, "overwrite this object");

  const salt = InayaKernel.generateSecureSalt();
  const encryptionKey = await InayaKernel.deriveVaultKey({ passkey: passphrase, salt });
  const file = bufferToFile(bodyBuffer, { key, contentType });
  const { shardAlpha, shardBeta } = await InayaKernel.disperseAndSlice({ file, encryptionKey });

  const now = new Date().toISOString();
  const newId = randomUUID();

  // Same real pin-name-collision bug fix as store.js's org-side putS3Object
  // -- see that file's comment for the full explanation (Filebase uses
  // `name` as its literal object key, so two versions pinned under the
  // same name silently overwrote each other provider-side).
  const provider = getProvider(primaryProviderName());
  const [alphaResult, betaResult] = await Promise.all([
    provider.pin(shardAlpha, { name: `s3-compat-wallet:${walletAddress}:${key}:${newId}:alpha` }),
    provider.pin(shardBeta, { name: `s3-compat-wallet:${walletAddress}:${key}:${newId}:beta` }),
  ]);

  if (existing) {
    if (versioningEnabled) {
      await db.collection("metadata_files").updateOne({ _id: existing._id }, { $set: { isLatest: false } });
    } else {
      await db.collection("metadata_files").updateOne({ _id: existing._id }, { $set: { deletedAt: now } });
    }
  }

  // Real content hash salted with a fresh random component -- see
  // store.js's identical fix for why: S3 must allow re-uploading identical
  // bytes (same key or a different one), which a pure content hash would
  // collide on if metadata_files enforces uniqueness anywhere downstream.
  const fileHash = createHash("sha256").update(bodyBuffer).update(newId).digest("hex");
  // AWS S3 Feature Expansion SOW, Phase 5 -- same real, independently-
  // verifiable checksum as store.js's org-side putS3Object; see that
  // field's comment for why it's additive rather than a replacement for
  // the salted fileHash above.
  const contentSha256 = createHash("sha256").update(bodyBuffer).digest("hex");
  const doc = {
    fileHash,
    contentSha256,
    owner,
    filename: key,
    folderId: bucketDoc.folderId,
    contentType: contentType || "application/octet-stream",
    fileSizeBytes: bodyBuffer.length,
    cidAlpha: alphaResult.providerRef,
    cidBeta: betaResult.providerRef,
    pinProvider: alphaResult.provider,
    encryptionMode: "server-managed",
    source: "s3-compat",
    versionId: versioningEnabled ? newId : "null",
    isLatest: true,
    retentionMode: null,
    retentionUntil: null,
    legalHold: false,
    tags: tags ? normalizeTags(tags) : {},
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  await db.collection("metadata_files").insertOne(doc);

  // Automated Storage Health & Repair (SOW §7) -- same real backupEngine
  // registration as store.js's org-side putS3Object; see that file's
  // header comment for the full explanation of why this closes a real,
  // previously-existing gap rather than adding a parallel system.
  await Promise.all([
    replicateShard({ fileHash, shardId: "alpha", content: shardAlpha, primaryProvider: alphaResult.provider, primaryCid: alphaResult.cid, primaryProviderRef: alphaResult.providerRef }).catch((err) =>
      console.error("s3-compat walletStore putS3Object: backupEngine registration (alpha) failed (non-fatal):", err.message)
    ),
    replicateShard({ fileHash, shardId: "beta", content: shardBeta, primaryProvider: betaResult.provider, primaryCid: betaResult.cid, primaryProviderRef: betaResult.providerRef }).catch((err) =>
      console.error("s3-compat walletStore putS3Object: backupEngine registration (beta) failed (non-fatal):", err.message)
    ),
  ]);

  return doc;
}

export async function headS3Object({ walletAddress, bucket, key, versionId }) {
  const bucketDoc = await getS3Bucket({ walletAddress, bucket });
  if (!bucketDoc) return null;
  const { db } = await connectToDatabase();
  if (versionId) {
    return db.collection("metadata_files").findOne({ owner: walletAddress.toLowerCase(), folderId: bucketDoc.folderId, filename: key, versionId });
  }
  return db.collection("metadata_files").findOne({ owner: walletAddress.toLowerCase(), folderId: bucketDoc.folderId, filename: key, isLatest: IS_LATEST, deletedAt: null });
}

export async function getS3ObjectBody({ walletAddress, bucket, key, versionId }) {
  const doc = await headS3Object({ walletAddress, bucket, key, versionId });
  if (!doc) return null;
  const passphrase = await getOwnerS3Passphrase(walletOwner(walletAddress));
  const provider = getProvider(doc.pinProvider || primaryProviderName());
  const [shardAlpha, shardBeta] = await Promise.all([provider.fetchReplica(doc.cidAlpha), provider.fetchReplica(doc.cidBeta)]);
  const dataUrl = await InayaKernel.reconstructAndDecrypt({ shardAlpha, shardBeta, passkey: passphrase });
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return { doc, buffer: Buffer.from(base64, "base64") };
}

export async function deleteS3Object({ walletAddress, bucket, key, versionId }) {
  const bucketDoc = await getS3Bucket({ walletAddress, bucket });
  if (!bucketDoc) return { deleted: true };
  const { db } = await connectToDatabase();
  const now = new Date().toISOString();
  const owner = walletAddress.toLowerCase();

  if (!versionId && bucketDoc.versioningStatus === "Enabled") {
    const current = await db.collection("metadata_files").findOne({ owner, folderId: bucketDoc.folderId, filename: key, isLatest: IS_LATEST, deletedAt: null });
    if (!current) return { deleted: true };
    await db.collection("metadata_files").updateOne({ _id: current._id }, { $set: { deletedAt: now } });
    return { deleted: true, deleteMarker: true };
  }

  const doc = await headS3Object({ walletAddress, bucket, key, versionId });
  if (!doc) return { deleted: true };
  assertNotProtected(doc, "delete this object");
  await db.collection("metadata_files").updateOne({ _id: doc._id }, { $set: { deletedAt: now } });
  return { deleted: true };
}

export async function listS3Objects({ walletAddress, bucket, prefix = "", delimiter = "", maxKeys = 1000 }) {
  const bucketDoc = await getS3Bucket({ walletAddress, bucket });
  if (!bucketDoc) return null;
  const { db } = await connectToDatabase();
  const docs = await db
    .collection("metadata_files")
    .find({ owner: walletAddress.toLowerCase(), folderId: bucketDoc.folderId, deletedAt: null, isLatest: IS_LATEST, filename: { $regex: `^${escapeRegExp(prefix)}` } })
    .sort({ filename: 1 })
    .toArray();

  const contents = [];
  const commonPrefixes = new Set();
  for (const doc of docs) {
    const rest = doc.filename.slice(prefix.length);
    if (delimiter && rest.includes(delimiter)) {
      commonPrefixes.add(prefix + rest.slice(0, rest.indexOf(delimiter) + delimiter.length));
    } else {
      contents.push({ ...doc, sizeBytes: doc.fileSizeBytes });
    }
  }

  // Inaya Drive Empty Folder SOW: merge in real metadata_folders rows so a
  // folder with zero files still appears in the listing (see store.js's
  // identical merge for the org side -- same reasoning applies here).
  if (delimiter) {
    const parentFolderId = await resolveFolderIdForPrefix({ walletAddress, bucketDoc, prefix });
    if (parentFolderId !== undefined) {
      const childFolders = await db.collection("metadata_folders").find({ owner: walletAddress.toLowerCase(), parentFolderId, deletedAt: null }).toArray();
      for (const f of childFolders) commonPrefixes.add(prefix + f.name + delimiter);
    }
  }

  return { contents: contents.slice(0, maxKeys), commonPrefixes: [...commonPrefixes].sort(), isTruncated: contents.length > maxKeys };
}

// ---------------------------------------------------------------------
// Inaya Drive -- User-Created Empty Folder Support SOW (wallet side).
//
// Reuses metadata_folders directly rather than a parallel structure: a
// bucket IS already a root-level metadata_folders row (see the module
// header), so an S3-style folder path within that bucket is just a real
// nested metadata_folders chain rooted at the bucket's own folderId
// instead of at the wallet's global root (parentFolderId: null). This is
// the exact same primitive the wallet's own folder UI and
// api/metadata/*-folder routes already use -- no new collection needed.
// ---------------------------------------------------------------------

function splitFolderPath(folderPath) {
  return String(folderPath || "").split("/").filter(Boolean);
}

const FOLDER_NAME_RE = /^[^/\\\0]{1,255}$/;

// Same deterministic-error-code convention as store.js's identical helper.
function folderError(code, message) {
  return Object.assign(new Error(message), { code });
}

function validateFolderSegment(name) {
  if (name === "." || name === "..") throw folderError("InvalidFolderName", `Invalid folder name "${name}".`);
  if (!FOLDER_NAME_RE.test(name)) throw folderError("InvalidFolderName", `Invalid folder name "${name}": must be 1-255 characters and contain no "/", "\\", or null byte.`);
}

async function walletFolderChain({ walletAddress, bucketDoc, segments }) {
  const { db } = await connectToDatabase();
  const col = db.collection("metadata_folders");
  let parentFolderId = bucketDoc.folderId;
  let row = null;
  for (const name of segments) {
    row = await col.findOne({ owner: walletAddress.toLowerCase(), parentFolderId, name, deletedAt: null });
    if (!row) return null;
    parentFolderId = row.folderId;
  }
  return row;
}

/** `prefix` is delimiter-terminated (e.g. "documents/contracts/") or empty
 *  for the bucket root. Returns the bucket's own folderId for the root,
 *  a real folderId for a real sub-path, or `undefined` if unresolvable. */
async function resolveFolderIdForPrefix({ walletAddress, bucketDoc, prefix }) {
  const segments = splitFolderPath(prefix);
  if (segments.length === 0) return bucketDoc.folderId;
  const row = await walletFolderChain({ walletAddress, bucketDoc, segments });
  return row ? row.folderId : undefined;
}

export async function createS3Folder({ walletAddress, bucket, folderPath }) {
  const bucketDoc = await ensureS3Bucket({ walletAddress, bucket });
  const segments = splitFolderPath(folderPath);
  if (segments.length === 0) throw folderError("InvalidFolderName", "Folder path must not be empty.");
  segments.forEach(validateFolderSegment);

  const { db } = await connectToDatabase();
  const col = db.collection("metadata_folders");
  const now = new Date().toISOString();
  let parentFolderId = bucketDoc.folderId;
  let leaf = null;

  for (let i = 0; i < segments.length; i++) {
    const isLeaf = i === segments.length - 1;
    const existing = await col.findOne({ owner: walletAddress.toLowerCase(), parentFolderId, name: segments[i], deletedAt: null });
    if (existing) {
      if (isLeaf) throw folderError("FolderAlreadyExists", `A folder named "${segments[i]}" already exists at this location.`);
      parentFolderId = existing.folderId;
      leaf = existing;
      continue;
    }
    const folderId = randomUUID();
    const doc = { folderId, owner: walletAddress.toLowerCase(), name: segments[i], parentFolderId, createdAt: now, updatedAt: now, deletedAt: null };
    await col.insertOne(doc);
    parentFolderId = folderId;
    leaf = doc;
  }

  return { bucket, folderPath, folderId: leaf.folderId };
}

export async function getS3FolderInfo({ walletAddress, bucket, folderPath }) {
  const bucketDoc = await getS3Bucket({ walletAddress, bucket });
  if (!bucketDoc) return null;
  const segments = splitFolderPath(folderPath);
  if (segments.length === 0) return null;
  const row = await walletFolderChain({ walletAddress, bucketDoc, segments });
  return row ? { folderId: row.folderId, name: row.name, createdAt: row.createdAt } : null;
}

/** Matches metadata_folders' own proven delete-folder route exactly:
 *  child folders are orphaned to the bucket root, never cascade-deleted;
 *  objects are untouched (they're scoped by bucketDoc.folderId directly,
 *  never by a nested folder row, so there's nothing to orphan for them). */
export async function deleteS3Folder({ walletAddress, bucket, folderPath }) {
  const bucketDoc = await getS3Bucket({ walletAddress, bucket });
  if (!bucketDoc) return { deleted: true };
  const segments = splitFolderPath(folderPath);
  if (segments.length === 0) throw folderError("InvalidFolderName", "Folder path must not be empty.");

  const folder = await walletFolderChain({ walletAddress, bucketDoc, segments });
  if (!folder) return { deleted: true };

  const { db } = await connectToDatabase();
  const col = db.collection("metadata_folders");
  const now = new Date().toISOString();
  await col.updateOne({ folderId: folder.folderId }, { $set: { deletedAt: now, updatedAt: now } });
  await col.updateMany({ owner: walletAddress.toLowerCase(), parentFolderId: folder.folderId }, { $set: { parentFolderId: bucketDoc.folderId, updatedAt: now } });
  return { deleted: true };
}

export async function renameS3Folder({ walletAddress, bucket, oldFolderPath, newFolderPath }) {
  const bucketDoc = await getS3Bucket({ walletAddress, bucket });
  if (!bucketDoc) throw folderError("NoSuchBucket", "The specified bucket does not exist.");

  const oldSegments = splitFolderPath(oldFolderPath);
  const newSegments = splitFolderPath(newFolderPath);
  if (oldSegments.length === 0 || newSegments.length === 0) throw folderError("InvalidFolderName", "Folder path must not be empty.");
  const newName = newSegments[newSegments.length - 1];
  validateFolderSegment(newName);
  const newParentSegments = newSegments.slice(0, -1);

  const folder = await walletFolderChain({ walletAddress, bucketDoc, segments: oldSegments });
  if (!folder) throw folderError("NoSuchFolder", "Folder not found.");

  let newParentFolderId = bucketDoc.folderId;
  if (newParentSegments.length > 0) {
    const newParent = await walletFolderChain({ walletAddress, bucketDoc, segments: newParentSegments });
    if (!newParent) throw folderError("NoSuchParentFolder", "The destination parent folder does not exist.");
    newParentFolderId = newParent.folderId;
  }
  if (newParentFolderId === folder.folderId) throw folderError("InvalidFolderName", "A folder cannot be moved into itself.");

  const { db } = await connectToDatabase();
  const col = db.collection("metadata_folders");
  const conflict = await col.findOne({ owner: walletAddress.toLowerCase(), parentFolderId: newParentFolderId, name: newName, deletedAt: null, folderId: { $ne: folder.folderId } });
  if (conflict) throw folderError("FolderAlreadyExists", `A folder named "${newName}" already exists at the destination.`);

  const now = new Date().toISOString();
  await col.updateOne({ folderId: folder.folderId }, { $set: { name: newName, parentFolderId: newParentFolderId, updatedAt: now } });
  return { bucket, folderPath: newFolderPath, folderId: folder.folderId };
}

/** Wallet-side twin of store.js's listAllObjectVersions -- see its
 *  comment for why this exists (real S3 SDK clients' bucket-wide GET
 *  ?versions, e.g. Terraform's force_destroy). */
export async function listAllObjectVersions({ walletAddress, bucket, prefix = "" }) {
  const bucketDoc = await getS3Bucket({ walletAddress, bucket });
  if (!bucketDoc) return null;
  const { db } = await connectToDatabase();
  const docs = await db
    .collection("metadata_files")
    .find({ owner: walletAddress.toLowerCase(), folderId: bucketDoc.folderId, filename: { $regex: `^${escapeRegExp(prefix)}` } })
    .sort({ filename: 1, createdAt: -1 })
    .toArray();
  return docs.map((d) => ({
    key: d.filename,
    versionId: d.versionId || "null",
    isLatest: d.isLatest !== false,
    deleteMarker: !!d.deletedAt,
    sizeBytes: d.fileSizeBytes,
    etag: d.cidAlpha || d.fileHash,
    lastModified: d.createdAt,
  }));
}

export async function listObjectVersions({ walletAddress, bucket, key }) {
  const bucketDoc = await getS3Bucket({ walletAddress, bucket });
  if (!bucketDoc) return null;
  const { db } = await connectToDatabase();
  const docs = await db.collection("metadata_files").find({ owner: walletAddress.toLowerCase(), folderId: bucketDoc.folderId, filename: key }).sort({ createdAt: -1 }).toArray();
  return docs.map((d) => ({
    versionId: d.versionId || "null",
    isLatest: d.isLatest !== false,
    deleteMarker: !!d.deletedAt,
    sizeBytes: d.fileSizeBytes,
    contentType: d.contentType,
    etag: d.cidAlpha || d.fileHash,
    lastModified: d.createdAt,
    retentionMode: d.retentionMode || null,
    retentionUntil: d.retentionUntil || null,
    legalHold: !!d.legalHold,
  }));
}

export async function restoreObjectVersion({ walletAddress, bucket, key, versionId }) {
  const source = await getS3ObjectBody({ walletAddress, bucket, key, versionId });
  if (!source) throw new Error("Version not found.");
  return putS3Object({ walletAddress, bucket, key, bodyBuffer: source.buffer, contentType: source.doc.contentType });
}

export async function getS3ObjectHealth({ walletAddress, bucket, key, versionId }) {
  const doc = await headS3Object({ walletAddress, bucket, key, versionId });
  if (!doc) return null;
  return getBackupStatus(doc.fileHash);
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------
// Multipart upload -- same buffer-then-assemble approach as store.js.
// ---------------------------------------------------------------------

export const MAX_PART_BYTES = 8 * 1024 * 1024;

export async function createMultipartUpload({ walletAddress, bucket, key, contentType }) {
  await ensureS3Bucket({ walletAddress, bucket });
  const { db } = await connectToDatabase();
  const uploadId = randomUUID();
  await db.collection("s3_wallet_multipart_uploads").insertOne({
    _id: uploadId,
    walletAddress: walletAddress.toLowerCase(),
    bucket,
    key,
    contentType: contentType || "application/octet-stream",
    createdAt: new Date().toISOString(),
  });
  return uploadId;
}

export async function uploadPart({ walletAddress, uploadId, partNumber, bodyBuffer }) {
  const { db } = await connectToDatabase();
  const upload = await db.collection("s3_wallet_multipart_uploads").findOne({ _id: uploadId, walletAddress: walletAddress.toLowerCase() });
  if (!upload) return null;
  if (bodyBuffer.length > MAX_PART_BYTES) throw new Error(`Part exceeds the ${MAX_PART_BYTES} byte per-part limit.`);
  const { createHash } = await import("node:crypto");
  const etag = createHash("md5").update(bodyBuffer).digest("hex");
  await db
    .collection("s3_wallet_multipart_parts")
    .updateOne({ uploadId, partNumber }, { $set: { uploadId, partNumber, dataBase64: bodyBuffer.toString("base64"), sizeBytes: bodyBuffer.length, etag } }, { upsert: true });
  return etag;
}

export async function completeMultipartUpload({ walletAddress, uploadId }) {
  const { db } = await connectToDatabase();
  const upload = await db.collection("s3_wallet_multipart_uploads").findOne({ _id: uploadId, walletAddress: walletAddress.toLowerCase() });
  if (!upload) return null;
  const parts = await db.collection("s3_wallet_multipart_parts").find({ uploadId }).sort({ partNumber: 1 }).toArray();
  if (parts.length === 0) throw new Error("Cannot complete a multipart upload with zero parts.");
  const fullBuffer = Buffer.concat(parts.map((p) => Buffer.from(p.dataBase64, "base64")));
  const doc = await putS3Object({ walletAddress, bucket: upload.bucket, key: upload.key, bodyBuffer: fullBuffer, contentType: upload.contentType });
  await db.collection("s3_wallet_multipart_parts").deleteMany({ uploadId });
  await db.collection("s3_wallet_multipart_uploads").deleteOne({ _id: uploadId });
  return doc;
}

export async function abortMultipartUpload({ walletAddress, uploadId }) {
  const { db } = await connectToDatabase();
  await db.collection("s3_wallet_multipart_parts").deleteMany({ uploadId });
  const res = await db.collection("s3_wallet_multipart_uploads").deleteOne({ _id: uploadId, walletAddress: walletAddress.toLowerCase() });
  return res.deletedCount > 0;
}

// Azure Put Block / Put Block List -- see store.js's identical org-side
// functions for the full explanation.

export async function stageAzureBlock({ walletAddress, bucket, key, blockId, bodyBuffer }) {
  if (bodyBuffer.length > MAX_PART_BYTES) throw new Error(`Block exceeds the ${MAX_PART_BYTES} byte per-block limit.`);
  const { db } = await connectToDatabase();
  await db.collection("s3_azure_wallet_blocks").updateOne(
    { walletAddress: walletAddress.toLowerCase(), bucket, key, blockId },
    { $set: { dataBase64: bodyBuffer.toString("base64"), sizeBytes: bodyBuffer.length, createdAt: new Date().toISOString() } },
    { upsert: true }
  );
}

export async function commitAzureBlockList({ walletAddress, bucket, key, blockIds, contentType }) {
  const { db } = await connectToDatabase();
  const owner = walletAddress.toLowerCase();
  const staged = await db.collection("s3_azure_wallet_blocks").find({ walletAddress: owner, bucket, key, blockId: { $in: blockIds } }).toArray();
  const byId = new Map(staged.map((b) => [b.blockId, b]));
  const missing = blockIds.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new Error(`Block(s) not found on this blob: ${missing.join(", ")}`);
  const fullBuffer = Buffer.concat(blockIds.map((id) => Buffer.from(byId.get(id).dataBase64, "base64")));
  const doc = await putS3Object({ walletAddress, bucket, key, bodyBuffer: fullBuffer, contentType });
  await db.collection("s3_azure_wallet_blocks").deleteMany({ walletAddress: owner, bucket, key });
  return doc;
}
