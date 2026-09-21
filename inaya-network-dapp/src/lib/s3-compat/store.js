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
import { replicateShard, getBackupStatus } from "../backupEngine.js";

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

// ---------------------------------------------------------------------
// Granular capability: bucket-level Versioning + Object Lock (Storj-Inspired
// Storage Capability Expansion SOW, §3/§4). Real S3 requires Object Lock to
// be enabled together with (never without) Versioning, since a lock
// protects a specific VERSION -- enforced below, not just documented.
// ---------------------------------------------------------------------

export async function putBucketVersioning({ orgId, bucket, status }) {
  if (!["Enabled", "Suspended"].includes(status)) throw new Error('status must be "Enabled" or "Suspended".');
  const bucketDoc = await ensureS3Bucket({ orgId, bucket });
  const { projects } = await getOrgCollections();
  // Real S3 semantic: once Enabled, a bucket can go to Suspended but never
  // back to "never versioned" -- existing versions must stay retrievable.
  if (bucketDoc.versioningStatus == null && status === "Suspended") {
    throw new Error("Versioning cannot be suspended before it has ever been enabled.");
  }
  await projects.updateOne({ _id: bucketDoc._id }, { $set: { versioningStatus: status } });
  return { bucket, versioningStatus: status };
}

export async function getBucketVersioning({ orgId, bucket }) {
  const bucketDoc = await getS3Bucket({ orgId, bucket });
  if (!bucketDoc) return null;
  return { versioningStatus: bucketDoc.versioningStatus || "Unversioned", objectLockEnabled: !!bucketDoc.objectLockEnabled };
}

/** Object Lock may only be enabled on a bucket with Versioning already
 *  Enabled (real S3's own precondition) -- checked here, not left to the
 *  caller to remember. Once enabled it cannot be disabled (matching real
 *  S3 -- Object Lock is a one-way, create-time-or-explicit-enable setting
 *  precisely because retroactive disabling would defeat the point of a
 *  retention/legal-hold guarantee an admin or auditor may already be
 *  relying on). */
export async function enableBucketObjectLock({ orgId, bucket }) {
  const bucketDoc = await ensureS3Bucket({ orgId, bucket });
  if (bucketDoc.versioningStatus !== "Enabled") {
    throw new Error("Object Lock requires bucket Versioning to be Enabled first.");
  }
  const { projects } = await getOrgCollections();
  await projects.updateOne({ _id: bucketDoc._id }, { $set: { objectLockEnabled: true } });
  return { bucket, objectLockEnabled: true };
}

/** Throws if the given live document is currently protected from deletion/
 *  overwrite -- the ONE real enforcement chokepoint both deleteS3Object and
 *  the non-versioned-overwrite path in putS3Object call through, so a lock
 *  or legal hold can never be bypassed by hitting a different code path
 *  (S3 API, Business Workspace, or any future caller) -- server-enforced,
 *  never a frontend-only check, per the SOW's own explicit requirement. */
function assertNotProtected(doc, actionLabel) {
  if (!doc) return;
  if (doc.legalHold) {
    throw new ObjectProtectedError(`Cannot ${actionLabel}: object is under legal hold.`, "LegalHold");
  }
  if (doc.retentionUntil && new Date(doc.retentionUntil).getTime() > Date.now()) {
    throw new ObjectProtectedError(`Cannot ${actionLabel}: object is retention-locked (${doc.retentionMode}) until ${doc.retentionUntil}.`, "ObjectLocked");
  }
}

export class ObjectProtectedError extends Error {
  constructor(message, reason) {
    super(message);
    this.reason = reason; // "LegalHold" | "ObjectLocked"
  }
}

export async function putObjectRetention({ orgId, bucket, key, versionId, retentionMode, retentionUntil, actorEmail }) {
  if (!["GOVERNANCE", "COMPLIANCE"].includes(retentionMode)) throw new Error('retentionMode must be "GOVERNANCE" or "COMPLIANCE".');
  const bucketDoc = await getS3Bucket({ orgId, bucket });
  if (!bucketDoc?.objectLockEnabled) throw new Error("Object Lock is not enabled on this bucket.");
  const { orgDocuments } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId), projectId: bucketDoc._id, filename: key, ...(versionId ? { versionId } : { isLatest: { $ne: false } }) };
  const doc = await orgDocuments.findOne(query);
  if (!doc) throw new Error("Object/version not found.");
  // A retention period may only ever be EXTENDED (or first-set), never
  // shortened -- otherwise "retention" would be advisory, not enforced.
  if (doc.retentionUntil && new Date(retentionUntil).getTime() < new Date(doc.retentionUntil).getTime()) {
    throw new Error("A retention period cannot be shortened, only extended.");
  }
  await orgDocuments.updateOne({ _id: doc._id }, { $set: { retentionMode, retentionUntil: new Date(retentionUntil).toISOString() } });
  await logOrgActivity({
    orgId, recordType: "s3_object", recordId: doc._id, actorEmail: actorEmail || "s3-compat", action: "OBJECT_LOCK_SET",
    previousState: { retentionMode: doc.retentionMode || null, retentionUntil: doc.retentionUntil || null },
    newState: { retentionMode, retentionUntil },
    metadata: { bucket, key, versionId: doc.versionId },
  });
  return { bucket, key, versionId: doc.versionId, retentionMode, retentionUntil };
}

