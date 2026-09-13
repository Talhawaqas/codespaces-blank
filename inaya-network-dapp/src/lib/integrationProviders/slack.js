// src/lib/integrationProviders/slack.js
//
// Business Workspace Integrations Test SOW — a REAL Slack OAuth v2
// connection. Requires a real Slack app registered at api.slack.com/apps
// with SLACK_CLIENT_ID/SLACK_CLIENT_SECRET set in env (never fabricated —
// this file makes real HTTPS calls to Slack's real API; it does nothing
// without genuine credentials configured).
//
// Scopes requested are read-only and minimal (channels:read, team:read) —
// enough to prove a real, verifiable connection (auth.test) without
// requesting posting/write access this feature doesn't use yet.

const SCOPES = "channels:read,team:read";

export const requiresOrgConfig = false;

export function isConfigured() {
  return !!(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET);
}

export function buildAuthorizationUrl({ state, redirectUri }) {
  const params = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID,
    scope: SCOPES,
    redirect_uri: redirectUri,
    state,
  });
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

export async function exchangeCodeForToken({ code, redirectUri }) {
  const params = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID,
    client_secret: process.env.SLACK_CLIENT_SECRET,
    code,
    redirect_uri: redirectUri,
  });
  const res = await fetch("https://slack.com/api/oauth.v2.access", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params });
  const data = await res.json();
  if (!data.ok) return { error: data.error || "Slack rejected the authorization code." };
  return { accessToken: data.access_token, raw: data };
}

/** The real proof-of-connection call — Slack's own auth.test endpoint
 *  confirms the token is genuinely live and returns the real team/user it
 *  belongs to. A connection is only ever marked ACTIVE after THIS call
 *  succeeds, never just after a token was received. */
export async function verifyConnection({ accessToken }) {
  const res = await fetch("https://slack.com/api/auth.test", { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (!data.ok) return { verified: false, error: data.error || "Slack could not verify this token." };
  return { verified: true, externalAccountId: data.team_id, externalAccountName: data.team };
}

export async function revoke({ accessToken }) {
  try {
    const res = await fetch("https://slack.com/api/auth.revoke", { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await res.json();
    return { revoked: !!data.ok };
  } catch (err) {
    return { revoked: false, error: err.message };
  }
}
