// test/integration-oauth-refresh.test.mjs
//
// Business Workspace gap closure, Batch 4 — Microsoft OAuth connection
// fixes found during the live test (2026-10-18):
//   1. access tokens are refreshed before expiry (getFreshAccessToken), and
//      a permanently rejected refresh moves the connection to ERROR;
//   2. disconnect only ever deletes the user's OWN consent grant, never the
//      tenant admin's "AllPrincipals" consent covering everyone.
// Microsoft's endpoints are replaced by a fake fetch; the database is real.
//
// Run with: node --env-file=.env.local --test test/integration-oauth-refresh.test.mjs

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { encryptIntegrationSecret, decryptIntegrationSecret } from "../src/lib/integrationCrypto.js";
import { getFreshAccessToken, disconnectOauthConnection } from "../src/lib/integrationOauth.js";
import { revoke, refreshAccessToken } from "../src/lib/integrationProviders/microsoft.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER = { role: "owner" };
const realFetch = globalThis.fetch;
let c;
const cleanup = { orgIds: [] };
let calls = [];
let routes = {};

before(async () => {
  process.env.MICROSOFT_CLIENT_ID ||= "test-client-id";
  process.env.MICROSOFT_CLIENT_SECRET ||= "test-client-secret";
  await ensureOrgIndexes();
  c = await getOrgCollections();
});
after(async () => {
  globalThis.fetch = realFetch;
  await Promise.all([c.integrationConnections, c.orgActivity, c.auditChainEntries, c.auditChainHeads].map((x) => x.deleteMany({ orgId: { $in: cleanup.orgIds } })));
  await c.orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  await (await mongoClientPromise).close();
});
beforeEach(() => {
  calls = [];
  routes = {};
  // Fake Microsoft: match by method + URL prefix, record every call.
  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method || "GET";
    const body = opts.body ? String(opts.body) : "";
    calls.push({ method, url: String(url), body });
    const key = Object.keys(routes).find((k) => `${method} ${url}`.startsWith(k));
    const [status, json] = key ? routes[key]({ body }) : [404, { error: { message: "no fake route" } }];
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
});

const TOKEN_URL = "POST https://login.microsoftonline.com/common/oauth2/v2.0/token";
const ME = "GET https://graph.microsoft.com/v1.0/me?$select=id";
const GRANTS = "GET https://graph.microsoft.com/v1.0/me/oauth2PermissionGrants";

async function makeConnection(creds) {
  const orgId = (await c.orgs.insertOne({ name: `oauth-${RUN_ID}`, createdAt: new Date().toISOString() })).insertedId;
  cleanup.orgIds.push(orgId);
  await c.integrationConnections.insertOne({
    orgId, providerId: "microsoft_365", status: "ACTIVE", credentialsStatus: "verified", ownerEmail: `owner-${RUN_ID}@example.com`,
    credentialsEncrypted: encryptIntegrationSecret(JSON.stringify(creds)), externalAccountName: "bob@contoso.test", updatedAt: new Date().toISOString(),
  });
  return orgId;
}
const stored = async (orgId) => {
  const row = await c.integrationConnections.findOne({ orgId, providerId: "microsoft_365" });
  return { row, creds: row.credentialsEncrypted ? JSON.parse(decryptIntegrationSecret(row.credentialsEncrypted)) : null };
};
const inMinutes = (m) => new Date(Date.now() + m * 60_000).toISOString();

test("a token that is still valid is used as-is, with no call to Microsoft", async () => {
  const orgId = await makeConnection({ accessToken: "AT-1", refreshToken: "RT-1", accessTokenExpiresAt: inMinutes(30) });
  const r = await getFreshAccessToken({ orgId: orgId.toString(), providerId: "microsoft_365" });
  assert.deepEqual(r, { accessToken: "AT-1", refreshed: false });
  assert.equal(calls.length, 0);
});

test("an expiring token is refreshed, re-encrypted and stored; a rotated refresh token replaces the old one", async () => {
  const orgId = await makeConnection({ accessToken: "AT-old", refreshToken: "RT-old", accessTokenExpiresAt: inMinutes(1) });
  routes[TOKEN_URL] = ({ body }) => {
    assert.match(body, /grant_type=refresh_token/);
    assert.match(body, /refresh_token=RT-old/);
    assert.match(body, /client_secret=/);
    return [200, { access_token: "AT-new", refresh_token: "RT-new", expires_in: 3600 }];
  };
  const r = await getFreshAccessToken({ orgId: orgId.toString(), providerId: "microsoft_365" });
  assert.deepEqual(r, { accessToken: "AT-new", refreshed: true });
  const { row, creds } = await stored(orgId);
  assert.equal(creds.accessToken, "AT-new");
  assert.equal(creds.refreshToken, "RT-new");
  assert.ok(Date.parse(creds.accessTokenExpiresAt) > Date.now() + 50 * 60_000);
  assert.ok(row.tokenRefreshedAt);
  assert.ok(!JSON.stringify(row).includes("AT-new"), "tokens are never stored in plain text");
});