export async function putObjectLegalHold({ orgId, bucket, key, versionId, legalHold, actorEmail }) {
  const bucketDoc = await getS3Bucket({ orgId, bucket });
  if (!bucketDoc) throw new Error("NoSuchBucket");
  const { orgDocuments } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId), projectId: bucketDoc._id, filename: key, ...(versionId ? { versionId } : { isLatest: { $ne: false } }) };
  const doc = await orgDocuments.findOne(query);
  if (!doc) throw new Error("Object/version not found.");
  await orgDocuments.updateOne({ _id: doc._id }, { $set: { legalHold: !!legalHold } });
  await logOrgActivity({
    orgId, recordType: "s3_object", recordId: doc._id, actorEmail: actorEmail || "s3-compat",
    action: legalHold ? "LEGAL_HOLD_PLACED" : "LEGAL_HOLD_RELEASED",
    previousState: { legalHold: !!doc.legalHold }, newState: { legalHold: !!legalHold },
    metadata: { bucket, key, versionId: doc.versionId },
  });
  return { bucket, key, versionId: doc.versionId, legalHold: !!legalHold };
}

const MAX_TAG_COUNT = 10; // matches real S3's own object-tag limit
const MAX_TAG_KEY_LEN = 128;
const MAX_TAG_VALUE_LEN = 256;

/** Validates a caller-supplied tag set into the exact shape stored --
 *  AWS S3 Feature Expansion SOW, Phase 1. Mirrors normalizeScope()'s own
 *  "never trust the shape as-is" discipline in credentials.js. */
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

async function findObjectForTagging({ orgId, bucket, key, versionId }) {
  const bucketDoc = await getS3Bucket({ orgId, bucket });
  if (!bucketDoc) throw new Error("NoSuchBucket");
  const { orgDocuments } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId), projectId: bucketDoc._id, filename: key, ...(versionId ? { versionId } : { isLatest: { $ne: false } }) };
  const doc = await orgDocuments.findOne(query);
  if (!doc) throw new Error("Object/version not found.");
  return { orgDocuments, doc };
}

export async function putObjectTagging({ orgId, bucket, key, versionId, tags, actorEmail }) {
  const clean = normalizeTags(tags);
  const { orgDocuments, doc } = await findObjectForTagging({ orgId, bucket, key, versionId });
  await orgDocuments.updateOne({ _id: doc._id }, { $set: { tags: clean } });
  await logOrgActivity({
    orgId, recordType: "s3_object", recordId: doc._id, actorEmail: actorEmail || "s3-compat", action: "OBJECT_TAGS_SET",
    previousState: { tags: doc.tags || {} }, newState: { tags: clean }, metadata: { bucket, key, versionId: doc.versionId },
  });
  return { bucket, key, versionId: doc.versionId, tags: clean };
}

export async function getObjectTagging({ orgId, bucket, key, versionId }) {
  const { doc } = await findObjectForTagging({ orgId, bucket, key, versionId });
  return { bucket, key, versionId: doc.versionId, tags: doc.tags || {} };
}

export async function deleteObjectTagging({ orgId, bucket, key, versionId, actorEmail }) {
  const { orgDocuments, doc } = await findObjectForTagging({ orgId, bucket, key, versionId });
  await orgDocuments.updateOne({ _id: doc._id }, { $set: { tags: {} } });
  await logOrgActivity({
    orgId, recordType: "s3_object", recordId: doc._id, actorEmail: actorEmail || "s3-compat", action: "OBJECT_TAGS_DELETED",
    previousState: { tags: doc.tags || {} }, newState: { tags: {} }, metadata: { bucket, key, versionId: doc.versionId },
  });
  return { bucket, key, versionId: doc.versionId };
}

/** Builds a Node-global File from raw bytes -- disperseAndSlice() only needs
 *  .arrayBuffer()/.type/.name, which Node 18+'s built-in File implements. */
function bufferToFile(buffer, { key, contentType }) {
  return new File([buffer], key, { type: contentType || "application/octet-stream" });
}

/** Real encrypt -> shard -> pin -> register pipeline. Returns the inserted
 *  org_documents row shape (etag == fileHash, matching S3's own convention
 *  of ETag being a content hash). */
