// src/lib/backupCryptoAndCredentials.js
//
// Modular Enterprise Adoption Features SOW, Feature 3 -- Smart Cloud
// Backup & Health Scheduler. Server-side storage of a customer's own
// AWS/Azure/GCS SOURCE credentials -- a genuine, deliberate departure
// from inaya-migration-agent's own explicit design ("credentials for
// both source and destination stay local to this process; the browser/
// web control plane never sees them," per that package's own
// package.json description). A RECURRING scheduler cannot honor that
// property structurally: nothing can re-run itself hours later without
// the platform holding a way to authenticate again. This is a real trust/
// liability shift for the org that configures a schedule, stated here
// plainly rather than glossed over.
//
// Same AES-256-GCM envelope-encryption SHAPE as integrationCrypto.js
// (iv+authTag+ciphertext, one opaque base64 string), but its OWN
// dedicated key (BACKUP_ENCRYPTION_KEY) -- this codebase's own
// established "one key per secret class" rule (see integrationCrypto.js's
// header): a compromise of the integrations key must never automatically
// expose a customer's raw cloud IAM credentials, and vice versa.
//
// BACKUP_ENCRYPTION_KEY must be a 32-byte key, base64-encoded, set once
// in .env.local / your deployment's env and never committed. Generate:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { getOrgCollections, canManageOrg, toObjectId } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function getKey() {
  const keyB64 = process.env.BACKUP_ENCRYPTION_KEY;
  if (!keyB64) throw new Error("BACKUP_ENCRYPTION_KEY is not configured — no cloud backup credential can be stored until it's set (32 random bytes, base64-encoded).");
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("BACKUP_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  return key;
}

function encryptBackupSecret(plaintext) {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/** Throws (never returns garbage) if tampered or the key is wrong -- GCM's
 *  auth tag check fails closed, same discipline as integrationCrypto.js. */
function decryptBackupSecret(encoded) {
  const key = getKey();
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = raw.subarray(IV_LENGTH + 16);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function isBackupCryptoConfigured() {
  return !!process.env.BACKUP_ENCRYPTION_KEY;
}

export const BACKUP_PROVIDERS = ["aws", "azure", "gcs"];

// Which fields each provider's credential actually needs -- validated
// against this, not a generic "credentials: object" blob, so a caller
// can't silently store the wrong shape for a provider.
const PROVIDER_FIELDS = {
  aws: ["accessKeyId", "secretAccessKey", "region"],
  azure: ["accountName", "accountKey"],
  gcs: ["hmacAccessId", "hmacSecret"],
};

function validateCredentialFields(provider, credentials) {
  const required = PROVIDER_FIELDS[provider];
  if (!required) return `Unknown provider "${provider}".`;
  const missing = required.filter((f) => !credentials?.[f]);
  if (missing.length > 0) return `Missing required field(s) for ${provider}: ${missing.join(", ")}.`;
  return null;
}

/** Stores one org's cloud-source credential, encrypted at rest under
 *  BACKUP_ENCRYPTION_KEY. The raw secret is never returned again after
 *  this call -- resolveBackupCredential() (below) is the only decrypt
 *  path, and it's only ever called server-side, from inside a backup run
 *  itself, never returned to a client. */
export async function storeBackupCredential({ orgId, provider, label, credentials, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can store a cloud backup credential.", status: 403 };
  if (!isBackupCryptoConfigured()) return { error: "Cloud backup credential storage is not configured on this deployment.", status: 503 };
  const validationError = validateCredentialFields(provider, credentials);
  if (validationError) return { error: validationError, status: 400 };

  const { backupCredentials } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), provider, label: label || null,
    credentialsEncrypted: encryptBackupSecret(JSON.stringify(credentials)),
    createdByEmail: actorEmail, createdAt: now, updatedAt: now, revokedAt: null,
  };
  const result = await backupCredentials.insertOne(doc);

  await logOrgActivity({ orgId, recordType: "BACKUP_CREDENTIAL", recordId: result.insertedId, actorEmail, action: "CREATED", previousState: null, newState: null, metadata: { provider, label: doc.label } });
  return { credentialId: result.insertedId, provider, label: doc.label, createdAt: now };
}

export async function listBackupCredentials(orgId) {
  const { backupCredentials } = await getOrgCollections();
  const docs = await backupCredentials.find({ orgId: toObjectId(orgId), revokedAt: null }).project({ credentialsEncrypted: 0 }).sort({ createdAt: -1 }).toArray();
  return docs;
}

export async function revokeBackupCredential({ orgId, credentialId, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can revoke a cloud backup credential.", status: 403 };
  const { backupCredentials } = await getOrgCollections();
  const result = await backupCredentials.findOneAndUpdate(
    { _id: toObjectId(credentialId), orgId: toObjectId(orgId), revokedAt: null },
    { $set: { revokedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!result) return { error: "Credential not found or already revoked.", status: 404 };
  await logOrgActivity({ orgId, recordType: "BACKUP_CREDENTIAL", recordId: result._id, actorEmail, action: "REVOKED", previousState: null, newState: null, metadata: {} });
  return { revoked: true };
}

/** The ONLY decrypt path -- called exclusively from inside a scheduled
 *  backup run (cloudBackupScheduler.js), never exposed through an API
 *  route that returns to a client. Returns null for a revoked/missing
 *  credential rather than throwing, so a run can report a clean
 *  "credential revoked" failure instead of crashing. */
export async function resolveBackupCredential({ orgId, credentialId }) {
  const { backupCredentials } = await getOrgCollections();
  const doc = await backupCredentials.findOne({ _id: toObjectId(credentialId), orgId: toObjectId(orgId), revokedAt: null });
  if (!doc) return null;
  return { provider: doc.provider, credentials: JSON.parse(decryptBackupSecret(doc.credentialsEncrypted)) };
}
