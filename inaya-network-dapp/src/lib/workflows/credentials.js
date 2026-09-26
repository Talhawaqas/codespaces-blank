// src/lib/workflows/credentials.js
//
// SOW §32: external integrations never put raw secrets inside a workflow.
// A workflow references a credential by id; the secret itself lives only in
// `workflowCredentials`, encrypted with the existing integration key
// (integrationCrypto.js -- the same AES-256-GCM used for Slack/Microsoft
// tokens). Every read of the secret is an audited event. Definitions,
// executions, exports and logs only ever carry the id.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { canManageOrg } from "../orgGates.js";
import { logOrgActivity } from "../org-activity-log.js";
import { encryptIntegrationSecret, decryptIntegrationSecret, isIntegrationCryptoConfigured } from "../integrationCrypto.js";
import { fail } from "./common.js";

export const CREDENTIAL_PROVIDERS = {
  http_bearer: { fields: ["token"], label: "HTTP bearer token" },
  http_header: { fields: ["headerName", "value"], label: "HTTP custom header" },
  http_basic: { fields: ["username", "password"], label: "HTTP basic auth" },
  slack_webhook: { fields: ["url"], label: "Slack incoming webhook" },
  // Either a refresh token (recommended: the server mints a short-lived access token per send) or, for a quick test, an access token.
  gmail_oauth: { fields: ["clientId", "clientSecret", "refreshToken"], optionalFields: ["accessToken"], label: "Gmail OAuth (client id + secret + refresh token)" },
};

const publicView = (c) => ({
  credentialId: String(c._id), provider: c.provider, label: c.label, scope: c.scope, ownerOrgId: String(c.orgId),
  createdBy: c.createdBy, createdAt: c.createdAt, expiresAt: c.expiresAt || null, status: c.status,
  lastUsedAt: c.lastUsedAt || null, usageCount: c.usageCount || 0,
});

async function audit(orgId, credentialId, actorEmail, action, metadata) {
  await logOrgActivity({ orgId, recordType: "WORKFLOW_CREDENTIAL", recordId: credentialId, actorEmail, action, previousState: null, newState: null, metadata }).catch(() => {});
}

export async function createCredential({ orgId, provider, label, secret, allowedHosts = [], expiresAt = null, membership, actorEmail }) {
  if (!canManageOrg(membership)) return fail("Only an owner or admin can manage workflow credentials.", 403);
  const def = CREDENTIAL_PROVIDERS[provider];
  if (!def) return fail(`Unknown credential provider. Use one of ${Object.keys(CREDENTIAL_PROVIDERS).join(", ")}.`);
  if (!label || String(label).length > 80) return fail("A label (up to 80 characters) is required.");
  if (!secret || typeof secret !== "object") return fail("secret must be an object.");
  const gmailTokenOnly = provider === "gmail_oauth" && secret.accessToken && !secret.refreshToken;
  for (const f of gmailTokenOnly ? ["accessToken"] : def.fields) if (!secret[f] || typeof secret[f] !== "string" || secret[f].length > 4000) return fail(`secret.${f} is required.`);
  if (provider === "slack_webhook" && !/^https:\/\/hooks\.slack\.com\/services\//.test(secret.url)) return fail("A Slack webhook must be an https://hooks.slack.com/services/... URL.");
  if (!isIntegrationCryptoConfigured()) return fail("Credential storage is not available: INTEGRATION_ENCRYPTION_KEY is not configured on this server.", 503);
  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) return fail("expiresAt is not a valid date.");
  const hosts = (Array.isArray(allowedHosts) ? allowedHosts : []).map((h) => String(h).toLowerCase()).filter((h) => /^[a-z0-9.-]{3,253}$/.test(h));
  const { workflowCredentials } = await getOrgCollections();
  const pick = {};
  for (const f of [...def.fields, ...(def.optionalFields || [])]) if (secret[f] && typeof secret[f] === "string" && secret[f].length <= 4000) pick[f] = secret[f];
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), provider, label: String(label), scope: { allowedHosts: provider === "slack_webhook" ? ["hooks.slack.com"] : hosts },
    secretEncrypted: encryptIntegrationSecret(JSON.stringify(pick)), createdBy: actorEmail, createdAt: now, expiresAt: expiresAt || null,
    status: "ACTIVE", usageCount: 0, lastUsedAt: null,
  };
  const r = await workflowCredentials.insertOne(doc);
  await audit(orgId, r.insertedId, actorEmail, "CREDENTIAL_CREATED", { credentialId: String(r.insertedId), provider, label: doc.label });
  return { credential: publicView({ ...doc, _id: r.insertedId }) };
}