export async function putS3Object({ orgId, bucket, key, bodyBuffer, contentType, actorEmail, tags }) {
  const bucketDoc = await ensureS3Bucket({ orgId, bucket, actorEmail });
  const passphrase = await getOrgS3Passphrase(orgId);
  const { orgDocuments } = await getOrgCollections();

  const versioningEnabled = bucketDoc.versioningStatus === "Enabled";
  const existing = await orgDocuments.findOne({ orgId: toObjectId(orgId), projectId: bucketDoc._id, filename: key, isLatest: { $ne: false }, deletedAt: null });
  // Object Lock/Legal Hold protect a physical version's bytes from being
  // destroyed -- irrelevant when versioning is enabled (a new PUT creates a
  // brand-new version and never touches the old one's bytes), but a real
  // overwrite-in-place when it's not (SOW §4: "protected overwrite").
  if (!versioningEnabled) assertNotProtected(existing, "overwrite this object");

  const salt = InayaKernel.generateSecureSalt();
  const encryptionKey = await InayaKernel.deriveVaultKey({ passkey: passphrase, salt });
  const file = bufferToFile(bodyBuffer, { key, contentType });
  const { shardAlpha, shardBeta } = await InayaKernel.disperseAndSlice({ file, encryptionKey });

  const now = new Date().toISOString();
  const documentId = new ObjectId();

  // REAL BUG found via Versioning testing (Storj-Inspired Storage Capability
  // Expansion SOW): the pin `name` must be unique PER VERSION, not just per
  // key. Filebase (this dev environment's active provider) uses `name` as
  // the literal object key on its own S3 backend (providerRef === name --
  // see pinningProviders/filebase.js) -- pinning two different versions'
  // bytes under the identical name silently overwrote the SAME provider-
  // side object, so an "old" version's cidAlpha/cidBeta actually served
  // the newest bytes back. Invisible before Versioning existed (every
  // overwrite soft-deleted the old row, so nobody ever re-fetched an old
  // cidAlpha/cidBeta) -- surfaced immediately once old versions became
  // retrievable. Salting with this write's own new documentId guarantees
  // a distinct provider-side object per version, exactly like the
  // fileHash salting fix elsewhere in this file.
  const provider = getProvider(primaryProviderName());
  const [alphaResult, betaResult] = await Promise.all([
    provider.pin(shardAlpha, { name: `s3-compat:${orgId}:${key}:${documentId}:alpha` }),
    provider.pin(shardBeta, { name: `s3-compat:${orgId}:${key}:${documentId}:beta` }),
  ]);

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

  // AWS S3 Feature Expansion SOW, Phase 5 -- a genuine, additional checksum
  // field: the REAL, unsalted SHA-256 of the plaintext bytes as uploaded,
  // independently verifiable by a client that hashes the same bytes
  // locally. Deliberately separate from fileHash above, which is salted
  // with this document's own _id for an unrelated legacy dedup reason (see
  // that field's own comment) and therefore can't serve this purpose --
  // this field is additive, not a replacement, and touches nothing about
  // how fileHash/dedup already works.
  const contentSha256 = createHash("sha256").update(bodyBuffer).digest("hex");

  // Versioning (SOW §3): when Enabled, the prior live object at this key is
  // demoted to a non-latest version and KEPT (real S3 semantics -- a new PUT
  // never destroys prior versions' bytes). When not enabled, real S3's own
  // behavior is used instead: the prior object is genuinely replaced
  // (soft-deleted here, matching this layer's existing, disclosed
  // soft-delete convention for DELETE).
  if (existing) {
    if (versioningEnabled) {
      await orgDocuments.updateOne({ _id: existing._id }, { $set: { isLatest: false } });
    } else {
      await orgDocuments.updateOne({ _id: existing._id }, { $set: { deletedAt: now } });
    }
  }

  const doc = {
    _id: documentId,
    orgId: toObjectId(orgId),
    departmentId: bucketDoc.departmentId,
    projectId: bucketDoc._id,
    filename: key, // the full S3 key, slashes included -- S3 keys are flat strings, not real paths
    fileHash,
    contentSha256,
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
    // Versioning/Object Lock/Legal Hold (SOW §3/§4/§5) -- versionId is a
    // real, permanent per-write identifier regardless of whether the
    // bucket has versioning Enabled (matching real S3, which always
    // assigns a version id internally; "null" is only the DISPLAYED id for
    // an unversioned bucket). isLatest is what every read path filters on.
    versionId: versioningEnabled ? documentId.toString() : "null",
    isLatest: true,
    retentionMode: null,
    retentionUntil: null,
    legalHold: false,
    tags: tags ? normalizeTags(tags) : {},
    createdAt: now,
    deletedAt: null,
  };
  await orgDocuments.insertOne(doc);

  // Automated Storage Health & Repair (SOW §7): register both shards with
  // the EXISTING real DePIN backup/health pipeline (backupEngine.js) --
  // the exact same call api/upload/route.js already makes for every other
  // upload in this app. Before this, S3/Azure-compat objects were pinned
  // but invisible to the check-pins/verify-integrity/recovery crons that
  // already protect every other Inaya file -- a real, confirmed gap this
  // pass closes by reusing the existing pipeline, not building a parallel
  // one. Best-effort: a transient failure here must not fail the upload
  // itself (matching upload/route.js's own "best-effort" framing) -- the
  // check-pins cron is the real safety net for anything that doesn't
  // complete inline.
  await Promise.all([
    replicateShard({ fileHash, shardId: "alpha", content: shardAlpha, primaryProvider: alphaResult.provider, primaryCid: alphaResult.cid, primaryProviderRef: alphaResult.providerRef }).catch((err) =>
      console.error("s3-compat putS3Object: backupEngine registration (alpha) failed (non-fatal):", err.message)
    ),
    replicateShard({ fileHash, shardId: "beta", content: shardBeta, primaryProvider: betaResult.provider, primaryCid: betaResult.cid, primaryProviderRef: betaResult.providerRef }).catch((err) =>
      console.error("s3-compat putS3Object: backupEngine registration (beta) failed (non-fatal):", err.message)
    ),
  ]);

  await logOrgActivity({
    orgId,
    recordType: "s3_object",
    recordId: documentId,
    actorEmail: actorEmail || "s3-compat",
    action: "PUT",
    previousState: null,
    newState: { bucket, key, sizeBytes: doc.sizeBytes, versionId: doc.versionId },
    metadata: { bucket, key, versionId: doc.versionId },
  });

  return doc;
}

// `isLatest: { $ne: false }` (not `isLatest: true`) throughout this file --
// every S3-compat object written before Versioning existed has no
// `isLatest` field at all, and must keep resolving as "the live object",
// not silently disappear from GET/HEAD/LIST because a strict `=== true`
// match excludes `undefined`. New writes always set the field explicitly
// (see putS3Object), so this fallback only ever matters for pre-existing rows.
const IS_LATEST = { $ne: false };

