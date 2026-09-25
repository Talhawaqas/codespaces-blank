// src/lib/documentAutomation/storage.js
//
// Document Automation SOW §15 -- sovereign storage. Finalized documents go
// through the SAME real pipeline every other Inaya object uses
// (s3-compat/store.js: server-managed AES-256-GCM encryption, binary
// sharding, DePIN pinning, backupEngine registration) -- nothing here is a
// parallel storage system, and no plaintext document ever touches a
// temporary file: the renderer produces an in-memory Buffer that is
// encrypted straight into storage, so there is no OneDrive-style temporary
// copy to secure or clean up (the renderer writes nothing to disk).
//
// Immutability: each org's document bucket has Versioning enabled and
// Object Lock switched on, and a finalized document's objects get a
// retention period (settings.retention) -- so "approved documents are never
// silently modified or deleted" is enforced by the storage layer, not just
// by application code.

import { putS3Object, getS3ObjectBody, putBucketVersioning, enableBucketObjectLock, putObjectRetention, getS3Bucket } from "../s3-compat/store.js";
import { ensureOwnerS3Passphrase } from "../s3-compat/credentials.js";
import { listAvailableProviders } from "../pinningProviders/index.js";
import { hashDocumentBytes } from "./manifest.js";

const BUCKET_PREFIX = "generated-documents";
const ensured = new Set();

export function documentBucket(orgId) {
  return `${BUCKET_PREFIX}-${String(orgId)}`.toLowerCase();
}

export function documentKey({ documentType, documentId, version, number, stage }) {
  const safeNumber = String(number || "unnumbered").replace(/[^A-Za-z0-9._-]/g, "_");
  return `${documentType}/${documentId}/v${version}/${safeNumber}${stage === "draft" ? "-draft" : ""}.pdf`;
}

/** Idempotently makes the org's document bucket versioned + lock-enabled.
 *  Best effort: a failure here must not stop document generation, but the
 *  outcome is reported so it can be recorded as evidence. */
export async function ensureDocumentBucket(orgId, actorEmail) {
  const bucket = documentBucket(orgId);
  const cacheKey = `${orgId}`;
  if (ensured.has(cacheKey)) return { bucket, locked: true };
  let locked = false;
  try {
    await ensureOwnerS3Passphrase({ type: "org", orgId });
    const existing = await getS3Bucket({ orgId, bucket });
    if (!existing || existing.versioningStatus !== "Enabled") await putBucketVersioning({ orgId, bucket, status: "Enabled" });
    const after = await getS3Bucket({ orgId, bucket });
    if (!after?.objectLockEnabled) await enableBucketObjectLock({ orgId, bucket });
    locked = true;
    ensured.add(cacheKey);
  } catch (err) {
    console.error("ensureDocumentBucket: could not enable versioning/object lock (non-fatal):", err.message);
  }
  return { bucket, locked };
}

export async function storeDocumentBytes({ orgId, key, bytes, actorEmail, tags }) {
  const { bucket } = await ensureDocumentBucket(orgId, actorEmail);
  await ensureOwnerS3Passphrase({ type: "org", orgId });
  // Resilience: if the default pinning provider rejects the write (an
  // outage, or an exhausted plan -- a real failure seen in this
  // environment), fall back to every other configured provider in turn
  // before declaring the storage step failed. putS3Object pins BEFORE it
  // writes any database row, so a failed attempt leaves nothing behind.
  // Same preference as the storage layer's own default (Pinata first), then
  // every other configured provider.
  const configured = listAvailableProviders();
  const attempts = configured.length ? [...configured].sort((a, b) => (a === "pinata" ? -1 : b === "pinata" ? 1 : 0)) : [undefined];
  let lastError;
  for (const providerName of attempts) {
    const label = providerName || "default";
    try {
      const obj = await putS3Object({ orgId, bucket, key, bodyBuffer: bytes, contentType: "application/pdf", actorEmail, tags, providerName });
      return { bucket, key, objectId: String(obj._id), versionId: obj.versionId, contentSha256: obj.contentSha256, sizeBytes: obj.sizeBytes, pinProvider: obj.pinProvider, fallbackUsed: providerName !== attempts[0] };
    } catch (err) {
      lastError = err;
      console.error(`storeDocumentBytes: provider "${label}" failed (${err.message.slice(0, 120)}); trying the next one`);
    }
  }
  throw lastError;
}

/** Reads and decrypts a stored document, and proves the bytes still match
 *  the recorded hash (storage verification, §15/§20). */
export async function readDocumentBytes({ orgId, storageReference, expectedHash }) {
  if (!storageReference?.bucket || !storageReference?.key) return { error: "This document has no stored content.", status: 404 };
  const got = await getS3ObjectBody({ orgId: String(orgId), bucket: storageReference.bucket, key: storageReference.key, versionId: storageReference.versionId && storageReference.versionId !== "null" ? storageReference.versionId : undefined });
  if (!got) return { error: "This document's stored content could not be retrieved.", status: 502 };
  const actualHash = hashDocumentBytes(got.buffer);
  return { buffer: got.buffer, actualHash, hashMatches: expectedHash ? actualHash === expectedHash : null };
}

/** Applies the retention lock to a finalized object (non-fatal: the
 *  outcome is returned so it can be recorded, never silently ignored). */
export async function lockFinalizedObject({ orgId, storageReference, retentionDays, lockMode = "GOVERNANCE", actorEmail }) {
  if (!retentionDays || retentionDays <= 0) return { locked: false, reason: "Retention is disabled for this organization." };
  try {
    const retentionUntil = new Date(Date.now() + retentionDays * 86400000).toISOString();
    await putObjectRetention({ orgId, bucket: storageReference.bucket, key: storageReference.key, versionId: storageReference.versionId && storageReference.versionId !== "null" ? storageReference.versionId : undefined, retentionMode: lockMode, retentionUntil, actorEmail });
    return { locked: true, retentionUntil, lockMode };
  } catch (err) {
    return { locked: false, reason: err.message };
  }
}
