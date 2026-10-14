// src/lib/infrastructure/awsCredentials.js
//
// Gap-closure round, Phase B: AWS-CLI-shaped access key pairs, scoped to an
// org, verified by awsSigV4.js. Secret encrypted at rest reusing the exact
// same at-rest encryption helper already used for the infra CA's private
// key (nodeCerts.js -- see its own header comment: "the same scheme every
// other at-rest credential in this codebase already uses"), not a new
// scheme invented for this one case.

import crypto from "node:crypto";
import { getOrgCollections } from "../orgs.js";
import { InfrastructureError } from "./nodes.js";
import { encryptIntegrationSecret, decryptIntegrationSecret, isIntegrationCryptoConfigured } from "../integrationCrypto.js";
import { appendAuditEntry } from "../auditChain.js";

let indexed = false;
async function cols() {
  const c = await getOrgCollections();
  const keys = c.db.collection("infra_aws_credentials");
  if (!indexed) {
    await Promise.all([keys.createIndex({ accessKeyId: 1 }, { unique: true }), keys.createIndex({ orgId: 1 })]);
    indexed = true;
  }
  return { c, keys };
}

// Real AWS access-key-ID shape: botocore's own client-side validation
// (and some services' server-side validation) rejects IDs that don't look
// like this, so a real `aws configure` + real `aws-cli` call needs a
// genuinely conformant ID, not an arbitrary string.
function generateAccessKeyId() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC4648 base32, AWS's own access-key alphabet
  let id = "AKIA";
  const bytes = crypto.randomBytes(16);
  for (let i = 0; i < 16; i++) id += alphabet[bytes[i] % alphabet.length];
  return id;
}

function generateSecretAccessKey() {
  // 40 chars, base64-ish -- matches the real shape (length and charset)
  // botocore itself emits for its own generated keys, not a convenience
  // shortcut.
  return crypto.randomBytes(30).toString("base64").replace(/\+/g, "A").replace(/\//g, "B").slice(0, 40);
}

export async function createAccessKey({ orgId, membership }) {
  if (!isIntegrationCryptoConfigured()) {
    throw new InfrastructureError("INTEGRATION_ENCRYPTION_KEY is not configured -- an AWS secret key cannot be stored until it's set.", { status: 500 });
  }
  const accessKeyId = generateAccessKeyId();
  const secretAccessKey = generateSecretAccessKey();
  const { keys } = await cols();
  await keys.insertOne({
    accessKeyId,
    orgId,
    secretAccessKeyEncrypted: encryptIntegrationSecret(secretAccessKey),
    status: "ACTIVE",
    createdAt: new Date(),
    createdBy: membership?.email || null,
    revokedAt: null,
  });
  await appendAuditEntry({ orgId, recordType: "INFRA_AWS_CREDENTIAL", recordId: accessKeyId, actorEmail: membership?.email || null, action: "AWS_ACCESS_KEY_CREATED", previousState: null, newState: { status: "ACTIVE" }, metadata: {} }).catch(() => {});
  // Returned exactly once, like every other bearer credential in this
  // codebase (enrollment tokens, API keys) -- never retrievable again.
  return { accessKeyId, secretAccessKey };
}

export async function listAccessKeys({ orgId }) {
  const { keys } = await cols();
  const docs = await keys.find({ orgId }).sort({ createdAt: -1 }).toArray();
  return docs.map(({ secretAccessKeyEncrypted, ...rest }) => rest);
}

export async function revokeAccessKey({ orgId, membership, accessKeyId }) {
  const { keys } = await cols();
  const doc = await keys.findOne({ orgId, accessKeyId });
  if (!doc) throw new InfrastructureError("Access key not found.", { status: 404 });
  await keys.updateOne({ orgId, accessKeyId }, { $set: { status: "REVOKED", revokedAt: new Date(), revokedBy: membership?.email || null } });
  await appendAuditEntry({ orgId, recordType: "INFRA_AWS_CREDENTIAL", recordId: accessKeyId, actorEmail: membership?.email || null, action: "AWS_ACCESS_KEY_REVOKED", previousState: { status: doc.status }, newState: { status: "REVOKED" }, metadata: {} }).catch(() => {});
  return { accessKeyId, status: "REVOKED" };
}

/** Looks up an access key across ALL orgs (the EC2 route itself has no org
 *  session -- identity derives only from the credential, same discipline
 *  as api-keys.js's requireApiKey/nodes.js's verifyNodeAuth). Returns
 *  `null` for an unknown or revoked key, never throws -- the caller (
 *  awsSigV4's getSecretForAccessKey) treats null as "signature can't
 *  verify", same as any other wrong secret. */
export async function resolveAccessKey({ accessKeyId }) {
  const { keys } = await cols();
  const doc = await keys.findOne({ accessKeyId, status: "ACTIVE" });
  if (!doc) return null;
  return { orgId: doc.orgId, secretAccessKey: decryptIntegrationSecret(doc.secretAccessKeyEncrypted) };
}