export async function headS3Object({ orgId, bucket, key, versionId }) {
  const bucketDoc = await getS3Bucket({ orgId, bucket });
  if (!bucketDoc) return null;
  const { orgDocuments } = await getOrgCollections();
  if (versionId) {
    // An explicit version is retrievable even if it's not the latest AND
    // even if the key's current latest version has since been deleted --
    // matches real S3 (GetObject?versionId=X ignores the delete marker on
    // the HEAD of the version chain). Still scoped to this exact
    // orgId+bucket+key, never just a bare versionId, so one org can never
    // fetch another org's version by guessing/reusing an id.
    return orgDocuments.findOne({ orgId: toObjectId(orgId), projectId: bucketDoc._id, filename: key, versionId });
  }
  return orgDocuments.findOne({ orgId: toObjectId(orgId), projectId: bucketDoc._id, filename: key, isLatest: IS_LATEST, deletedAt: null });
}

/** Fetches both shards and fully reconstructs+decrypts server-side (see module
 *  header on why range GET necessarily means "decrypt the whole object, then
 *  slice" -- AES-GCM's auth tag covers the whole ciphertext as one unit, so
 *  there is no partial-decrypt path). Returns the full plaintext Buffer;
 *  callers slice the requested range. */
export async function getS3ObjectBody({ orgId, bucket, key, versionId }) {
  const doc = await headS3Object({ orgId, bucket, key, versionId });
  if (!doc) return null;
  const passphrase = await getOrgS3Passphrase(orgId);
  const provider = getProvider(doc.pinProvider || primaryProviderName());
  const [shardAlpha, shardBeta] = await Promise.all([provider.fetchReplica(doc.cidAlpha), provider.fetchReplica(doc.cidBeta)]);
  const dataUrl = await InayaKernel.reconstructAndDecrypt({ shardAlpha, shardBeta, passkey: passphrase });
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return { doc, buffer: Buffer.from(base64, "base64") };
}

/** Real S3 semantics: DELETE without a versionId on a VERSIONED bucket
 *  inserts a delete marker (the key disappears from ordinary GET/LIST, but
 *  every prior version stays retrievable by versionId) -- it does not erase
 *  bytes. DELETE with an explicit versionId (or DELETE on an unversioned
 *  bucket/key) permanently removes that one physical version, and IS
 *  blocked by Object Lock/Legal Hold (SOW §4/§5's "protected deletion").
 *  A delete marker itself is never lock-checked -- it destroys nothing. */
export async function deleteS3Object({ orgId, bucket, key, versionId, actorEmail }) {
  const bucketDoc = await getS3Bucket({ orgId, bucket });
  if (!bucketDoc) return { deleted: true };
  const { orgDocuments } = await getOrgCollections();
  const now = new Date().toISOString();

  if (!versionId && bucketDoc.versioningStatus === "Enabled") {
    const current = await orgDocuments.findOne({ orgId: toObjectId(orgId), projectId: bucketDoc._id, filename: key, isLatest: IS_LATEST, deletedAt: null });
    if (!current) return { deleted: true };
    await orgDocuments.updateOne({ _id: current._id }, { $set: { deletedAt: now } }); // delete marker: hides from GET/LIST, bytes untouched
    await logOrgActivity({
      orgId, recordType: "s3_object", recordId: current._id, actorEmail: actorEmail || "s3-compat", action: "DELETE_MARKER_CREATED",
      previousState: { bucket, key }, newState: null, metadata: { bucket, key, versionId: current.versionId },
    });
    return { deleted: true, deleteMarker: true };
  }

  const doc = await headS3Object({ orgId, bucket, key, versionId });
  if (!doc) return { deleted: true }; // S3 DELETE is idempotent -- deleting a nonexistent key/version is not an error
  assertNotProtected(doc, "delete this object");
  await orgDocuments.updateOne({ _id: doc._id }, { $set: { deletedAt: now } });
  await logOrgActivity({
    orgId,
    recordType: "s3_object",
    recordId: doc._id,
    actorEmail: actorEmail || "s3-compat",
    action: "DELETE",
    previousState: { bucket, key },
    newState: null,
    metadata: { bucket, key, versionId: doc.versionId },
  });
  return { deleted: true };
}

/** Real ListObjectsV2 semantics: prefix filter + delimiter-based "common
 *  prefixes" grouping, over the flat filename/key namespace -- S3 doesn't
 *  have real directories, "folders" are purely a shared-prefix convention,
 *  so this needs no hierarchy beyond what org_documents already has.
 *
 *  Inaya Drive Empty Folder SOW: also merges in real, durable folder
 *  records (s3_folders, below) that fall under this exact prefix+delimiter
 *  -- a folder with zero objects would otherwise never appear in any
 *  listing, since everything above is derived purely from object keys. A
 *  client (the S3 protocol, or Inaya Drive) sees a real empty folder as an
 *  ordinary CommonPrefixes entry, indistinguishable from an object-derived
 *  one -- correct, standard S3 listing semantics either way. */
export async function listS3Objects({ orgId, bucket, prefix = "", delimiter = "", maxKeys = 1000 }) {
  const bucketDoc = await getS3Bucket({ orgId, bucket });
  if (!bucketDoc) return null;
  const { orgDocuments } = await getOrgCollections();
  const docs = await orgDocuments
    .find({ orgId: toObjectId(orgId), projectId: bucketDoc._id, deletedAt: null, isLatest: IS_LATEST, filename: { $regex: `^${escapeRegExp(prefix)}` } })
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

  if (delimiter) {
    const parentFolderId = await resolveFolderIdForPrefix({ orgId, bucketDoc, prefix });
    if (parentFolderId !== undefined) {
      const { db } = await getOrgCollections();
      const childFolders = await db.collection("s3_folders").find({ orgId: toObjectId(orgId), projectId: bucketDoc._id, parentFolderId, deletedAt: null }).toArray();
      for (const f of childFolders) commonPrefixes.add(prefix + f.name + delimiter);
    }
  }

  return { contents: contents.slice(0, maxKeys), commonPrefixes: [...commonPrefixes].sort(), isTruncated: contents.length > maxKeys };
}

