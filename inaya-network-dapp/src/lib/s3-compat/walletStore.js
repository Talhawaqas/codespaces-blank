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

import { randomUUID } from "node:crypto";
import { InayaKernel } from "@inaya-network/custody-sdk";
import { connectToDatabase } from "../mongodb.js";
import { getProvider, listAvailableProviders } from "../pinningProviders/index.js";
import { getOwnerS3Passphrase } from "./credentials.js";

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

function bufferToFile(buffer, { key, contentType }) {
  return new File([buffer], key, { type: contentType || "application/octet-stream" });
}

export async function putS3Object({ walletAddress, bucket, key, bodyBuffer, contentType }) {
  const bucketDoc = await ensureS3Bucket({ walletAddress, bucket });
  const passphrase = await getOwnerS3Passphrase(walletOwner(walletAddress));

  const salt = InayaKernel.generateSecureSalt();
  const encryptionKey = await InayaKernel.deriveVaultKey({ passkey: passphrase, salt });
  const file = bufferToFile(bodyBuffer, { key, contentType });
  const { shardAlpha, shardBeta } = await InayaKernel.disperseAndSlice({ file, encryptionKey });

  const provider = getProvider(primaryProviderName());
  const [alphaResult, betaResult] = await Promise.all([
    provider.pin(shardAlpha, { name: `s3-compat-wallet:${walletAddress}:${key}:alpha` }),
    provider.pin(shardBeta, { name: `s3-compat-wallet:${walletAddress}:${key}:beta` }),
  ]);

  const { db } = await connectToDatabase();
  const now = new Date().toISOString();
  const owner = walletAddress.toLowerCase();

  await db.collection("metadata_files").updateMany({ owner, folderId: bucketDoc.folderId, filename: key, deletedAt: null }, { $set: { deletedAt: now } });

  // Real content hash salted with a fresh random component -- see
  // store.js's identical fix for why: S3 must allow re-uploading identical
  // bytes (same key or a different one), which a pure content hash would
  // collide on if metadata_files enforces uniqueness anywhere downstream.
  const { createHash: createHashWallet } = await import("node:crypto");
  const fileHash = createHashWallet("sha256").update(bodyBuffer).update(randomUUID()).digest("hex");
  const doc = {
    fileHash,
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
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  await db.collection("metadata_files").insertOne(doc);
  return doc;
}

export async function headS3Object({ walletAddress, bucket, key }) {
  const bucketDoc = await getS3Bucket({ walletAddress, bucket });
  if (!bucketDoc) return null;
  const { db } = await connectToDatabase();
  return db.collection("metadata_files").findOne({ owner: walletAddress.toLowerCase(), folderId: bucketDoc.folderId, filename: key, deletedAt: null });
}

export async function getS3ObjectBody({ walletAddress, bucket, key }) {
  const doc = await headS3Object({ walletAddress, bucket, key });
  if (!doc) return null;
  const passphrase = await getOwnerS3Passphrase(walletOwner(walletAddress));
  const provider = getProvider(doc.pinProvider || primaryProviderName());
  const [shardAlpha, shardBeta] = await Promise.all([provider.fetchReplica(doc.cidAlpha), provider.fetchReplica(doc.cidBeta)]);
  const dataUrl = await InayaKernel.reconstructAndDecrypt({ shardAlpha, shardBeta, passkey: passphrase });
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return { doc, buffer: Buffer.from(base64, "base64") };
}

export async function deleteS3Object({ walletAddress, bucket, key }) {
  const doc = await headS3Object({ walletAddress, bucket, key });
  if (!doc) return { deleted: true };
  const { db } = await connectToDatabase();
  await db.collection("metadata_files").updateOne({ fileHash: doc.fileHash, owner: doc.owner }, { $set: { deletedAt: new Date().toISOString() } });
  return { deleted: true };
}

export async function listS3Objects({ walletAddress, bucket, prefix = "", delimiter = "", maxKeys = 1000 }) {
  const bucketDoc = await getS3Bucket({ walletAddress, bucket });
  if (!bucketDoc) return null;
  const { db } = await connectToDatabase();
  const docs = await db
    .collection("metadata_files")
    .find({ owner: walletAddress.toLowerCase(), folderId: bucketDoc.folderId, deletedAt: null, filename: { $regex: `^${escapeRegExp(prefix)}` } })
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
  return { contents: contents.slice(0, maxKeys), commonPrefixes: [...commonPrefixes].sort(), isTruncated: contents.length > maxKeys };
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
