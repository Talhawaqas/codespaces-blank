// src/lib/nas/cloudTargets.js
//
// Sovereign NAS SOW Workstream O (multi-cloud backup and restore): ONE
// policy/orchestration layer over storage adapters -- not four backup
// engines. Backup (backup.js) talks to a target only through
// { put, get, head } so the engine is the same for every destination.
//
// Target kinds, with what has actually been tested (SOW 46 "only claim a
// provider/operation that has actually been tested"):
//   inaya-sovereign  the existing s3-compat pipeline (encrypt -> shard -> pin
//                    -> replicate). Always available. TESTED.
//   s3-compatible    any S3-API endpoint via the AWS SDK (AWS S3, Filebase,
//                    Wasabi, MinIO...). Verified per target by a write/read/
//                    delete probe. TESTED against a real provider (Filebase).
//   gcs-interop      Google Cloud Storage's S3-interoperability endpoint with
//                    HMAC keys. Uses the same client as s3-compatible; it is
//                    UNTESTED here (no GCS account), so a target of this kind
//                    is unusable until its own connection test passes.
//   Azure Blob       NOT implemented as an outbound target (no SDK dependency
//                    and no account to validate against). Inaya's inbound
//                    Azure-compatible endpoint is unrelated to this.
//
// Endpoint safety: only https, no embedded credentials, and the hostname must
// resolve to public addresses -- a target can never be used to make the server
// call an internal address (SSRF).

import dns from "node:dns/promises";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { putS3Object, getS3ObjectBody } from "../s3-compat/store.js";
import { putS3ObjectWithFallback } from "../s3-compat/putWithFallback.js";
import { ensureOwnerS3Passphrase } from "../s3-compat/credentials.js";
import { encryptNasSecret, decryptNasSecret, isNasCredentialCryptoConfigured } from "./credentials.js";
import { fail, gate } from "./common.js";
import { recordNasEvidence } from "./evidence.js";

export const TARGET_KINDS = ["inaya-sovereign", "s3-compatible", "gcs-interop"];
export const INAYA_TARGET_ID = "inaya";
const MAX_OBJECT_BYTES = 256 * 1024 * 1024;

function isPrivateAddress(addr) {
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = addr.toLowerCase();
  return v === "::1" || v === "::" || v.startsWith("fe80") || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("::ffff:127.") || v.startsWith("::ffff:10.") || v.startsWith("::ffff:192.168.");
}

/** Throws a plain Error with a safe message when the endpoint is unsafe. */
export async function assertSafeEndpoint(endpoint) {
  let u;
  try { u = new URL(endpoint); } catch { throw new Error("The endpoint is not a valid URL."); }
  if (u.protocol !== "https:") throw new Error("Only https endpoints are allowed.");
  if (u.username || u.password) throw new Error("Credentials must not be embedded in the endpoint URL.");
  if (net.isIP(u.hostname) && isPrivateAddress(u.hostname)) throw new Error("The endpoint points at a private address.");
  if (u.hostname === "localhost" || u.hostname.endsWith(".local") || u.hostname.endsWith(".internal")) throw new Error("The endpoint points at a private host name.");
  if (!net.isIP(u.hostname)) {
    let addrs;
    try { addrs = await dns.lookup(u.hostname, { all: true }); } catch { throw new Error("The endpoint host name could not be resolved."); }
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error("The endpoint resolves to a private address.");
  }
  return u;
}

function s3Client(target, secret) {
  return new S3Client({ endpoint: target.endpoint, region: target.region || "us-east-1", forcePathStyle: true, credentials: { accessKeyId: target.accessKeyId, secretAccessKey: secret }, maxAttempts: 3 });
}

async function bodyToBuffer(body) {
  const chunks = [];
  for await (const c of body) chunks.push(c);
  return Buffer.concat(chunks);
}