// ---------------------------------------------------------------------
// Enterprise Adoption & Market Reach Expansion SOW, Workstream A --
// migration job-level audit events. Deliberately NOT a new tracking
// collection: a migration run's real state of record is the operator's
// own local manifest file (see inaya-migration-agent/src/manifest.js);
// this is only a start/complete/fail breadcrumb in the org's EXISTING
// audit chain, satisfying §8.3's "reuse the existing audit chain rather
// than creating a parallel audit system" literally.
// ---------------------------------------------------------------------

export async function recordMigrationEvent({ orgId, bucket, jobId, event, summary, actorEmail }) {
  const bucketDoc = await ensureS3Bucket({ orgId, bucket, actorEmail });
  await logOrgActivity({
    orgId,
    recordType: "s3_migration",
    recordId: bucketDoc._id,
    actorEmail: actorEmail || "migration-agent",
    action: `MIGRATION_${event}`,
    previousState: null,
    newState: summary || null,
    metadata: { jobId, bucket, summary: summary || null },
  });
  return { recorded: true };
}

// ---------------------------------------------------------------------
// Inaya Drive -- User-Created Empty Folder Support SOW.
//
// Phase 0 finding: the wallet side already has a real, proven, durable
// folder system (metadata_folders -- folderId/owner/name/parentFolderId/
// createdAt/updatedAt/deletedAt, real create/rename/move/delete routes
// under api/metadata/*-folder). The org side has no equivalent -- the
// department/project hierarchy is the wrong granularity (it scopes
// buckets themselves, not paths *within* one bucket). s3_folders below
// mirrors metadata_folders' exact proven shape (same field names, same
// soft-delete-with-orphan-to-parent semantics on delete) rather than
// inventing a new one, scoped additionally by projectId since -- unlike
// the wallet's single global tree -- an org can have many buckets, each
// needing its own independent folder tree.
//
// Deliberately NOT linked to org_documents by any foreign key: an
// object's location is still purely its flat `filename` key (unchanged);
// a folder row exists ONLY to make an otherwise-invisible empty directory
// listable and durable. Deleting a folder row therefore never touches any
// object -- there was never a reference to orphan in the first place.
// ---------------------------------------------------------------------

function splitFolderPath(folderPath) {
  return String(folderPath || "").split("/").filter(Boolean);
}

const FOLDER_NAME_RE = /^[^/\\\0]{1,255}$/;

// Attaches a stable `.code` so the API route (and, through its HTTP
// status, the Rust Drive client) can map each failure deterministically
// instead of surfacing every folder error as an opaque 500 -- the SOW's
// own explicit error-handling requirement.
function folderError(code, message) {
  return Object.assign(new Error(message), { code });
}

function validateFolderSegment(name) {
  if (name === "." || name === "..") throw folderError("InvalidFolderName", `Invalid folder name "${name}".`);
  if (!FOLDER_NAME_RE.test(name)) throw folderError("InvalidFolderName", `Invalid folder name "${name}": must be 1-255 characters and contain no "/", "\\", or null byte.`);
}

/** Walks an already-existing folder chain (creates nothing). Returns the
 *  leaf row, or null if any segment along the way is missing. */
async function walkS3FolderChain({ orgId, bucketDoc, segments }) {
  const { db } = await getOrgCollections();
  const col = db.collection("s3_folders");
  let parentFolderId = null;
  let row = null;
  for (const name of segments) {
    row = await col.findOne({ orgId: toObjectId(orgId), projectId: bucketDoc._id, parentFolderId, name, deletedAt: null });
    if (!row) return null;
    parentFolderId = row.folderId;
  }
  return row;
}

/** Resolves what "parentFolderId" a listing prefix corresponds to, so
 *  listS3Objects can find the right folder rows to merge in. Returns
 *  `null` for the bucket root, a real folderId for a real sub-path, or
 *  `undefined` if the prefix doesn't correspond to any known folder path
 *  (nothing to merge). `prefix` is expected delimiter-terminated (e.g.
 *  "documents/contracts/") or empty for the root. */
async function resolveFolderIdForPrefix({ orgId, bucketDoc, prefix }) {
  const segments = splitFolderPath(prefix);
  if (segments.length === 0) return null;
  const row = await walkS3FolderChain({ orgId, bucketDoc, segments });
  return row ? row.folderId : undefined;
}

/** Creates a durable, empty-safe folder record at `folderPath` (e.g.
 *  "documents/contracts/2026") within `bucket`. Ancestor segments are
 *  auto-vivified (mkdir -p semantics) idempotently; the LEAF segment must
 *  not already exist as a folder at that exact parent -- a real duplicate
 *  rejection (SOW §6/§15), not silently merged. Does not touch, require,
 *  or conflict with any existing object at an overlapping key -- an
 *  object-derived pseudo-folder and a real folder row for the same path
 *  coexist and are presented identically to a listing client. */
