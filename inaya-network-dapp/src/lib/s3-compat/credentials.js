// src/lib/s3-compat/credentials.js
//
// S3-compatible credential issuance and resolution -- for BOTH ownership
// models this app already has: an org's Business Workspace documents
// (org_documents) and a wallet's personal vault (metadata_files). Kept as
// one credential system with an `owner` discriminator ({type:"org",orgId}
// or {type:"wallet",walletAddress}) rather than two parallel credential
// systems, since the credential/signing concern is identical either way --
// only the object store underneath differs (see store.js vs
// walletStore.js, which stay genuinely separate implementations, mirroring
// this codebase's own existing org_documents/metadata_files split and its
// stated reason: "mixing the two ownership semantics into one collection
// risked silently breaking that system's on-chain-ownership invariant"
// -- src/lib/orgs.js's own header comment).
//
// Sibling to src/lib/api-keys.js, not a fork of it -- api-keys.js's bearer
// tokens are compared by hash (never read back), but AWS SigV4 verification
// needs the real secretAccessKey bytes to recompute an HMAC server-side, so
// the secret is envelope-wrapped (crypto.js) rather than hashed. The raw
// secretAccessKey is still only ever shown once, at creation.

import { randomBytes } from "node:crypto";
import { getOrgCollections, toObjectId, hashToken } from "../orgs.js";
import { wrapPassphrase, unwrapPassphrase, generatePassphrase } from "./crypto.js";

export async function ensureS3CompatIndexes(db) {
  await db.collection("s3_credentials").createIndex({ accessKeyId: 1 }, { unique: true });
  await db.collection("s3_credentials").createIndex({ ownerType: 1, ownerId: 1 });
  await db.collection("s3_owner_keys").createIndex({ ownerType: 1, ownerId: 1 }, { unique: true });
}

function ownerId(owner) {
  return owner.type === "org" ? owner.orgId.toString() : owner.walletAddress.toLowerCase();
}

function generateAccessKeyId() {
  // Deliberately NOT AWS's own "AKIA..." format -- these are Inaya-issued
  // credentials, not AWS ones, and a lookalike prefix would misleadingly
  // imply they came from AWS. SigV4 itself doesn't require any particular
  // prefix.
  return "INAYAAK" + randomBytes(10).toString("hex").toUpperCase();
}

function generateSecretAccessKey() {
  return randomBytes(30).toString("base64").replace(/[/+=]/g, "x"); // avoid header/URL-hostile chars
}

/** Lazily creates (once per owner) the passphrase every object that owner
 *  writes through the compatibility layer gets encrypted under. Reused
 *  across every credential the owner issues. */
export async function ensureOwnerS3Passphrase(owner) {
  const { db } = await getOrgCollections();
  const col = db.collection("s3_owner_keys");
  const query = { ownerType: owner.type, ownerId: ownerId(owner) };
  const existing = await col.findOne(query);
  if (existing) return;
  const passphrase = generatePassphrase();
  await col.insertOne({ ...query, wrappedPassphrase: wrapPassphrase(passphrase), createdAt: new Date().toISOString() });
}

export async function getOwnerS3Passphrase(owner) {
  const { db } = await getOrgCollections();
  const doc = await db.collection("s3_owner_keys").findOne({ ownerType: owner.type, ownerId: ownerId(owner) });
  if (!doc) throw new Error("This account has no S3-compatibility passphrase yet -- issue a credential first.");
  return unwrapPassphrase(doc.wrappedPassphrase);
}

const VALID_OPERATIONS = ["READ", "WRITE", "DELETE", "LIST"];

/** Normalizes+validates a caller-supplied scope into the exact shape stored and
 *  later enforced -- never trusts the shape as-is. `null`/omitted fields mean
 *  "unrestricted on this axis" (matching an ordinary owner-level credential),
 *  not "denied" -- a credential with no scope object at all is the original,
 *  fully-trusted owner-level credential Workstream A already shipped; this is
 *  purely additive. Throws on a genuinely invalid scope rather than silently
 *  narrowing it to something the caller didn't ask for. */
