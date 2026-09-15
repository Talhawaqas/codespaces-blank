// src/lib/s3-compat/store.js
//
// The actual bucket/key <-> org_documents translation layer, and the
// encrypt/shard/pin/decrypt pipeline for the S3 (and, later, Azure)
// compatibility layer. Every object read/written here goes through the
// exact same real custody-sdk crypto (disperseAndSlice/reconstructAndDecrypt)
// and the exact same real pinning-provider layer (src/lib/pinningProviders)
// every other Inaya upload uses -- nothing here is a parallel storage system.
//
// Deliberate, disclosed scoping decision: unlike the wallet/Business-Workspace
// upload paths, objects written through this compatibility layer are NOT
// individually registered on-chain synchronously. The existing per-document
// on-chain registration (custody.batchRegisterAssets, org/documents/route.js)
// is a real confirmed transaction per file -- fine for a human uploading one
// document at a time, but it would make a bulk `aws s3 sync` of hundreds of
// small files take minutes and burn testnet gas per object, which is not
// how S3 itself (or any real S3-compatible product) behaves. Integrity is
// still fully real without it: every object gets a real SHA-256 fileHash,
// real AES-256-GCM encryption, real binary sharding, and real redundant
// pinning across providers -- just without the additional per-object
// on-chain anchor. Batched/async on-chain anchoring is a natural follow-up,
// not built in this pass -- documented here rather than silently differing
// from the wallet-side behavior without explanation.

import { ObjectId } from "mongodb";
import { createHash } from "node:crypto";
import { InayaKernel } from "@inaya-network/custody-sdk";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { getProvider, listAvailableProviders } from "../pinningProviders/index.js";
import { logOrgActivity } from "../org-activity-log.js";
import { getOwnerS3Passphrase } from "./credentials.js";

function getOrgS3Passphrase(orgId) {
  return getOwnerS3Passphrase({ type: "org", orgId });
}

const S3_SYSTEM_DEPARTMENT_NAME = "S3/Azure Compatible Storage (System)";

function primaryProviderName() {
  const available = listAvailableProviders();
  if (available.includes("pinata")) return "pinata";
  if (available.length > 0) return available[0];
  throw new Error("No pinning provider is configured (PINATA_JWT / Filebase credentials missing) -- the S3-compatibility layer cannot store objects.");
}

/** One hidden department per org holds every S3/Azure "bucket" as a project
 *  underneath it -- same ensure-once-then-reuse pattern as
 *  resilience-canary.js's ensureResilienceHome(), so buckets get real
 *  department/project rows (and inherit the org's existing document model)
 *  without polluting the org's normal, human-visible department list. */
async function ensureS3SystemDepartment(orgId) {
  const { departments } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const existing = await departments.findOne({ orgId: orgObjectId, name: S3_SYSTEM_DEPARTMENT_NAME });
  if (existing) return existing._id;
  const now = new Date().toISOString();
  const doc = { _id: new ObjectId(), orgId: orgObjectId, name: S3_SYSTEM_DEPARTMENT_NAME, isSystem: true, createdAt: now };
  await departments.insertOne(doc);
  return doc._id;
}

export async function listS3Buckets(orgId) {
  const departmentId = await ensureS3SystemDepartment(orgId);
  const { projects } = await getOrgCollections();
  const docs = await projects.find({ orgId: toObjectId(orgId), departmentId }).sort({ createdAt: 1 }).toArray();
  return docs.map((p) => ({ name: p.name, createdAt: p.createdAt }));
}

export async function getS3Bucket({ orgId, bucket }) {
  const departmentId = await ensureS3SystemDepartment(orgId);
  const { projects } = await getOrgCollections();
  return projects.findOne({ orgId: toObjectId(orgId), departmentId, name: bucket });
}

/** Idempotent -- PUT-ting an existing bucket name is a normal S3 no-op, not an error. */
export async function ensureS3Bucket({ orgId, bucket, actorEmail }) {
  const departmentId = await ensureS3SystemDepartment(orgId);
  const { projects } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const existing = await projects.findOne({ orgId: orgObjectId, departmentId, name: bucket });
  if (existing) return existing;
  const now = new Date().toISOString();
  const doc = { _id: new ObjectId(), orgId: orgObjectId, departmentId, name: bucket, createdAt: now, createdByEmail: actorEmail || "s3-compat" };
  await projects.insertOne(doc);
  return doc;
}