export async function createS3Folder({ orgId, bucket, folderPath, actorEmail }) {
  const bucketDoc = await ensureS3Bucket({ orgId, bucket, actorEmail });
  const segments = splitFolderPath(folderPath);
  if (segments.length === 0) throw folderError("InvalidFolderName", "Folder path must not be empty.");
  segments.forEach(validateFolderSegment);

  const { db } = await getOrgCollections();
  const col = db.collection("s3_folders");
  const now = new Date().toISOString();
  let parentFolderId = null;
  let leaf = null;

  for (let i = 0; i < segments.length; i++) {
    const isLeaf = i === segments.length - 1;
    const existing = await col.findOne({ orgId: toObjectId(orgId), projectId: bucketDoc._id, parentFolderId, name: segments[i], deletedAt: null });
    if (existing) {
      if (isLeaf) throw folderError("FolderAlreadyExists", `A folder named "${segments[i]}" already exists at this location.`);
      parentFolderId = existing.folderId;
      leaf = existing;
      continue;
    }
    const folderId = new ObjectId().toString();
    const doc = { folderId, orgId: toObjectId(orgId), projectId: bucketDoc._id, parentFolderId, name: segments[i], createdAt: now, updatedAt: now, deletedAt: null, createdByEmail: actorEmail || null };
    await col.insertOne(doc);
    parentFolderId = folderId;
    leaf = doc;
  }

  await logOrgActivity({
    orgId, recordType: "s3_folder", recordId: bucketDoc._id, actorEmail: actorEmail || "s3-compat", action: "FOLDER_CREATED",
    previousState: null, newState: { bucket, folderPath }, metadata: { bucket, folderPath },
  });
  return { bucket, folderPath, folderId: leaf.folderId };
}

/** Returns { folderId, exists } for a folder path -- used by the Drive
 *  helper to resolve whether an empty (no-object) directory is real,
 *  distinct from head/get object lookups which only ever see files. */
export async function getS3FolderInfo({ orgId, bucket, folderPath }) {
  const bucketDoc = await getS3Bucket({ orgId, bucket });
  if (!bucketDoc) return null;
  const segments = splitFolderPath(folderPath);
  if (segments.length === 0) return null;
  const row = await walkS3FolderChain({ orgId, bucketDoc, segments });
  return row ? { folderId: row.folderId, name: row.name, createdAt: row.createdAt } : null;
}

/** Soft-deletes the folder record at `folderPath`. Matches metadata_folders'
 *  own proven delete-folder semantics exactly: child FOLDER rows are
 *  orphaned to the bucket root (parentFolderId: null), never cascade-
 *  deleted. Objects are untouched either way -- they were never linked to
 *  a folder row (see module note above), so there is nothing to orphan or
 *  cascade for them. */
export async function deleteS3Folder({ orgId, bucket, folderPath, actorEmail }) {
  const bucketDoc = await getS3Bucket({ orgId, bucket });
  if (!bucketDoc) return { deleted: true };
  const segments = splitFolderPath(folderPath);
  if (segments.length === 0) throw folderError("InvalidFolderName", "Folder path must not be empty.");

  const folder = await walkS3FolderChain({ orgId, bucketDoc, segments });
  if (!folder) return { deleted: true }; // idempotent, matching every other delete in this layer

  const { db } = await getOrgCollections();
  const col = db.collection("s3_folders");
  const now = new Date().toISOString();
  await col.updateOne({ folderId: folder.folderId }, { $set: { deletedAt: now, updatedAt: now } });
  await col.updateMany({ orgId: toObjectId(orgId), projectId: bucketDoc._id, parentFolderId: folder.folderId }, { $set: { parentFolderId: null, updatedAt: now } });

  await logOrgActivity({
    orgId, recordType: "s3_folder", recordId: bucketDoc._id, actorEmail: actorEmail || "s3-compat", action: "FOLDER_DELETED",
    previousState: { bucket, folderPath }, newState: null, metadata: { bucket, folderPath },
  });
  return { deleted: true };
}

/** Renames and/or moves a folder in one operation -- exactly what WinFSP's
 *  own rename() callback represents (old path -> new path, which may
 *  differ in name, parent, or both). The new parent path must already
 *  exist (matching the proven api/metadata/move-folder route's own
 *  requirement that a target parent be real, not auto-vivified). */
export async function renameS3Folder({ orgId, bucket, oldFolderPath, newFolderPath, actorEmail }) {
  const bucketDoc = await getS3Bucket({ orgId, bucket });
  if (!bucketDoc) throw folderError("NoSuchBucket", "The specified bucket does not exist.");

  const oldSegments = splitFolderPath(oldFolderPath);
  const newSegments = splitFolderPath(newFolderPath);
  if (oldSegments.length === 0 || newSegments.length === 0) throw folderError("InvalidFolderName", "Folder path must not be empty.");
  const newName = newSegments[newSegments.length - 1];
  validateFolderSegment(newName);
  const newParentSegments = newSegments.slice(0, -1);

  const folder = await walkS3FolderChain({ orgId, bucketDoc, segments: oldSegments });
  if (!folder) throw folderError("NoSuchFolder", "Folder not found.");

  let newParentFolderId = null;
  if (newParentSegments.length > 0) {
    const newParent = await walkS3FolderChain({ orgId, bucketDoc, segments: newParentSegments });
    if (!newParent) throw folderError("NoSuchParentFolder", "The destination parent folder does not exist.");
    newParentFolderId = newParent.folderId;
  }
  if (newParentFolderId === folder.folderId) throw folderError("InvalidFolderName", "A folder cannot be moved into itself.");

  const { db } = await getOrgCollections();
  const col = db.collection("s3_folders");
  const conflict = await col.findOne({ orgId: toObjectId(orgId), projectId: bucketDoc._id, parentFolderId: newParentFolderId, name: newName, deletedAt: null, folderId: { $ne: folder.folderId } });
  if (conflict) throw folderError("FolderAlreadyExists", `A folder named "${newName}" already exists at the destination.`);

  const now = new Date().toISOString();
  await col.updateOne({ folderId: folder.folderId }, { $set: { name: newName, parentFolderId: newParentFolderId, updatedAt: now } });

  await logOrgActivity({
    orgId, recordType: "s3_folder", recordId: bucketDoc._id, actorEmail: actorEmail || "s3-compat", action: "FOLDER_RENAMED",
    previousState: { bucket, folderPath: oldFolderPath }, newState: { bucket, folderPath: newFolderPath }, metadata: { bucket, oldFolderPath, newFolderPath },
  });
  return { bucket, folderPath: newFolderPath, folderId: folder.folderId };
}