function normalizeScope(scope) {
  if (!scope) return null;
  const out = {};
  if (scope.bucket != null) {
    if (typeof scope.bucket !== "string" || !scope.bucket) throw new Error("scope.bucket must be a non-empty string.");
    out.bucket = scope.bucket;
  }
  if (scope.prefix != null) {
    if (typeof scope.prefix !== "string") throw new Error("scope.prefix must be a string.");
    if (!out.bucket) throw new Error("scope.prefix requires scope.bucket to also be set -- a prefix without a bucket is ambiguous.");
    out.prefix = scope.prefix;
  }
  if (scope.operations != null) {
    if (!Array.isArray(scope.operations) || scope.operations.length === 0) throw new Error("scope.operations must be a non-empty array.");
    const bad = scope.operations.filter((op) => !VALID_OPERATIONS.includes(op));
    if (bad.length > 0) throw new Error(`scope.operations contains invalid value(s): ${bad.join(", ")}. Must be one of ${VALID_OPERATIONS.join("/")}.`);
    out.operations = [...new Set(scope.operations)];
  }
  if (scope.expiresAt != null) {
    const t = new Date(scope.expiresAt).getTime();
    if (!Number.isFinite(t)) throw new Error("scope.expiresAt must be a valid date/time.");
    if (t <= Date.now()) throw new Error("scope.expiresAt must be in the future.");
    out.expiresAt = new Date(t).toISOString();
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Returns { accessKeyId, secretAccessKey } -- secretAccessKey is the only time
 *  the raw value is ever available; only its wrapped form is persisted.
 *  `scope`, if supplied, is a server-enforced grant narrower than the owner's
 *  full access (see normalizeScope/checkScope) -- e.g. { bucket: "finance",
 *  prefix: "invoices/2026/", operations: ["READ"], expiresAt: "..." }. */
export async function issueS3Credential({ owner, label, actorEmail, scope }) {
  await ensureOwnerS3Passphrase(owner);
  const { db } = await getOrgCollections();
  const accessKeyId = generateAccessKeyId();
  const secretAccessKey = generateSecretAccessKey();
  const now = new Date().toISOString();
  const normalizedScope = normalizeScope(scope);
  await db.collection("s3_credentials").insertOne({
    ownerType: owner.type,
    ownerId: ownerId(owner),
    accessKeyId,
    wrappedSecretAccessKey: wrapPassphrase(secretAccessKey),
    secretFingerprint: hashToken(secretAccessKey),
    label: label || null,
    scope: normalizedScope,
    createdByEmail: actorEmail || null,
    createdAt: now,
    revokedAt: null,
  });
  return { accessKeyId, secretAccessKey, scope: normalizedScope, createdAt: now };
}

/** Server-side enforcement of a credential's stored scope -- called on every
 *  S3/Azure request AFTER signature verification, using ONLY the scope
 *  recorded at issuance time. Never reads bucket/prefix/operation off
 *  anything the client supplies about its own permissions (the client
 *  supplies the bucket/key/method it's requesting, which this function
 *  checks against the stored grant -- it never supplies the grant itself).
 *  Returns { allowed: true } or { allowed: false, reason }. A credential
 *  with no `scope` at all (undefined/null) is the original owner-level
 *  credential and is always allowed -- scoping is opt-in, not a silent
 *  new restriction on every existing credential issued before this SOW. */
export function checkScope(credential, { bucket, key, operation }) {
  const scope = credential.scope;
  if (!scope) return { allowed: true };

  if (scope.expiresAt && new Date(scope.expiresAt).getTime() <= Date.now()) {
    return { allowed: false, reason: "CredentialExpired" };
  }
  if (scope.bucket && bucket && scope.bucket !== bucket) {
    return { allowed: false, reason: "BucketScopeDenied" };
  }
  if (scope.prefix && key != null && !key.startsWith(scope.prefix)) {
    return { allowed: false, reason: "PrefixScopeDenied" };
  }
  if (scope.operations && operation && !scope.operations.includes(operation)) {
    return { allowed: false, reason: "OperationScopeDenied" };
  }
  return { allowed: true };
}

export async function listS3Credentials(owner) {
  const { db } = await getOrgCollections();
  const docs = await db
    .collection("s3_credentials")
    .find({ ownerType: owner.type, ownerId: ownerId(owner) })
    .project({ wrappedSecretAccessKey: 0, secretFingerprint: 0 })
    .sort({ createdAt: -1 })
    .toArray();
  return docs.map((d) => ({ ...d, active: !d.revokedAt }));
}

export async function revokeS3Credential({ owner, accessKeyId }) {
  const { db } = await getOrgCollections();
  const res = await db
    .collection("s3_credentials")
    .updateOne({ ownerType: owner.type, ownerId: ownerId(owner), accessKeyId, revokedAt: null }, { $set: { revokedAt: new Date().toISOString() } });
  return res.matchedCount > 0;
}

/** Looks up a credential by its accessKeyId (never trusts an owner claimed
 *  by the request itself). Returns null for missing/revoked. */
export async function resolveS3Credential(accessKeyId) {
  const { db } = await getOrgCollections();
  const cred = await db.collection("s3_credentials").findOne({ accessKeyId, revokedAt: null });
  if (!cred) return null;
  const secretAccessKey = unwrapPassphrase(cred.wrappedSecretAccessKey);
  const owner = cred.ownerType === "org" ? { type: "org", orgId: cred.ownerId } : { type: "wallet", walletAddress: cred.ownerId };
  return { owner, accessKeyId, secretAccessKey };
}
