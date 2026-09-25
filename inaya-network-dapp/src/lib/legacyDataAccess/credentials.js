// src/lib/legacyDataAccess/credentials.js
//
// Mainframe & Legacy Data Access + Real-Time SQL Virtualization SOW.
// Server-side storage of a data source's own connection credentials
// (host/port/user/password/dataset, or in this pass's only real
// connector's case, a filesystem path -- see connectors/relational.js).
//
// Same AES-256-GCM envelope-encryption SHAPE as
// backupCryptoAndCredentials.js (iv+authTag+ciphertext, one opaque
// base64 string), but its OWN dedicated key (LEGACY_SOURCE_ENCRYPTION_KEY)
// -- this codebase's established "one key per secret class" rule (see
// integrationCrypto.js's header, backupCryptoAndCredentials.js's header):
// a compromise of the backup-credential key must never automatically
// expose a mainframe/legacy connection secret, and vice versa.
//
// LEGACY_SOURCE_ENCRYPTION_KEY must be a 32-byte key, base64-encoded, set
// once in .env.local / your deployment's env and never committed. Generate:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { getOrgCollections, canManageDataSources, toObjectId } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function getKey() {
  const keyB64 = process.env.LEGACY_SOURCE_ENCRYPTION_KEY;
  if (!keyB64) throw new Error("LEGACY_SOURCE_ENCRYPTION_KEY is not configured — no data source credential can be stored until it's set (32 random bytes, base64-encoded).");
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("LEGACY_SOURCE_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  return key;
}

function encryptSourceSecret(plaintext) {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/** Throws (never returns garbage) if tampered or the key is wrong -- GCM's
 *  auth tag check fails closed, same discipline as backupCryptoAndCredentials.js. */
function decryptSourceSecret(encoded) {
  const key = getKey();
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = raw.subarray(IV_LENGTH + 16);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function isLegacyCredentialCryptoConfigured() {
  return !!process.env.LEGACY_SOURCE_ENCRYPTION_KEY;
}

// Which connection fields each connector type actually needs -- validated
// against this, not a generic "credentials: object" blob. Only "relational"
// (this pass's real, tested node:sqlite reference connector) has an entry;
// adabas/vsam/ims/rms-openvms are deliberately absent -- adding a
// PROVIDER_FIELDS entry for one of them is a real implementation claim,
// not a placeholder to fill in speculatively. See
// docs/MAINFRAME_DATA_ACCESS_CAPABILITY_AUDIT.md.
export const PROVIDER_FIELDS = {
  relational: ["filePath"],
};

function validateCredentialFields(connectorType, credentials) {
  const required = PROVIDER_FIELDS[connectorType];
  if (!required) return `Unknown or not-yet-implemented connector type "${connectorType}".`;
  const missing = required.filter((f) => !credentials?.[f]);
  if (missing.length > 0) return `Missing required field(s) for ${connectorType}: ${missing.join(", ")}.`;
  return null;
}

/** Stores one data source's connection credential, encrypted at rest under
 *  LEGACY_SOURCE_ENCRYPTION_KEY. The raw secret is never returned again
 *  after this call -- resolveDataSourceCredential() (below) is the only
 *  decrypt path, called exclusively server-side from inside the connector
 *  layer, never returned to a client. */
export async function storeDataSourceCredential({ orgId, dataSourceId, connectorType, credentials, actorEmail, membership }) {
  if (!canManageDataSources(membership)) return { error: "Only a data source manager can store a connection credential.", status: 403 };
  if (!isLegacyCredentialCryptoConfigured()) return { error: "Data source credential storage is not configured on this deployment.", status: 503 };
  const validationError = validateCredentialFields(connectorType, credentials);
  if (validationError) return { error: validationError, status: 400 };

  const { legacySourceCredentials } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), dataSourceId: toObjectId(dataSourceId), connectorType,
    credentialsEncrypted: encryptSourceSecret(JSON.stringify(credentials)),
    createdByEmail: actorEmail, createdAt: now, updatedAt: now, revokedAt: null,
  };
  const result = await legacySourceCredentials.insertOne(doc);

  await logOrgActivity({ orgId, recordType: "LEGACY_SOURCE_CREDENTIAL", recordId: result.insertedId, actorEmail, action: "CREATED", previousState: null, newState: null, metadata: { dataSourceId: dataSourceId.toString(), connectorType } });
  return { credentialId: result.insertedId, connectorType, createdAt: now };
}

export async function revokeDataSourceCredential({ orgId, credentialId, actorEmail, membership }) {
  if (!canManageDataSources(membership)) return { error: "Only a data source manager can revoke a connection credential.", status: 403 };
  const { legacySourceCredentials } = await getOrgCollections();
  const result = await legacySourceCredentials.findOneAndUpdate(
    { _id: toObjectId(credentialId), orgId: toObjectId(orgId), revokedAt: null },
    { $set: { revokedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!result) return { error: "Credential not found or already revoked.", status: 404 };
  await logOrgActivity({ orgId, recordType: "LEGACY_SOURCE_CREDENTIAL", recordId: result._id, actorEmail, action: "REVOKED", previousState: null, newState: null, metadata: {} });
  return { revoked: true };
}

/** The ONLY decrypt path -- called exclusively from inside the connector
 *  layer (dataSources.js), never exposed through an API route that
 *  returns to a client. Returns null for a revoked/missing credential
 *  rather than throwing, so a caller can report a clean "credential
 *  revoked" failure instead of crashing. */
export async function resolveDataSourceCredential({ orgId, dataSourceId }) {
  const { legacySourceCredentials } = await getOrgCollections();
  const doc = await legacySourceCredentials.findOne({ orgId: toObjectId(orgId), dataSourceId: toObjectId(dataSourceId), revokedAt: null }, { sort: { createdAt: -1 } });
  if (!doc) return null;
  return { connectorType: doc.connectorType, credentials: JSON.parse(decryptSourceSecret(doc.credentialsEncrypted)) };
}