/** SOW §3: "retrieval of a specific version" (listing side) + Business
 *  Workspace's "inspect versions" requirement. Returns every version ever
 *  written for this key (including the current one and any soft-deleted-
 *  via-delete-marker state), newest first -- deliberately including
 *  deletedAt-marked rows here (unlike listS3Objects), since a delete
 *  marker is itself a real, listable event in S3's version history. */
/** Real S3 bucket-wide ListObjectVersions (Enterprise Adoption SOW,
 *  Workstream B): every object's every version in the bucket, not just
 *  one key -- required for real S3 SDK clients (Terraform's
 *  force_destroy bucket-emptying flow calls exactly this). Single page
 *  only, matching listObjectVersionsXml's own disclosed limitation. */
export async function listAllObjectVersions({ orgId, bucket, prefix = "" }) {
  const bucketDoc = await getS3Bucket({ orgId, bucket });
  if (!bucketDoc) return null;
  const { orgDocuments } = await getOrgCollections();
  const docs = await orgDocuments
    .find({ orgId: toObjectId(orgId), projectId: bucketDoc._id, filename: { $regex: `^${escapeRegExp(prefix)}` } })
    .sort({ filename: 1, createdAt: -1 })
    .toArray();
  return docs.map((d) => ({
    key: d.filename,
    versionId: d.versionId || "null",
    isLatest: d.isLatest !== false,
    deleteMarker: !!d.deletedAt,
    sizeBytes: d.sizeBytes,
    etag: d.cidAlpha || d.fileHash,
    lastModified: d.createdAt,
  }));
}

export async function listObjectVersions({ orgId, bucket, key }) {
  const bucketDoc = await getS3Bucket({ orgId, bucket });
  if (!bucketDoc) return null;
  const { orgDocuments } = await getOrgCollections();
  const docs = await orgDocuments
    .find({ orgId: toObjectId(orgId), projectId: bucketDoc._id, filename: key })
    .sort({ createdAt: -1 })
    .toArray();
  return docs.map((d) => ({
    versionId: d.versionId || "null",
    isLatest: d.isLatest !== false,
    deleteMarker: !!d.deletedAt,
    sizeBytes: d.sizeBytes,
    contentType: d.contentType,
    etag: d.cidAlpha || d.fileHash,
    lastModified: d.createdAt,
    retentionMode: d.retentionMode || null,
    retentionUntil: d.retentionUntil || null,
    legalHold: !!d.legalHold,
  }));
}

/** SOW §3: "restoration of a previous version." Real S3 doesn't resurrect
 *  an old version id in place -- restoring means copying that version's
 *  content forward as a brand-new current version, which is exactly what
 *  calling putS3Object() with the old version's bytes does (also correctly
 *  re-runs encryption/sharding/pinning/backupEngine registration for the
 *  restored bytes, rather than trying to resurrect possibly-stale shard
 *  pins). Org isolation is inherited for free -- getS3ObjectBody/putS3Object
 *  both scope strictly to the given orgId, so a version id can never be
 *  used to pull or restore another org's object even if guessed. */
export async function restoreObjectVersion({ orgId, bucket, key, versionId, actorEmail }) {
  const source = await getS3ObjectBody({ orgId, bucket, key, versionId });
  if (!source) throw new Error("Version not found.");
  return putS3Object({ orgId, bucket, key, bodyBuffer: source.buffer, contentType: source.doc.contentType, actorEmail });
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------
// Lifecycle & Retention Policies (SOW §6). Org-scoped, per-bucket rules,
// server-enforced by the real enforcement pass below (runLifecycleEnforcement)
// -- never a client-side/UI-only "looks expired" label. Enforcement is
// EXPLICITLY CALLABLE (a real "Run now" action + the cron route below) but
// this pass does not itself install a scheduler -- disclosed honestly
// rather than silently claimed automatic, since this codebase's existing
// cron routes (api/cron/nodes-snapshot, api/backup/cron/*) are all
// externally triggered by Vercel Cron config, not a self-scheduling
// process, and wiring a new entry into that external config is outside
// what this codebase alone can do or verify.
// ---------------------------------------------------------------------

/** One document per bucket -- replaces the whole rule set on each call
 *  (matching real S3's PutBucketLifecycleConfiguration semantic: it's a
 *  full replace, not a merge/patch). */
export async function putLifecyclePolicy({ orgId, bucket, rules, actorEmail }) {
  const bucketDoc = await ensureS3Bucket({ orgId, bucket });
  if (!Array.isArray(rules)) throw new Error("rules must be an array.");
  for (const rule of rules) {
    if (rule.expirationDays != null && (!Number.isFinite(rule.expirationDays) || rule.expirationDays < 1)) {
      throw new Error(`Rule "${rule.id}": expirationDays must be a positive number.`);
    }
    if (rule.noncurrentVersionExpirationDays != null && (!Number.isFinite(rule.noncurrentVersionExpirationDays) || rule.noncurrentVersionExpirationDays < 1)) {
      throw new Error(`Rule "${rule.id}": noncurrentVersionExpirationDays must be a positive number.`);
    }
  }
  const { db } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId),
    bucket,
    rules: rules.map((r) => ({ id: r.id || new ObjectId().toString(), prefix: r.prefix || "", enabled: r.enabled !== false, expirationDays: r.expirationDays ?? null, noncurrentVersionExpirationDays: r.noncurrentVersionExpirationDays ?? null })),
    updatedAt: now,
    updatedByEmail: actorEmail || "s3-compat",
  };
  await db.collection("s3_lifecycle_policies").updateOne({ orgId: toObjectId(orgId), bucket }, { $set: doc, $setOnInsert: { createdAt: now } }, { upsert: true });
  // recordId must be a real ObjectId (logOrgActivity/toObjectId reject a
  // bare bucket-name string) -- the bucket's own project _id is the
  // closest real "record" this event is about, since a lifecycle policy
  // document has no _id of its own (it's keyed by orgId+bucket).
  await logOrgActivity({ orgId, recordType: "s3_lifecycle_policy", recordId: bucketDoc._id, actorEmail: actorEmail || "s3-compat", action: "LIFECYCLE_POLICY_SET", previousState: null, newState: { bucket, rules: doc.rules }, metadata: { bucket } });
  return doc;
}