/** The storage adapter backup/restore use. put/get/head are the whole contract. */
export async function getTargetAdapter({ orgId, appliance, targetId, actorEmail }) {
  if (!targetId || targetId === INAYA_TARGET_ID) {
    await ensureOwnerS3Passphrase({ type: "org", orgId });
    const bucket = appliance.backupBucket;
    return {
      kind: "inaya-sovereign", targetKey: INAYA_TARGET_ID, label: "Inaya sovereign storage", bucket,
      async put({ key, buffer, contentType, tags }) {
        const { obj, providerName, fallbackUsed } = await putS3ObjectWithFallback({ orgId, bucket, key, bodyBuffer: buffer, contentType, actorEmail, tags });
        return { objectKey: key, versionId: obj.versionId && obj.versionId !== "null" ? obj.versionId : null, provider: providerName, fallbackUsed, sizeBytes: buffer.length };
      },
      async get({ key, versionId }) {
        const got = await getS3ObjectBody({ orgId: String(orgId), bucket, key, versionId: versionId || undefined });
        return got ? got.buffer : null;
      },
    };
  }
  const { nasCloudTargets } = await getOrgCollections();
  let target;
  try { target = await nasCloudTargets.findOne({ _id: toObjectId(targetId), orgId: toObjectId(orgId), deletedAt: null }); } catch { target = null; }
  if (!target) throw Object.assign(new Error("Cloud target not found."), { code: "NOT_FOUND" });
  if (target.kind === "gcs-interop" && !target.verified) throw Object.assign(new Error("This Google interoperability target has not passed its connection test; it is untested and cannot be used."), { code: "UNVERIFIED_TARGET" });
  if (!target.verified) throw Object.assign(new Error("This target has not passed its connection test yet."), { code: "UNVERIFIED_TARGET" });
  await assertSafeEndpoint(target.endpoint);
  const client = s3Client(target, decryptNasSecret(target.secretCredential));
  const prefix = target.prefix ? target.prefix.replace(/^\/+|\/+$/g, "") + "/" : "";
  return {
    kind: target.kind, targetKey: String(target._id), label: target.label, bucket: target.bucket,
    async put({ key, buffer, contentType }) {
      if (buffer.length > MAX_OBJECT_BYTES) throw new Error("Object too large for a single upload.");
      const out = await client.send(new PutObjectCommand({ Bucket: target.bucket, Key: prefix + key, Body: buffer, ContentType: contentType || "application/octet-stream" }));
      return { objectKey: prefix + key, versionId: out.VersionId || null, provider: target.kind, fallbackUsed: false, sizeBytes: buffer.length };
    },
    async get({ key, versionId }) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: target.bucket, Key: key.startsWith(prefix) ? key : prefix + key, ...(versionId ? { VersionId: versionId } : {}) }));
        return await bodyToBuffer(out.Body);
      } catch (err) {
        if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },
  };
}

// ------------------------------------------------------------------ CRUD
function publicTarget(t) {
  const { secretCredential, ...rest } = t;
  return rest;
}

export async function createCloudTarget({ orgId, kind, label, endpoint, region, bucket, prefix = "", accessKeyId, secretAccessKey, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  if (!isNasCredentialCryptoConfigured()) return fail("NAS_ENCRYPTION_KEY is not configured on this server.", 500);
  if (!TARGET_KINDS.includes(kind) || kind === "inaya-sovereign") return fail("kind must be s3-compatible or gcs-interop (Inaya sovereign storage is built in).");
  if (!label?.trim() || !bucket?.trim() || !accessKeyId?.trim() || !secretAccessKey) return fail("label, bucket, accessKeyId and secretAccessKey are required.");
  if (!/^[a-z0-9][a-z0-9.-]{1,62}$/.test(bucket)) return fail("The bucket name is not valid.");
  const ep = kind === "gcs-interop" ? (endpoint || "https://storage.googleapis.com") : endpoint;
  try { await assertSafeEndpoint(ep); } catch (err) { return fail(err.message, 400); }
  const { nasCloudTargets } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), kind, label: label.trim().slice(0, 80), endpoint: ep, region: region || "us-east-1", bucket: bucket.trim(), prefix: String(prefix || "").slice(0, 100),
    accessKeyId: accessKeyId.trim(), secretCredential: encryptNasSecret(secretAccessKey), verified: false,
    health: { lastSuccessAt: null, lastFailureAt: null, lastError: null, bytesTransferred: 0, lastVerification: null }, createdBy: actorEmail, createdAt: now, deletedAt: null,
  };
  const r = await nasCloudTargets.insertOne(doc);
  return { target: publicTarget({ ...doc, _id: r.insertedId }) };
}

