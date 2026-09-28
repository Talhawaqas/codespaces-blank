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
//
// SECURITY (found in the September 2026 hardening pass): every fetch in this file targets a URL
// that traces back to an org-supplied issuer -- the discovery document itself, then whatever
// authorization/token/userinfo/revocation endpoints THAT document names. A malicious or
// compromised org's OIDC configuration could previously point any of those at an internal service
// or a cloud metadata endpoint and have the response reflected back through this app's own error
// messages -- a classic SSRF. Every fetch here now goes through ssrfSafeFetch.js (the same
// private-address/metadata-host/DNS-rebinding guard workflows/http.js already proved out for the
// same class of "org-supplied URL this server must fetch" problem), and the endpoint URLs the
// discovery document itself names are validated again before use, since a malicious issuer's own
// discovery document is exactly as untrusted as the issuer URL was.

import { ssrfSafeFetch, assertPublicHttpsUrl } from "../ssrfSafeFetch.js";

export const requiresOrgConfig = true;

async function discover(issuer) {
  const normalizedIssuer = issuer.replace(/\/$/, "");
  assertPublicHttpsUrl(normalizedIssuer);
  const res = await ssrfSafeFetch(`${normalizedIssuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`Could not reach the OIDC discovery document at ${normalizedIssuer} (HTTP ${res.status}).`);
  const config = await res.json();
  // The discovery document is itself untrusted (an org could point issuer at a host it fully
  // controls and hand back any document it likes) -- every endpoint it names is validated the
  // same way the issuer URL was, not trusted just because it came from a "discovery" response.
  for (const key of ["authorization_endpoint", "token_endpoint", "userinfo_endpoint", "revocation_endpoint"]) {
    if (config[key]) assertPublicHttpsUrl(config[key]);
  }
  return config;
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
  const res = await ssrfSafeFetch(config.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString() });
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
  const res = await ssrfSafeFetch(config.userinfo_endpoint, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (!res.ok) return { verified: false, error: data.error_description || data.error || "The identity provider could not verify this token." };
  return { verified: true, externalAccountId: data.sub, externalAccountName: data.email || data.preferred_username || data.name };
}

export async function revoke({ accessToken, orgConfig }) {
  try {
    const config = await discover(orgConfig.issuer);
    if (!config.revocation_endpoint) return { revoked: false, note: "This identity provider does not advertise a revocation endpoint." };
    const params = new URLSearchParams({ token: accessToken, client_id: orgConfig.clientId, client_secret: orgConfig.clientSecret });
    const res = await ssrfSafeFetch(config.revocation_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString() });
    return { revoked: res.ok };
  } catch (err) {
    return { revoked: false, error: err.message };
  }
}