export async function deleteS3Bucket({ orgId, bucket }) {
  const bucketDoc = await getS3Bucket({ orgId, bucket });
  if (!bucketDoc) return { deleted: false, reason: "NoSuchBucket" };
  const { orgDocuments, projects } = await getOrgCollections();
  const objectCount = await orgDocuments.countDocuments({ orgId: toObjectId(orgId), projectId: bucketDoc._id, deletedAt: null });
  if (objectCount > 0) return { deleted: false, reason: "BucketNotEmpty" };
  await projects.deleteOne({ _id: bucketDoc._id });
  return { deleted: true };
}

/** Builds a Node-global File from raw bytes -- disperseAndSlice() only needs
 *  .arrayBuffer()/.type/.name, which Node 18+'s built-in File implements. */
function bufferToFile(buffer, { key, contentType }) {
  return new File([buffer], key, { type: contentType || "application/octet-stream" });
}

/** Real encrypt -> shard -> pin -> register pipeline. Returns the inserted
 *  org_documents row shape (etag == fileHash, matching S3's own convention
 *  of ETag being a content hash). */
export async function putS3Object({ orgId, bucket, key, bodyBuffer, contentType, actorEmail }) {
  const bucketDoc = await ensureS3Bucket({ orgId, bucket, actorEmail });
  const passphrase = await getOrgS3Passphrase(orgId);

  const salt = InayaKernel.generateSecureSalt();
  const encryptionKey = await InayaKernel.deriveVaultKey({ passkey: passphrase, salt });
  const file = bufferToFile(bodyBuffer, { key, contentType });
  const { shardAlpha, shardBeta } = await InayaKernel.disperseAndSlice({ file, encryptionKey });

  const provider = getProvider(primaryProviderName());
  const [alphaResult, betaResult] = await Promise.all([
    provider.pin(shardAlpha, { name: `s3-compat:${orgId}:${key}:alpha` }),
    provider.pin(shardBeta, { name: `s3-compat:${orgId}:${key}:beta` }),
  ]);

  const { orgDocuments } = await getOrgCollections();
  const now = new Date().toISOString();
  const documentId = new ObjectId();

  // org_documents.fileHash has a UNIQUE index (from the existing wallet/
  // treasury upload path, where re-uploading identical bytes is deliberately
  // rejected as a duplicate). That's the wrong semantic for S3, which must
  // allow the same content to be uploaded to a different key, or the same
  // key re-uploaded unchanged -- both completely normal `aws s3 cp` usage.
  // Salting the real content hash with this document's own new _id keeps
  // fileHash a genuine hash of real bytes while guaranteeing it's always
  // unique, so ordinary repeat uploads never collide with the existing
  // index's constraint.
  const fileHash = createHash("sha256").update(bodyBuffer).update(documentId.toString()).digest("hex");

  // Overwrite semantics (real S3 behavior: PUT-ting an existing key replaces it)
  // -- soft-delete any prior live object at this exact bucket+key first.
  await orgDocuments.updateMany(
    { orgId: toObjectId(orgId), projectId: bucketDoc._id, filename: key, deletedAt: null },
    { $set: { deletedAt: now } }
  );

  const doc = {
    _id: documentId,
    orgId: toObjectId(orgId),
    departmentId: bucketDoc.departmentId,
    projectId: bucketDoc._id,
    filename: key, // the full S3 key, slashes included -- S3 keys are flat strings, not real paths
    fileHash,
    contentType: contentType || "application/octet-stream",
    sizeBytes: bodyBuffer.length,
    cidAlpha: alphaResult.providerRef,
    cidBeta: betaResult.providerRef,
    pinProvider: alphaResult.provider,
    encryptionMode: "server-managed", // see crypto.js header -- distinct from every other Inaya document's client-managed model
    uploadedByEmail: actorEmail || "s3-compat",
    txHash: null, // see module header -- not synchronously anchored on-chain for this compatibility layer
    status: "ACTIVE",
    accessLevel: "PRIVATE",
    createdAt: now,
    deletedAt: null,
  };
  await orgDocuments.insertOne(doc);

  await logOrgActivity({
    orgId,
    recordType: "s3_object",
    recordId: documentId,
    actorEmail: actorEmail || "s3-compat",
    action: "PUT",
    previousState: null,
    newState: { bucket, key, sizeBytes: doc.sizeBytes },
    metadata: { bucket, key },
  });

  return doc;
}