export async function listCloudTargets({ orgId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const { nasCloudTargets } = await getOrgCollections();
  const targets = await nasCloudTargets.find({ orgId: toObjectId(orgId), deletedAt: null }).sort({ createdAt: -1 }).toArray();
  return { targets: [{ _id: INAYA_TARGET_ID, kind: "inaya-sovereign", label: "Inaya sovereign storage", verified: true, builtIn: true }, ...targets.map(publicTarget)] };
}

export async function deleteCloudTarget({ orgId, targetId, membership }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const { nasCloudTargets, nasBackupPolicies } = await getOrgCollections();
  const t = await nasCloudTargets.findOne({ _id: toObjectId(targetId), orgId: toObjectId(orgId), deletedAt: null });
  if (!t) return fail("Target not found.", 404);
  if (await nasBackupPolicies.findOne({ orgId: toObjectId(orgId), targetIds: String(t._id) })) return fail("A backup policy still uses this target.", 409);
  await nasCloudTargets.updateOne({ _id: t._id }, { $set: { deletedAt: new Date().toISOString() } });
  return { deleted: true };
}

/** Write a random probe object, read it back, compare, delete it. */
export async function testCloudTarget({ orgId, targetId, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const { nasCloudTargets } = await getOrgCollections();
  const t = await nasCloudTargets.findOne({ _id: toObjectId(targetId), orgId: toObjectId(orgId), deletedAt: null });
  if (!t) return fail("Target not found.", 404);
  const probe = randomBytes(2048);
  const key = `.inaya-nas-probe/${randomBytes(6).toString("hex")}`;
  const started = Date.now();
  try {
    await assertSafeEndpoint(t.endpoint);
    const client = s3Client(t, decryptNasSecret(t.secretCredential));
    const prefix = t.prefix ? t.prefix.replace(/^\/+|\/+$/g, "") + "/" : "";
    await client.send(new PutObjectCommand({ Bucket: t.bucket, Key: prefix + key, Body: probe }));
    const got = await client.send(new GetObjectCommand({ Bucket: t.bucket, Key: prefix + key }));
    const back = await bodyToBuffer(got.Body);
    await client.send(new DeleteObjectCommand({ Bucket: t.bucket, Key: prefix + key })).catch(() => {});
    if (Buffer.compare(back, probe) !== 0) throw new Error("The probe object read back differently from what was written.");
    await nasCloudTargets.updateOne({ _id: t._id }, { $set: { verified: true, "health.lastSuccessAt": new Date().toISOString(), "health.lastError": null, "health.lastVerification": { ok: true, at: new Date().toISOString(), latencyMs: Date.now() - started } } });
    return { verified: true, latencyMs: Date.now() - started };
  } catch (err) {
    const msg = String(err.message || err.name).slice(0, 300);
    await nasCloudTargets.updateOne({ _id: t._id }, { $set: { verified: false, "health.lastFailureAt": new Date().toISOString(), "health.lastError": msg, "health.lastVerification": { ok: false, at: new Date().toISOString(), error: msg } } });
    return { verified: false, error: msg };
  }
}

export async function recordTargetResult({ orgId, targetKey, ok, bytes = 0, error = null }) {
  if (!targetKey || targetKey === INAYA_TARGET_ID) return;
  const { nasCloudTargets } = await getOrgCollections();
  try {
    await nasCloudTargets.updateOne({ _id: toObjectId(targetKey), orgId: toObjectId(orgId) }, ok ? { $set: { "health.lastSuccessAt": new Date().toISOString(), "health.lastError": null }, $inc: { "health.bytesTransferred": bytes } } : { $set: { "health.lastFailureAt": new Date().toISOString(), "health.lastError": String(error).slice(0, 300) } });
  } catch { /* health bookkeeping must never fail a backup */ }
}
