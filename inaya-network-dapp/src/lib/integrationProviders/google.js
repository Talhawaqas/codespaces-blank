// src/lib/integrationProviders/google.js
//
// Business Workspace Integrations Test SOW — a REAL Google OAuth 2.0
// connection for Google Workspace. Requires a real Google Cloud OAuth
// client with GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET set in env — this file
// makes real HTTPS calls to accounts.google.com/oauth2.googleapis.com;
// nothing here is simulated. Read-only identity scope only (this feature
// proves and records a connection, it does not yet sync any Workspace data).

const SCOPE = "openid email profile";

export const requiresOrgConfig = false;

export function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function buildAuthorizationUrl({ state, redirectUri }) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCodeForToken({ code, redirectUri }) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params });
  const data = await res.json();
  if (!res.ok) return { error: data.error_description || data.error || "Google rejected the authorization code." };
  return { accessToken: data.access_token, refreshToken: data.refresh_token, raw: data };
}

/** The real proof-of-connection call — Google's own userinfo endpoint. */
export async function verifyConnection({ accessToken }) {
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (!res.ok) return { verified: false, error: data.error?.message || data.error || "Google could not verify this token." };
  return { verified: true, externalAccountId: data.sub, externalAccountName: data.email || data.name };
}

/** Google DOES support real, scoped token revocation. */
export async function revoke({ accessToken }) {
  try {
    const res = await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(accessToken)}`, { method: "POST" });
    return { revoked: res.ok };
  } catch (err) {
    return { revoked: false, error: err.message };
  }
}