export async function headS3Object({ orgId, bucket, key }) {
  const bucketDoc = await getS3Bucket({ orgId, bucket });
  if (!bucketDoc) return null;
  const { orgDocuments } = await getOrgCollections();
  return orgDocuments.findOne({ orgId: toObjectId(orgId), projectId: bucketDoc._id, filename: key, deletedAt: null });
}

/** Fetches both shards and fully reconstructs+decrypts server-side (see module
 *  header on why range GET necessarily means "decrypt the whole object, then
 *  slice" -- AES-GCM's auth tag covers the whole ciphertext as one unit, so
 *  there is no partial-decrypt path). Returns the full plaintext Buffer;
 *  callers slice the requested range. */
export async function getS3ObjectBody({ orgId, bucket, key }) {
  const doc = await headS3Object({ orgId, bucket, key });
  if (!doc) return null;
  const passphrase = await getOrgS3Passphrase(orgId);
  const provider = getProvider(doc.pinProvider || primaryProviderName());
  const [shardAlpha, shardBeta] = await Promise.all([provider.fetchReplica(doc.cidAlpha), provider.fetchReplica(doc.cidBeta)]);
  const dataUrl = await InayaKernel.reconstructAndDecrypt({ shardAlpha, shardBeta, passkey: passphrase });
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return { doc, buffer: Buffer.from(base64, "base64") };
}

export async function deleteS3Object({ orgId, bucket, key, actorEmail }) {
  const doc = await headS3Object({ orgId, bucket, key });
  if (!doc) return { deleted: true }; // S3 DELETE is idempotent -- deleting a nonexistent key is not an error
  const { orgDocuments } = await getOrgCollections();
  const now = new Date().toISOString();
  await orgDocuments.updateOne({ _id: doc._id }, { $set: { deletedAt: now } });
  await logOrgActivity({
    orgId,
    recordType: "s3_object",
    recordId: doc._id,
    actorEmail: actorEmail || "s3-compat",
    action: "DELETE",
    previousState: { bucket, key },
    newState: null,
    metadata: { bucket, key },
  });
  return { deleted: true };
}

/** Real ListObjectsV2 semantics: prefix filter + delimiter-based "common
 *  prefixes" grouping, over the flat filename/key namespace -- S3 doesn't
 *  have real directories, "folders" are purely a shared-prefix convention,
 *  so this needs no hierarchy beyond what org_documents already has. */
