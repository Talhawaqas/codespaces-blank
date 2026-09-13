// src/lib/integrationProviders/microsoft.js
//
// Business Workspace Integrations Test SOW — a REAL Microsoft identity
// platform (Entra ID) OAuth 2.0 / OpenID Connect connection via the
// multi-tenant "common" endpoint + Microsoft Graph. Requires a real Azure
// App Registration with MICROSOFT_CLIENT_ID/MICROSOFT_CLIENT_SECRET set in
// env — this file makes real HTTPS calls to login.microsoftonline.com and
// graph.microsoft.com; nothing here is simulated.
//
// ONE real app registration backs FIVE of the SOW's 33 catalog entries
// (entra_id, microsoft_365, outlook, teams, sharepoint) — they are all the
// same Microsoft identity platform underneath, differing only in which
// Graph scope is requested and which Graph endpoint proves the connection,
// exactly like a real enterprise customer would experience (one Azure AD
// admin consent covers every Microsoft 365 workload).
//
// Revocation, stated precisely: Microsoft has no per-token "kill this one
// access token" endpoint (the broad /me/revokeSignInSessions kills ALL of
// that user's sessions everywhere — too blunt for a single integration's
// disconnect). What DOES exist, and what revoke() actually calls, is the
// real Microsoft Graph oauth2PermissionGrants endpoint: it looks up this
// app's own delegated consent grant for the signed-in user and deletes it —
// Microsoft's real mechanism for "this app may no longer act on my behalf."
//
// Calling that endpoint at all requires the "Directory.AccessAsUser.All"
// delegated scope, which is why it's included below even though nothing
// else in this integration needs it. Trade-off, stated plainly: this is a
// broader permission than a minimal read-only Graph connection would
// otherwise need, and many Entra ID tenants require a TENANT ADMIN (not
// the individual user) to grant consent for it — so on first connect, some
// organizations will see an admin-consent prompt instead of instant
// sign-in. That's the real cost of making revoke genuinely callable rather
// than cosmetic. Even with the scope granted, some tenant policies still
// block a user from deleting their own grant (403) — revoke() reports that
// honestly (revoked:false) rather than claiming success, and callers must
// still surface MANUAL_REVOKE_URL so the user has a guaranteed path
// (Microsoft's own "Apps and services" self-service page) to finish the
// revocation themselves regardless of whether the API call was allowed.

// "Directory.AccessAsUser.All" is appended to every scope list below solely
// so revoke() can call oauth2PermissionGrants for real -- see module header.
const REVOKE_SCOPE = "Directory.AccessAsUser.All";
const GRAPH_SCOPE_BY_PROVIDER = {
  entra_id: `openid profile email offline_access ${REVOKE_SCOPE}`,
  microsoft_365: `openid profile email offline_access Mail.Read Files.Read.All ${REVOKE_SCOPE}`,
  outlook: `openid profile email offline_access Mail.Read ${REVOKE_SCOPE}`,
  teams: `openid profile email offline_access Team.ReadBasic.All ${REVOKE_SCOPE}`,
  sharepoint: `openid profile email offline_access Sites.Read.All ${REVOKE_SCOPE}`,
};

export const requiresOrgConfig = false;
export const MICROSOFT_PROVIDER_IDS = Object.keys(GRAPH_SCOPE_BY_PROVIDER);

// Microsoft's own real self-service page for reviewing/removing an app's
// access — the guaranteed fallback when the API-based revoke can't run
// (tenant policy) or can't be confirmed. Always a correct, live Microsoft
// URL, never fabricated.
export const MANUAL_REVOKE_URL = "https://myaccount.microsoft.com/consent";

export function isConfigured() {
  return !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET);
}

export function buildAuthorizationUrl({ state, redirectUri, providerId }) {
  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: GRAPH_SCOPE_BY_PROVIDER[providerId] || GRAPH_SCOPE_BY_PROVIDER.entra_id,
    state,
  });
  return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`;
}

export async function exchangeCodeForToken({ code, redirectUri, providerId }) {
  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    scope: GRAPH_SCOPE_BY_PROVIDER[providerId] || GRAPH_SCOPE_BY_PROVIDER.entra_id,
  });
  const res = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params });
  const data = await res.json();
  if (!res.ok) return { error: data.error_description || data.error || "Microsoft rejected the authorization code." };
  return { accessToken: data.access_token, refreshToken: data.refresh_token, raw: data };
}

/** The real proof-of-connection call — Microsoft Graph's own /me endpoint,
 *  which only ever succeeds against a genuinely valid, live access token. */
export async function verifyConnection({ accessToken }) {
  const res = await fetch("https://graph.microsoft.com/v1.0/me", { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (!res.ok) return { verified: false, error: data.error?.message || "Microsoft Graph could not verify this token." };
  return { verified: true, externalAccountId: data.id, externalAccountName: data.userPrincipalName || data.mail || data.displayName };
}

/** Real revoke attempt — finds THIS app's own delegated consent grant via
 *  Graph and deletes it. Falls back to an honest failure (never a false
 *  "revoked:true") plus MANUAL_REVOKE_URL when the tenant restricts this
 *  call or no grant is found. */
export async function revoke({ accessToken }) {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  try {
    const listRes = await fetch(
      `https://graph.microsoft.com/v1.0/me/oauth2PermissionGrants?$filter=${encodeURIComponent(`clientId eq '${clientId}'`)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const listData = await listRes.json().catch(() => ({}));
    if (!listRes.ok) {
      return { revoked: false, error: listData.error?.message || `Microsoft Graph would not list this account's consent grants (HTTP ${listRes.status}).`, manualRevokeUrl: MANUAL_REVOKE_URL };
    }

    const grant = listData.value?.[0];
    if (!grant) {
      return { revoked: false, note: "No revocable consent grant was found for this app under this account (it may have been granted by a tenant admin, which only that admin can revoke).", manualRevokeUrl: MANUAL_REVOKE_URL };
    }

    const deleteRes = await fetch(`https://graph.microsoft.com/v1.0/oauth2PermissionGrants/${grant.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (deleteRes.status === 204) return { revoked: true };

    const deleteData = await deleteRes.json().catch(() => ({}));
    return { revoked: false, error: deleteData.error?.message || `Microsoft Graph would not delete the consent grant (HTTP ${deleteRes.status}).`, manualRevokeUrl: MANUAL_REVOKE_URL };
  } catch (err) {
    return { revoked: false, error: err.message, manualRevokeUrl: MANUAL_REVOKE_URL };
  }
}
