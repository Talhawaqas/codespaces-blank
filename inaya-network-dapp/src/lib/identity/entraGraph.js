// src/lib/identity/entraGraph.js
//
// SOW §10: optional PULL of users from Microsoft Entra ID through Microsoft Graph, with the organization's OWN app registration
// (client-credentials flow; needs the User.Read.All and GroupMember.Read.All application permissions with admin consent).
// This does not replace or touch Inaya's existing Entra sign-in / Azure Blob token authentication or the per-user delegated
// Microsoft connection: those are unchanged. The secret is stored encrypted on the provider and never returned.
//
// STATUS: implemented and tested against a local stand-in for the two Microsoft endpoints. NOT verified against a real Entra tenant.
// The endpoints can be overridden (GRAPH_LOGIN_BASE_URL / GRAPH_BASE_URL) only so tests can point at the stand-in.

import { graphSecretOf } from "./providers.js";
import { fail, IdentityError } from "./common.js";
import { assertWebhookUrl } from "../support/webhooks.js";

const LOGIN = () => (process.env.GRAPH_LOGIN_BASE_URL || "https://login.microsoftonline.com").replace(/\/$/, "");
const GRAPH = () => (process.env.GRAPH_BASE_URL || "https://graph.microsoft.com").replace(/\/$/, "");
const MAX_USERS = 20000;

async function json(url, init = {}) {
  assertWebhookUrl(url);
  const res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch { /* not json */ }
  if (res.status === 401 || res.status === 403) throw new IdentityError(`Microsoft refused the request (${res.status}). Check the app registration's permissions and admin consent.`, "AUTHORIZATION");
  if (res.status === 429) throw new IdentityError("Microsoft Graph rate limit.", "RATE_LIMIT");
  if (!res.ok) throw new IdentityError(`Microsoft answered ${res.status}.`, res.status >= 500 ? "PROVIDER" : "PERMANENT");
  return body;
}

async function token(provider) {
  const g = provider.graph; const secret = graphSecretOf(provider);
  if (!g?.clientId || !g?.tenantId || !secret) throw new IdentityError("Graph credentials are not configured on this provider.", "AUTHENTICATION");
  const b = await json(`${LOGIN()}/${encodeURIComponent(g.tenantId)}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: g.clientId, client_secret: secret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }).toString() });
  if (!b?.access_token) throw new IdentityError("Microsoft did not return a token.", "AUTHENTICATION");
  return b.access_token;
}

/** Returns canonical subjects for every user (with group names for the groups that mappings reference). */
export async function pullEntraUsers({ provider, groupIds = [] }) {
  const t = await token(provider);
  const h = { Authorization: `Bearer ${t}`, Accept: "application/json" };
  const users = []; let url = `${GRAPH()}/v1.0/users?$select=id,userPrincipalName,accountEnabled,mail,department,jobTitle,employeeId,employeeType,displayName&$top=500`;
  for (let i = 0; url && i < 100; i++) {
    const b = await json(url, { headers: h });
    for (const u of b.value || []) users.push({ externalId: u.id, upn: u.userPrincipalName, email: u.mail || u.userPrincipalName, displayName: u.displayName, department: u.department, jobTitle: u.jobTitle, employeeId: u.employeeId, employeeType: u.employeeType, accountEnabled: u.accountEnabled, groups: [] });
    if (users.length > MAX_USERS) throw new IdentityError("The directory is larger than the pull limit; use the snapshot endpoint.", "VALIDATION");
    url = b["@odata.nextLink"] || null;
  }
  const byId = new Map(users.map((u) => [u.externalId, u]));
  for (const gid of groupIds) {
    const g = await json(`${GRAPH()}/v1.0/groups/${encodeURIComponent(gid)}?$select=displayName`, { headers: h });
    let mu = `${GRAPH()}/v1.0/groups/${encodeURIComponent(gid)}/members?$select=id&$top=500`;
    for (let i = 0; mu && i < 100; i++) { const b = await json(mu, { headers: h }); for (const m of b.value || []) byId.get(m.id)?.groups.push(g.displayName); mu = b["@odata.nextLink"] || null; }
  }
  return users;
}
export { fail };