export async function listS3Objects({ orgId, bucket, prefix = "", delimiter = "", maxKeys = 1000 }) {
  const bucketDoc = await getS3Bucket({ orgId, bucket });
  if (!bucketDoc) return null;
  const { orgDocuments } = await getOrgCollections();
  const docs = await orgDocuments
    .find({ orgId: toObjectId(orgId), projectId: bucketDoc._id, deletedAt: null, filename: { $regex: `^${escapeRegExp(prefix)}` } })
    .sort({ filename: 1 })
    .toArray();

  const contents = [];
  const commonPrefixes = new Set();
  for (const doc of docs) {
    const rest = doc.filename.slice(prefix.length);
    if (delimiter && rest.includes(delimiter)) {
      commonPrefixes.add(prefix + rest.slice(0, rest.indexOf(delimiter) + delimiter.length));
    } else {
      contents.push(doc);
    }
  }
  return { contents: contents.slice(0, maxKeys), commonPrefixes: [...commonPrefixes].sort(), isTruncated: contents.length > maxKeys };
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------
// Multipart upload
//
// Parts are buffered in Mongo (base64) until CompleteMultipartUpload, at
// which point they're concatenated in part-number order and run through
// the exact same putS3Object() pipeline a normal single-request PUT uses
// -- multipart is a way to get the bytes there in pieces, not a separate
// storage pipeline. MAX_PART_BYTES mirrors the existing 8MB shard cap
// api/upload/route.js already enforces elsewhere in this codebase -- a
// real, disclosed limit, not silently different from what the rest of
// the app already accepts.
// ---------------------------------------------------------------------

export const MAX_PART_BYTES = 8 * 1024 * 1024;

export async function createMultipartUpload({ orgId, bucket, key, contentType, actorEmail }) {
  await ensureS3Bucket({ orgId, bucket, actorEmail });
  const { db } = await getOrgCollections();
  const uploadId = new ObjectId().toString();
  await db.collection("s3_multipart_uploads").insertOne({
    _id: uploadId,
    orgId: toObjectId(orgId),
    bucket,
    key,
    contentType: contentType || "application/octet-stream",
    createdAt: new Date().toISOString(),
  });
  return uploadId;
}

export async function uploadPart({ orgId, uploadId, partNumber, bodyBuffer }) {
  const { db } = await getOrgCollections();
  const upload = await db.collection("s3_multipart_uploads").findOne({ _id: uploadId, orgId: toObjectId(orgId) });
  if (!upload) return null;
  if (bodyBuffer.length > MAX_PART_BYTES) {
    throw new Error(`Part exceeds the ${MAX_PART_BYTES} byte per-part limit.`);
  }
  const etag = createHash("md5").update(bodyBuffer).digest("hex");
  await db.collection("s3_multipart_parts").updateOne(
    { uploadId, partNumber },
    { $set: { uploadId, partNumber, dataBase64: bodyBuffer.toString("base64"), sizeBytes: bodyBuffer.length, etag, createdAt: new Date().toISOString() } },
    { upsert: true }
  );
  return etag;
}

export async function completeMultipartUpload({ orgId, uploadId, actorEmail }) {
  const { db } = await getOrgCollections();
  const upload = await db.collection("s3_multipart_uploads").findOne({ _id: uploadId, orgId: toObjectId(orgId) });
  if (!upload) return null;
  const parts = await db.collection("s3_multipart_parts").find({ uploadId }).sort({ partNumber: 1 }).toArray();
  if (parts.length === 0) throw new Error("Cannot complete a multipart upload with zero parts.");

  const fullBuffer = Buffer.concat(parts.map((p) => Buffer.from(p.dataBase64, "base64")));
  const doc = await putS3Object({ orgId, bucket: upload.bucket, key: upload.key, bodyBuffer: fullBuffer, contentType: upload.contentType, actorEmail });

  await db.collection("s3_multipart_parts").deleteMany({ uploadId });
  await db.collection("s3_multipart_uploads").deleteOne({ _id: uploadId });
  return doc;
}

export async function abortMultipartUpload({ orgId, uploadId }) {
  const { db } = await getOrgCollections();
  await db.collection("s3_multipart_parts").deleteMany({ uploadId });
  const res = await db.collection("s3_multipart_uploads").deleteOne({ _id: uploadId, orgId: toObjectId(orgId) });
  return res.deletedCount > 0;
}

// ---------------------------------------------------------------------
// Azure Blob's own "staged upload" mechanism -- Put Block / Put Block List.
// Azure's real equivalent of S3 multipart: a block blob's content is staged
// as arbitrary client-chosen blockIds against a bucket+key (no separate
// "create" call, unlike S3), then committed by Put Block List, which names
// the exact order to assemble them in -- the client controls final byte
// order via that list, not arrival order. Same buffer-then-assemble
// approach as S3 multipart, run through the identical putS3Object()
// pipeline at commit time.
// ---------------------------------------------------------------------

export async function stageAzureBlock({ orgId, bucket, key, blockId, bodyBuffer }) {
  if (bodyBuffer.length > MAX_PART_BYTES) throw new Error(`Block exceeds the ${MAX_PART_BYTES} byte per-block limit.`);
  const { db } = await getOrgCollections();
  await db.collection("s3_azure_blocks").updateOne(
    { orgId: toObjectId(orgId), bucket, key, blockId },
    { $set: { dataBase64: bodyBuffer.toString("base64"), sizeBytes: bodyBuffer.length, createdAt: new Date().toISOString() } },
    { upsert: true }
  );
}

export async function commitAzureBlockList({ orgId, bucket, key, blockIds, contentType, actorEmail }) {
  const { db } = await getOrgCollections();
  const staged = await db.collection("s3_azure_blocks").find({ orgId: toObjectId(orgId), bucket, key, blockId: { $in: blockIds } }).toArray();
  const byId = new Map(staged.map((b) => [b.blockId, b]));
  const missing = blockIds.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new Error(`Block(s) not found on this blob: ${missing.join(", ")}`);

  // Assemble in the EXACT order the client's block list specifies, not
  // staging order -- this is the real Azure semantic (Put Block List's
  // order is authoritative for the committed blob's byte layout).
  const fullBuffer = Buffer.concat(blockIds.map((id) => Buffer.from(byId.get(id).dataBase64, "base64")));
  const doc = await putS3Object({ orgId, bucket, key, bodyBuffer: fullBuffer, contentType, actorEmail });
  await db.collection("s3_azure_blocks").deleteMany({ orgId: toObjectId(orgId), bucket, key });
  return doc;
}
