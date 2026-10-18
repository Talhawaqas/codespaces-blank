// src/lib/integrationOauth.js
//
// Business Workspace Integrations Test SOW — real OAuth orchestration for
// the 9 catalog entries that map to an actual standardized protocol:
// Slack, Microsoft (entra_id/microsoft_365/outlook/teams/sharepoint share
// one real Microsoft Graph app), Google Workspace, and Okta/Generic
// SAML-OIDC (both real OIDC, org-provided issuer+credentials). Every other
// catalog entry stays on integrations.js's existing honest "records intent
// only" state machine — see that file's own header comment for why (no
// single standardized API exists for "Custodian," "SIEM," "Civil Registry,"
// etc., since those are vendor CATEGORIES, not protocols).
//
// A connection reaches ACTIVE here ONLY after verifyConnection() — a real
// HTTPS call to the provider's own API — succeeds. Never on token receipt
// alone. This is the same "never fake ACTIVE" discipline
// configureIntegration()/recordSyncRun() already established, just backed
// by a genuine external call instead of an internal test hook.

import { randomBytes, createHash } from "node:crypto";
import { getOrgCollections, toObjectId } from "./orgs.js";
import { canManageOrg } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";
import { appendAuditEntry } from "./auditChain.js";
import { encryptIntegrationSecret, decryptIntegrationSecret } from "./integrationCrypto.js";
import * as slack from "./integrationProviders/slack.js";
import * as microsoft from "./integrationProviders/microsoft.js";
import * as google from "./integrationProviders/google.js";
import * as genericOidc from "./integrationProviders/genericOidc.js";

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes -- an OAuth redirect round trip is fast; no reason to keep a state longer

const ADAPTERS = {
  slack,
  entra_id: microsoft, microsoft_365: microsoft, outlook: microsoft, teams: microsoft, sharepoint: microsoft,
  google_workspace: google,
  okta: genericOidc, saml_oidc_generic: genericOidc,
};

export const OAUTH_BACKED_PROVIDER_IDS = Object.keys(ADAPTERS);

export function isOauthBackedProvider(providerId) {
  return !!ADAPTERS[providerId];
}

/** True only for okta/saml_oidc_generic -- these need a per-org issuer/
 *  clientId/clientSecret saved (via saveOrgOidcConfig) before oauth/start
 *  will work, unlike Slack/Microsoft/Google's single Inaya-owned app. */
export function requiresOrgOidcConfig(providerId) {
  return !!ADAPTERS[providerId]?.requiresOrgConfig;
}

function getAdapter(providerId) {
  return ADAPTERS[providerId] || null;
}

function generateState() {
  return randomBytes(32).toString("hex");
}
function hashState(state) {
  return createHash("sha256").update(state).digest("hex");
}

/** Persists an org's own OIDC app registration details (issuer/clientId/
 *  clientSecret) BEFORE starting the OAuth redirect — required for
 *  okta/saml_oidc_generic, meaningless for the globally-configured
 *  providers (Slack/Microsoft/Google use Inaya's own app, never an org's). */