test("connections made before expiry was recorded refresh on first use, and keep the refresh token when Microsoft doesn't rotate it", async () => {
  const orgId = await makeConnection({ accessToken: "AT-legacy", refreshToken: "RT-keep" });
  routes[TOKEN_URL] = () => [200, { access_token: "AT-2", expires_in: 3600 }];
  const r = await getFreshAccessToken({ orgId: orgId.toString(), providerId: "microsoft_365" });
  assert.equal(r.accessToken, "AT-2");
  assert.equal((await stored(orgId)).creds.refreshToken, "RT-keep");
});

test("a refresh Microsoft rejects for good marks the connection ERROR instead of leaving it ACTIVE", async () => {
  const orgId = await makeConnection({ accessToken: "AT-x", refreshToken: "RT-revoked", accessTokenExpiresAt: inMinutes(-5) });
  routes[TOKEN_URL] = () => [400, { error: "invalid_grant", error_description: "AADSTS50173: The provided grant has expired." }];
  const r = await getFreshAccessToken({ orgId: orgId.toString(), providerId: "microsoft_365" });
  assert.equal(r.reconnectRequired, true);
  assert.match(r.error, /AADSTS50173/);
  const { row } = await stored(orgId);
  assert.equal(row.status, "ERROR");
  assert.equal(row.credentialsStatus, "refresh_failed");
  // A temporary failure (e.g. Microsoft 503) is reported but doesn't flip the connection.
  const org2 = await makeConnection({ accessToken: "AT-y", refreshToken: "RT-ok", accessTokenExpiresAt: inMinutes(-5) });
  routes[TOKEN_URL] = () => [503, { error: "temporarily_unavailable" }];
  assert.ok((await getFreshAccessToken({ orgId: org2.toString(), providerId: "microsoft_365" })).error);
  assert.equal((await stored(org2)).row.status, "ACTIVE");
  assert.match((await refreshAccessToken({ refreshToken: null, providerId: "microsoft_365" })).error, /reconnect/);
});

test("revoke deletes only this user's own grant, never the tenant admin's consent", async () => {
  routes[ME] = () => [200, { id: "user-bob" }];
  routes[GRANTS] = () => [200, { value: [
    { id: "admin-grant", consentType: "AllPrincipals", principalId: null },
    { id: "someone-else", consentType: "Principal", principalId: "user-alice" },
    { id: "bobs-grant", consentType: "Principal", principalId: "user-bob" },
  ] }];
  routes["DELETE https://graph.microsoft.com/v1.0/oauth2PermissionGrants/"] = () => [204, {}];
  assert.deepEqual(await revoke({ accessToken: "AT" }), { revoked: true });
  const deletes = calls.filter((x) => x.method === "DELETE");
  assert.deepEqual(deletes.map((d) => d.url.split("/").pop()), ["bobs-grant"]);
});

test("with only admin consent, revoke deletes nothing and points to the admin page", async () => {
  routes[ME] = () => [200, { id: "user-bob" }];
  routes[GRANTS] = () => [200, { value: [{ id: "admin-grant", consentType: "AllPrincipals", principalId: null }] }];
  const r = await revoke({ accessToken: "AT" });
  assert.equal(r.revoked, false);
  assert.equal(r.adminConsent, true);
  assert.match(r.manualRevokeUrl, /entra\.microsoft\.com/);
  assert.equal(calls.filter((x) => x.method === "DELETE").length, 0);
});

test("disconnect refreshes an expired token before revoking, then clears Inaya's stored token", async () => {
  const orgId = await makeConnection({ accessToken: "AT-expired", refreshToken: "RT-1", accessTokenExpiresAt: inMinutes(-10) });
  routes[TOKEN_URL] = () => [200, { access_token: "AT-fresh", refresh_token: "RT-2", expires_in: 3600 }];
  routes[ME] = () => [200, { id: "user-bob" }];
  routes[GRANTS] = () => [200, { value: [{ id: "admin-grant", consentType: "AllPrincipals" }] }];
  const r = await disconnectOauthConnection({ orgId: orgId.toString(), providerId: "microsoft_365", actorEmail: "owner@example.com", membership: OWNER });
  assert.equal(r.disconnected, true);
  assert.equal(r.revoked, false);
  const graphCalls = calls.filter((x) => x.url.startsWith("https://graph.microsoft.com"));
  assert.ok(graphCalls.length >= 2);
  const { row } = await stored(orgId);
  assert.equal(row.status, "DISABLED");
  assert.equal(row.credentialsEncrypted, null);
  assert.equal(calls.filter((x) => x.method === "DELETE").length, 0, "admin consent survives one person disconnecting");
});
