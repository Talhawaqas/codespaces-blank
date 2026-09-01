// src/lib/pinningProviders/filebase.js
//
// Second, independent pinning provider for backup replication -- a genuinely different
// infrastructure/failure domain than Pinata's own cluster (Filebase's IPFS storage backs onto
// Storj/Sia, not Pinata's infra), which is the actual point of provider diversity per
// docs/backup-redundancy-architecture.md. S3-compatible API, object bodies stored as the raw
// shard ciphertext string in an IPFS-storage-class bucket; Filebase computes and returns a real
// IPFS CID for each object, exposed via the `x-amz-meta-cid` response header (confirmed via
// Filebase's own docs -- retrieved through a HeadObjectCommand immediately after PutObjectCommand,
// since the AWS SDK v3's PutObject response does not surface arbitrary custom headers directly).
//
// Endpoint is https://s3.filebase.io (NOT .com -- confirmed live against Filebase's own S3 API
// dashboard page, 2026-09-01), region "auto" (Filebase's current recommendation; "us-east-1"
// still works for older integrations per their docs, but auto is what's shown live now).
//
// FILEBASE_ACCESS_KEY / FILEBASE_SECRET_KEY / FILEBASE_BUCKET are real, configured credentials
// (see .env.local) -- isConfigured() reports true once they're present; every other function
// throws a clear, actionable error if called without them rather than silently no-opping.

import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { sha256Hex } from "./hash.js";

const ENDPOINT = "https://s3.filebase.io";
const REGION = "auto";

function getClient() {
  const accessKeyId = process.env.FILEBASE_ACCESS_KEY;
  const secretAccessKey = process.env.FILEBASE_SECRET_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("pinningProviders/filebase: FILEBASE_ACCESS_KEY / FILEBASE_SECRET_KEY are not configured.");
  }
  return new S3Client({
    endpoint: ENDPOINT,
    region: REGION,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
    // AWS SDK v3's newer default (auto-attaching a CRC32 request checksum) trips up several
    // non-AWS S3-compatible providers, surfacing as a generic AccessDenied rather than a clear
    // checksum error -- confirmed live against Filebase specifically. Reverting to the older,
    // opt-in-only checksum behavior fixes it.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

function getBucket() {
  const bucket = process.env.FILEBASE_BUCKET;
  if (!bucket) throw new Error("pinningProviders/filebase: FILEBASE_BUCKET is not configured.");
  return bucket;
}

export function isConfigured() {
  return Boolean(process.env.FILEBASE_ACCESS_KEY && process.env.FILEBASE_SECRET_KEY && process.env.FILEBASE_BUCKET);
}

/** Pins `content` as a raw object; returns { provider: "filebase", cid, providerRef, contentHash }
 *  once Filebase's own IPFS backend has assigned a real CID (read back via HeadObject's
 *  x-amz-meta-cid). providerRef is the S3 object key -- unlike Pinata, Filebase's S3 API
 *  addresses objects by key, not by the IPFS CID it separately assigns, so fetchReplica/
 *  getPinStatus below take the key, and callers must persist providerRef (not just cid) to use
 *  them later. */
export async function pin(content, { name } = {}) {
  const client = getClient();
  const bucket = getBucket();
  const key = name || `inaya_backup_replica_${Date.now()}`;

  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: content, ContentType: "text/plain" }));

  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  const cid = head.Metadata?.cid;
  if (!cid) throw new Error("pinningProviders/filebase: object was stored but Filebase did not return an x-amz-meta-cid — the bucket may not be an IPFS-storage-class bucket.");

  return { provider: "filebase", cid, providerRef: key, contentHash: sha256Hex(content) };
}

/** Fetches a replica's content back by its Filebase object key (providerRef, not the CID). */
export async function fetchReplica(providerRef) {
  const client = getClient();
  const bucket = getBucket();
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: providerRef }));
  return await res.Body.transformToString("utf-8");
}

/** Cheap Tier-1 check: does the object still exist in the bucket? A HeadObject 404 means it's
 *  gone; any other error is treated as "unknown," not "failed," matching the grace-window
 *  discipline in backupHealth.js (a transient API error shouldn't itself count as a miss). */
export async function getPinStatus(providerRef) {
  const client = getClient();
  const bucket = getBucket();
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: providerRef }));
    return true;
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NotFound") return false;
    throw err;
  }
}

/** Permanently removes a replica -- called by recoverShard when cleaning up a failed/corrupted
 *  replica, so a dead replica doesn't sit in the bucket accumulating storage cost forever after
 *  recovery replaces it (SOW's storage-efficiency requirement: "cleanup of obsolete copies").
 *  Idempotent: a 404 on an already-gone object is not an error. */
export async function unpin(providerRef) {
  const client = getClient();
  const bucket = getBucket();
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: providerRef }));
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NotFound") return;
    throw err;
  }
}
