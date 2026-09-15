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

/** Returns { accessKeyId, secretAccessKey } -- secretAccessKey is the only time
 *  the raw value is ever available; only its wrapped form is persisted. */
export async function issueS3Credential({ owner, label, actorEmail }) {
  await ensureOwnerS3Passphrase(owner);
  const { db } = await getOrgCollections();
  const accessKeyId = generateAccessKeyId();
  const secretAccessKey = generateSecretAccessKey();
  const now = new Date().toISOString();
  await db.collection("s3_credentials").insertOne({
    ownerType: owner.type,
    ownerId: ownerId(owner),
    accessKeyId,
    wrappedSecretAccessKey: wrapPassphrase(secretAccessKey),
    secretFingerprint: hashToken(secretAccessKey),
    label: label || null,
    createdByEmail: actorEmail || null,
    createdAt: now,
    revokedAt: null,
  });
  return { accessKeyId, secretAccessKey, createdAt: now };
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
