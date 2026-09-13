// src/lib/integrationProviders/genericOidc.js
//
// Business Workspace Integrations Test SOW — a REAL, standards-based
// OpenID Connect client, used by BOTH "Okta" and the OIDC half of
// "Generic SAML/OIDC". Unlike Slack/Microsoft/Google (one Inaya-owned app
// registration serves every customer), OIDC identity providers are
// inherently bring-your-own: each ORG provides its own issuer URL plus a
// client ID/secret it registers in ITS OWN Okta/IdP admin console for our
// callback URL. requiresOrgConfig is therefore true — orgConfig
// {issuer, clientId, clientSecret} comes from that org's own connection
// document (clientSecret stored encrypted, same as any OAuth token).
//
// HONESTY BOUNDARY, stated explicitly: this file implements the OIDC half
// of "Generic SAML/OIDC" for real (discovery + authorization-code exchange
// + userinfo verification — all genuine HTTPS calls to whatever issuer the
// org configures). It does NOT implement SAML — parsing and cryptographically
// validating signed SAML XML assertions is a materially different, larger
// undertaking requiring a dedicated SAML library (e.g. node-saml), which is
// not a dependency of this codebase today. An org selecting "SAML" mode is
// told this plainly rather than being given a connection that silently
// does nothing.

export const requiresOrgConfig = true;

async function discover(issuer) {
  const normalizedIssuer = issuer.replace(/\/$/, "");
  const res = await fetch(`${normalizedIssuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`Could not reach the OIDC discovery document at ${normalizedIssuer} (HTTP ${res.status}).`);
  return res.json();
}

export function isConfigured({ orgConfig }) {
  return !!(orgConfig?.issuer && orgConfig?.clientId && orgConfig?.clientSecret);
}

export async function buildAuthorizationUrl({ state, redirectUri, orgConfig }) {
  if (!orgConfig?.issuer || !orgConfig?.clientId) {
    throw new Error("This connection needs an issuer URL and client ID configured first.");
  }
  const config = await discover(orgConfig.issuer);
  const params = new URLSearchParams({
    client_id: orgConfig.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: "openid profile email",
    state,
  });
  return `${config.authorization_endpoint}?${params.toString()}`;
}

export async function exchangeCodeForToken({ code, redirectUri, orgConfig }) {
  const config = await discover(orgConfig.issuer);
  const params = new URLSearchParams({
    client_id: orgConfig.clientId,
    client_secret: orgConfig.clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(config.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params });
  const data = await res.json();
  if (!res.ok) return { error: data.error_description || data.error || "The identity provider rejected the authorization code." };
  return { accessToken: data.access_token, refreshToken: data.refresh_token, raw: data };
}

/** The real proof-of-connection call — the provider's own userinfo
 *  endpoint, discovered from ITS OWN real metadata document, not
 *  hardcoded. */
export async function verifyConnection({ accessToken, orgConfig }) {
  const config = await discover(orgConfig.issuer);
  if (!config.userinfo_endpoint) return { verified: false, error: "This identity provider's discovery document has no userinfo endpoint." };
  const res = await fetch(config.userinfo_endpoint, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (!res.ok) return { verified: false, error: data.error_description || data.error || "The identity provider could not verify this token." };
  return { verified: true, externalAccountId: data.sub, externalAccountName: data.email || data.preferred_username || data.name };
}

export async function revoke({ accessToken, orgConfig }) {
  try {
    const config = await discover(orgConfig.issuer);
    if (!config.revocation_endpoint) return { revoked: false, note: "This identity provider does not advertise a revocation endpoint." };
    const params = new URLSearchParams({ token: accessToken, client_id: orgConfig.clientId, client_secret: orgConfig.clientSecret });
    const res = await fetch(config.revocation_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params });
    return { revoked: res.ok };
  } catch (err) {
    return { revoked: false, error: err.message };
  }
}