export async function listCredentials({ orgId, membership }) {
  if (!canManageOrg(membership)) return fail("Only an owner or admin can view workflow credentials.", 403);
  const { workflowCredentials } = await getOrgCollections();
  const rows = await workflowCredentials.find({ orgId: toObjectId(orgId) }).sort({ createdAt: -1 }).limit(200).toArray();
  return { credentials: rows.map(publicView) };
}

export async function revokeCredential({ orgId, credentialId, membership, actorEmail }) {
  if (!canManageOrg(membership)) return fail("Only an owner or admin can revoke a workflow credential.", 403);
  const { workflowCredentials } = await getOrgCollections();
  let r;
  try {
    r = await workflowCredentials.findOneAndUpdate({ _id: toObjectId(credentialId), orgId: toObjectId(orgId), status: "ACTIVE" }, { $set: { status: "REVOKED", revokedAt: new Date().toISOString(), secretEncrypted: null } }, { returnDocument: "after" });
  } catch { return fail("Invalid credential id.", 400); }
  if (!r) return fail("Credential not found or already revoked.", 404);
  await audit(orgId, credentialId, actorEmail, "CREDENTIAL_REVOKED", { credentialId: String(credentialId) });
  return { credential: publicView(r) };
}

/** Public status of a credential without touching the secret (publish validation). */
export async function credentialStatus({ orgId, credentialId }) {
  const { workflowCredentials } = await getOrgCollections();
  let c;
  try { c = await workflowCredentials.findOne({ _id: toObjectId(credentialId), orgId: toObjectId(orgId) }); } catch { return { ok: false, reason: "NOT_FOUND" }; }
  if (!c) return { ok: false, reason: "NOT_FOUND" };
  if (c.status !== "ACTIVE") return { ok: false, reason: c.status };
  if (c.expiresAt && Date.parse(c.expiresAt) <= Date.now()) return { ok: false, reason: "EXPIRED" };
  return { ok: true, provider: c.provider, allowedHosts: c.scope?.allowedHosts || [] };
}

/**
 * Resolves and decrypts a credential for ONE use. Fails closed on: wrong org,
 * revoked, expired, host outside the credential's scope. Every successful
 * resolution is written to the audit chain (no secret in the entry).
 */
export async function resolveCredential({ orgId, credentialId, host = null, providerWanted = null, executionId = null, nodeKey = null, actorEmail = "system" }) {
  const { workflowCredentials } = await getOrgCollections();
  let c;
  try { c = await workflowCredentials.findOne({ _id: toObjectId(credentialId), orgId: toObjectId(orgId) }); } catch { c = null; }
  if (!c) return fail("The credential was not found for this organization.", 404, { reasonCode: "CREDENTIAL_NOT_FOUND" });
  if (c.status !== "ACTIVE" || !c.secretEncrypted) return fail("The credential has been revoked.", 403, { reasonCode: "CREDENTIAL_REVOKED" });
  if (c.expiresAt && Date.parse(c.expiresAt) <= Date.now()) return fail("The credential has expired.", 403, { reasonCode: "CREDENTIAL_EXPIRED" });
  if (providerWanted && !providerWanted.includes(c.provider)) return fail("The credential is the wrong kind for this node.", 400, { reasonCode: "CREDENTIAL_WRONG_PROVIDER" });
  if (host && c.scope?.allowedHosts?.length && !c.scope.allowedHosts.includes(String(host).toLowerCase())) return fail("The credential is not permitted for that host.", 403, { reasonCode: "CREDENTIAL_HOST_NOT_ALLOWED" });
  let secret;
  try { secret = JSON.parse(decryptIntegrationSecret(c.secretEncrypted)); } catch { return fail("The credential could not be decrypted.", 500, { reasonCode: "CREDENTIAL_UNREADABLE" }); }
  await workflowCredentials.updateOne({ _id: c._id }, { $set: { lastUsedAt: new Date().toISOString() }, $inc: { usageCount: 1 } });
  await audit(orgId, c._id, actorEmail, "CREDENTIAL_USED", { credentialId: String(c._id), provider: c.provider, executionId, nodeKey, host });
  return { secret, provider: c.provider };
}