export async function getLifecyclePolicy({ orgId, bucket }) {
  const { db } = await getOrgCollections();
  return db.collection("s3_lifecycle_policies").findOne({ orgId: toObjectId(orgId), bucket });
}

export async function deleteLifecyclePolicy({ orgId, bucket, actorEmail }) {
  const bucketDoc = await getS3Bucket({ orgId, bucket });
  const { db } = await getOrgCollections();
  await db.collection("s3_lifecycle_policies").deleteOne({ orgId: toObjectId(orgId), bucket });
  if (bucketDoc) {
    await logOrgActivity({ orgId, recordType: "s3_lifecycle_policy", recordId: bucketDoc._id, actorEmail: actorEmail || "s3-compat", action: "LIFECYCLE_POLICY_DELETED", previousState: null, newState: null, metadata: { bucket } });
  }
  return { deleted: true };
}

/** For display only (SOW §6: "Clearly show when an object is scheduled for
 *  expiration") -- computed from the object's own age + its bucket's rules,
 *  never persisted, so it's always accurate as of read time without a
 *  separate write-path to keep in sync. */
function computeScheduledExpiration(doc, policy) {
  if (!policy) return null;
  const rule = policy.rules.find((r) => r.enabled && doc.filename.startsWith(r.prefix || ""));
  if (!rule) return null;
  const days = doc.isLatest !== false ? rule.expirationDays : rule.noncurrentVersionExpirationDays;
  if (!days) return null;
  return new Date(new Date(doc.createdAt).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

export async function getObjectExpirationInfo({ orgId, bucket, doc }) {
  const policy = await getLifecyclePolicy({ orgId, bucket });
  return computeScheduledExpiration(doc, policy);
}

/** The real enforcement pass (SOW §6/§17 step 7's "controlled deletion").
 *  Runs across every org+bucket with a lifecycle policy, soft-deletes
 *  (real, existing deletedAt convention -- not a new deletion mechanism)
 *  any object/version whose age exceeds its matching rule's expiration --
 *  but NEVER one under Object Lock retention or Legal Hold (SOW §6's own
 *  "legal hold interaction" and §4/§5's protections apply here exactly as
 *  they do to a manual DELETE, via the same assertNotProtected chokepoint
 *  -- a lifecycle rule is not a backdoor around a lock). Callable directly
 *  (a real "Run now" Business Workspace action) or from the cron route
 *  below; NOT self-scheduling (see module comment above). */
export async function runLifecycleEnforcement({ limit = 500 } = {}) {
  const { db, orgDocuments } = await getOrgCollections();
  const policies = await db.collection("s3_lifecycle_policies").find({}).toArray();
  let scanned = 0, expired = 0, skippedLocked = 0;
  const errors = [];

  for (const policy of policies) {
    const bucketDoc = await getS3Bucket({ orgId: policy.orgId.toString(), bucket: policy.bucket });
    if (!bucketDoc) continue;

    const docs = await orgDocuments.find({ orgId: policy.orgId, projectId: bucketDoc._id, deletedAt: null }).limit(limit).toArray();
    for (const doc of docs) {
      scanned += 1;
      const scheduledAt = computeScheduledExpiration(doc, policy);
      if (!scheduledAt || new Date(scheduledAt).getTime() > Date.now()) continue;
      try {
        assertNotProtected(doc, "expire this object via lifecycle policy");
      } catch (err) {
        skippedLocked += 1;
        continue;
      }
      const now = new Date().toISOString();
      await orgDocuments.updateOne({ _id: doc._id }, { $set: { deletedAt: now } });
      await logOrgActivity({
        orgId: policy.orgId.toString(), recordType: "s3_object", recordId: doc._id, actorEmail: "s3-lifecycle-policy", action: "LIFECYCLE_EXPIRED",
        previousState: { bucket: policy.bucket, key: doc.filename }, newState: null, metadata: { bucket: policy.bucket, key: doc.filename, versionId: doc.versionId },
      });
      expired += 1;
    }
  }
  return { scanned, expired, skippedLocked, errors };
}

// ---------------------------------------------------------------------
// Automated Storage Health & Repair (SOW §7) -- surfacing ONLY. Every
// object written through putS3Object() is now registered with the real,
// existing DePIN backup pipeline (backupEngine.replicateShard, called
// above) -- the exact same check-pins/verify-integrity/recovery crons
// that already protect every other Inaya file now cover these objects
// too, with no parallel health system built here.
// ---------------------------------------------------------------------

export async function getS3ObjectHealth({ orgId, bucket, key, versionId }) {
  const doc = await headS3Object({ orgId, bucket, key, versionId });
  if (!doc) return null;
  return getBackupStatus(doc.fileHash);
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
