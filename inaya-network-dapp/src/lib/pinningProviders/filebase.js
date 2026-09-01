// src/lib/pinningProviders/filebase.js
//
// Second, independent pinning provider for backup replication -- a genuinely different
// infrastructure/failure domain than Pinata's own cluster (Filebase's IPFS storage backs onto
// Storj/Sia, not Pinata's infra), which is the actual point of provider diversity per
// docs/backup-redundancy-architecture.md. S3-compatible API (endpoint s3.filebase.com), object
// bodies stored as the raw shard ciphertext string in an IPFS-storage-class bucket; Filebase
// computes and returns a real IPFS CID for each object, exposed via the `x-amz-meta-cid` response
// header (confirmed via Filebase's own docs -- retrieved through a HeadObjectCommand immediately
// after PutObjectCommand, since the AWS SDK v3's PutObject response does not surface arbitrary
// custom headers directly).
//
// NOT YET LIVE: requires FILEBASE_ACCESS_KEY / FILEBASE_SECRET_KEY / FILEBASE_BUCKET, which have
// not been supplied yet (see docs/backup-redundancy-architecture.md's Phase 2 gate). isConfigured()
// honestly reports false until they are -- every other function throws a clear, actionable error
// rather than silently no-opping if called anyway.

import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { sha256Hex } from "./hash.js";

const ENDPOINT = "https://s3.filebase.com";
const REGION = "us-east-1"; // Filebase's IPFS endpoint is region-agnostic; the SDK still requires a value.

function getClient() {
  const accessKeyId = process.env.FILEBASE_ACCESS_KEY;
  const secretAccessKey = process.env.FILEBASE_SECRET_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("pinningProviders/filebase: FILEBASE_ACCESS_KEY / FILEBASE_SECRET_KEY are not configured.");
  }
  return new S3Client({ endpoint: ENDPOINT, region: REGION, credentials: { accessKeyId, secretAccessKey }, forcePathStyle: true });
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