export async function saveOrgOidcConfig({ orgId, providerId, issuer, clientId, clientSecret, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only an org owner/admin can configure an identity provider connection.", status: 403 };
  const adapter = getAdapter(providerId);
  if (!adapter || !adapter.requiresOrgConfig) return { error: `"${providerId}" does not accept a custom issuer/client configuration.`, status: 400 };
  if (!issuer || !clientId || !clientSecret) return { error: "issuer, clientId, and clientSecret are all required.", status: 400 };

  const { integrationConnections } = await getOrgCollections();
  const now = new Date().toISOString();
  await integrationConnections.updateOne(
    { orgId: toObjectId(orgId), providerId },
    {
      $set: {
        orgId: toObjectId(orgId), providerId,
        oauthConfig: { issuer: issuer.trim(), clientId: clientId.trim() },
        oauthClientSecretEncrypted: encryptIntegrationSecret(clientSecret),
        status: "AWAITING_CREDENTIALS", credentialsStatus: "provided_unverified", updatedAt: now,
      },
      $setOnInsert: { lastSyncAt: null, nextSyncAt: null, errorCount: 0, recordsProcessedTotal: 0, mismatchCountTotal: 0, createdAt: now },
    },
    { upsert: true }
  );
  return { ok: true };
}

/** Step 1 — generates real CSRF state, stores it server-side, and returns
 *  the provider's REAL authorization URL to redirect the browser to. */
export async function startOauthFlow({ orgId, providerId, actorEmail, membership, redirectUri }) {
  if (!canManageOrg(membership)) return { error: "Only an org owner/admin can connect an integration.", status: 403 };
  const adapter = getAdapter(providerId);
  if (!adapter) return { error: `"${providerId}" is not an OAuth-backed integration.`, status: 400 };

  const { integrationConnections, integrationOauthStates } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  let orgConfig = null;

  if (adapter.requiresOrgConfig) {
    const existing = await integrationConnections.findOne({ orgId: orgObjectId, providerId });
    if (!existing?.oauthConfig?.issuer || !existing?.oauthClientSecretEncrypted) {
      return { error: "Configure this connection's issuer, client ID, and client secret first.", status: 400 };
    }
    orgConfig = { ...existing.oauthConfig, clientSecret: decryptIntegrationSecret(existing.oauthClientSecretEncrypted) };
  } else if (!adapter.isConfigured({})) {
    return { error: `This server has no ${providerId} app credentials configured yet — an administrator must set them before anyone can connect.`, status: 503 };
  }

  const state = generateState();
  const now = new Date();
  await integrationOauthStates.insertOne({
    state: hashState(state), orgId: orgObjectId, providerId, actorEmail,
    createdAt: now, expiresAt: new Date(now.getTime() + STATE_TTL_MS),
  });

  let url;
  try {
    url = await adapter.buildAuthorizationUrl({ state, redirectUri, providerId, orgConfig });
  } catch (err) {
    return { error: err.message, status: 400 };
  }
  return { url };
}

/** Step 2 — the OAuth callback. Validates state (single-use, deleted on
 *  first use so a replayed callback can never re-process), exchanges the
 *  real code for a real token, and REQUIRES verifyConnection() to succeed
 *  before ever marking the connection ACTIVE. Any failure at any step
 *  moves the connection to the existing, honest ERROR state — never a
 *  silent success. */
export async function completeOauthFlow({ state, code, error: providerError, redirectUri }) {
  const { integrationOauthStates, integrationConnections } = await getOrgCollections();
  const stateDoc = await integrationOauthStates.findOneAndDelete({ state: hashState(state) });
  if (!stateDoc) return { error: "This authorization link has expired or was already used — please try connecting again.", status: 400 };

  const { orgId, providerId, actorEmail } = stateDoc;
  if (providerError) {
    await markConnectionError({ orgId, providerId, actorEmail, message: `The provider declined the request: ${providerError}` });
    return { orgId: orgId.toString(), providerId, success: false, error: providerError };
  }

  const adapter = getAdapter(providerId);
  if (!adapter) return { error: "Unknown OAuth provider.", status: 400 };

  let orgConfig = null;
  if (adapter.requiresOrgConfig) {
    const existing = await integrationConnections.findOne({ orgId, providerId });
    orgConfig = { ...existing.oauthConfig, clientSecret: decryptIntegrationSecret(existing.oauthClientSecretEncrypted) };
  }

  const tokenResult = await adapter.exchangeCodeForToken({ code, redirectUri, providerId, orgConfig });
  if (tokenResult.error) {
    await markConnectionError({ orgId, providerId, actorEmail, message: tokenResult.error });
    return { orgId: orgId.toString(), providerId, success: false, error: tokenResult.error };
  }

  const verification = await adapter.verifyConnection({ accessToken: tokenResult.accessToken, orgConfig });
  if (!verification.verified) {
    await markConnectionError({ orgId, providerId, actorEmail, message: verification.error || "Could not verify the connection." });
    return { orgId: orgId.toString(), providerId, success: false, error: verification.error };
  }

  const now = new Date().toISOString();
  const credentialsEncrypted = encryptIntegrationSecret(JSON.stringify({ accessToken: tokenResult.accessToken, refreshToken: tokenResult.refreshToken || null, accessTokenExpiresAt: expiryFrom(tokenResult.expiresIn) }));
  await integrationConnections.updateOne(
    { orgId, providerId },
    {
      $set: {
        status: "ACTIVE", credentialsStatus: "verified", credentialsEncrypted,
        externalAccountId: verification.externalAccountId || null, externalAccountName: verification.externalAccountName || null,
        lastSyncAt: now, updatedAt: now, ownerEmail: actorEmail,
      },
    },
    { upsert: true }
  );
  const connection = await integrationConnections.findOne({ orgId, providerId });

  await logOrgActivity({ orgId, recordType: "INTEGRATION_CONNECTION", recordId: connection._id, actorEmail, action: "OAUTH_CONNECTED", previousState: "AWAITING_CREDENTIALS", newState: "ACTIVE", metadata: { providerId, externalAccountName: verification.externalAccountName } });
  try { await appendAuditEntry({ orgId, recordType: "INTEGRATION_CONNECTION", recordId: connection._id, action: "OAUTH_CONNECTED", actorEmail, metadata: { providerId } }); } catch (err) { console.error("appendAuditEntry failed (non-fatal):", err.message); }

  return { orgId: orgId.toString(), providerId, success: true, externalAccountName: verification.externalAccountName };
}

const REFRESH_MARGIN_MS = 2 * 60 * 1000; // refresh a little before expiry, not after a call has already failed
const expiryFrom = (expiresIn) => (Number(expiresIn) > 0 ? new Date(Date.now() + Number(expiresIn) * 1000).toISOString() : null);

/**
 * Returns a usable access token for an ACTIVE OAuth connection, refreshing it
 * first when it is expired or about to expire (providers that implement
 * refreshAccessToken, e.g. Microsoft). The new token is re-encrypted and
 * stored. A refresh the provider rejects for good (revoked, password reset,
 * consent removed) moves the connection to ERROR so it is shown as needing
 * a reconnect — never left looking ACTIVE with a dead token.
 * Returns { accessToken, refreshed } or { error, reconnectRequired }.
 */
export async function getFreshAccessToken({ orgId, providerId, connection: given = null, now = Date.now() }) {
  const adapter = getAdapter(providerId);
  if (!adapter) return { error: `"${providerId}" is not an OAuth-backed integration.` };
  const { integrationConnections } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const connection = given || await integrationConnections.findOne({ orgId: orgObjectId, providerId });
  if (!connection?.credentialsEncrypted) return { error: "This integration has no stored credential; connect it first.", reconnectRequired: true };

  let creds;
  try { creds = JSON.parse(decryptIntegrationSecret(connection.credentialsEncrypted)); } catch { return { error: "The stored credential can't be read; reconnect this integration.", reconnectRequired: true }; }
  const expiresAt = creds.accessTokenExpiresAt ? Date.parse(creds.accessTokenExpiresAt) : null;
  const stillValid = expiresAt !== null && expiresAt - REFRESH_MARGIN_MS > now;
  // Providers without refresh support (or connections made before expiry was recorded and with no refresh token) use the token as-is.
  if (stillValid || typeof adapter.refreshAccessToken !== "function" || (!creds.refreshToken && expiresAt === null)) {
    return { accessToken: creds.accessToken, refreshed: false };
  }

  const refreshed = await adapter.refreshAccessToken({ refreshToken: creds.refreshToken, providerId });
  if (refreshed.error) {
    if (refreshed.reconnectRequired || !creds.refreshToken) {
      const ts = new Date().toISOString();
      await integrationConnections.updateOne({ _id: connection._id }, { $set: { status: "ERROR", credentialsStatus: "refresh_failed", updatedAt: ts }, $inc: { errorCount: 1 } });
      await logOrgActivity({ orgId: orgObjectId, recordType: "INTEGRATION_CONNECTION", recordId: connection._id, actorEmail: connection.ownerEmail || "system", action: "OAUTH_REFRESH_FAILED", previousState: connection.status, newState: "ERROR", metadata: { providerId, message: refreshed.error } });
    }
    return { error: refreshed.error, reconnectRequired: !!refreshed.reconnectRequired };
  }
  const next = { accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken || creds.refreshToken || null, accessTokenExpiresAt: expiryFrom(refreshed.expiresIn) };
  await integrationConnections.updateOne(
    { _id: connection._id },
    { $set: { credentialsEncrypted: encryptIntegrationSecret(JSON.stringify(next)), credentialsStatus: "verified", tokenRefreshedAt: new Date().toISOString() } }
  );
  return { accessToken: next.accessToken, refreshed: true };
}

async function markConnectionError({ orgId, providerId, actorEmail, message }) {
  const { integrationConnections } = await getOrgCollections();
  const now = new Date().toISOString();
  await integrationConnections.updateOne(
    { orgId, providerId },
    { $set: { status: "ERROR", credentialsStatus: "invalid", updatedAt: now }, $inc: { errorCount: 1 } },
    { upsert: true }
  );
  const connection = await integrationConnections.findOne({ orgId, providerId });
  await logOrgActivity({ orgId, recordType: "INTEGRATION_CONNECTION", recordId: connection._id, actorEmail, action: "OAUTH_FAILED", previousState: "AWAITING_CREDENTIALS", newState: "ERROR", metadata: { providerId, message } });
}

/** Real disconnect — calls the provider's own revoke() where one exists
 *  (Slack, Google, and any OIDC provider that advertises a revocation
 *  endpoint), THEN clears Inaya's own stored token and flips the
 *  connection to DISABLED via the existing disableIntegration() state
 *  machine (reused, not duplicated). */
export async function disconnectOauthConnection({ orgId, providerId, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only an org owner/admin can disconnect an integration.", status: 403 };
  const adapter = getAdapter(providerId);
  if (!adapter) return { error: `"${providerId}" is not an OAuth-backed integration.`, status: 400 };

  const { integrationConnections } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const connection = await integrationConnections.findOne({ orgId: orgObjectId, providerId });
  if (!connection) return { error: "No connection to disconnect.", status: 404 };

  let revokeResult = { revoked: false, note: "No live credential was stored to revoke." };
  if (connection.credentialsEncrypted) {
    try {
      // Refresh first when the provider supports it, so revoke still works after the access token's first hour.
      const fresh = await getFreshAccessToken({ orgId, providerId, connection });
      const accessToken = fresh.accessToken || JSON.parse(decryptIntegrationSecret(connection.credentialsEncrypted)).accessToken;
      let orgConfig = null;
      if (adapter.requiresOrgConfig) orgConfig = { ...connection.oauthConfig, clientSecret: decryptIntegrationSecret(connection.oauthClientSecretEncrypted) };
      revokeResult = await adapter.revoke({ accessToken, orgConfig });
    } catch (err) {
      revokeResult = { revoked: false, error: err.message };
    }
  }

  const now = new Date().toISOString();
  await integrationConnections.updateOne(
    { orgId: orgObjectId, providerId },
    { $set: { status: "DISABLED", credentialsEncrypted: null, externalAccountId: null, externalAccountName: null, updatedAt: now } }
  );
  await logOrgActivity({ orgId, recordType: "INTEGRATION_CONNECTION", recordId: connection._id, actorEmail, action: "OAUTH_DISCONNECTED", previousState: connection.status, newState: "DISABLED", metadata: { providerId, revoked: revokeResult.revoked, manualRevokeUrl: revokeResult.manualRevokeUrl || null } });

  return {
    disconnected: true,
    revoked: revokeResult.revoked,
    note: revokeResult.note || revokeResult.error || null,
    // Present whenever the provider can't guarantee revocation happened via
    // API alone (tenant policy, missing grant, etc.) -- the caller (API
    // route / UI) must surface this so the user can complete it themselves
    // on the provider's own site instead of assuming silent success.
    manualRevokeUrl: revokeResult.manualRevokeUrl || null,
  };
}
