// src/lib/analytics/oauth.js
//
// Microsoft Power BI integration (SOW INAYA-BOS-POWERBI-SOW-2026-V1, Enterprise only): the OAuth 2.0 authorisation server
// that lets the Inaya Power BI connector read the Analytics API without any shared or long-lived secret (SOW 8.1).
//
//   authorise   /business/powerbi-authorize: the person signs in (passkey, company SSO or an emailed code), picks the company
//               and approves; a single-use authorisation code (2 minutes, PKCE S256, bound to the redirect URI) is issued.
//   token       grant_type=authorization_code -> access token (60 minutes) + refresh token; grant_type=refresh_token ->
//               both rotated. Presenting an already-rotated refresh token revokes the whole grant (token theft signal).
//   revoke      by the connector, by the person, or by an owner/admin in Admin > Integrations > Power BI.
//
// Access tokens are HMAC-signed (key derived from INTEGRATION_ENCRYPTION_KEY) and carry only the grant id and expiry. Every
// API request re-checks the grant, the person's active membership and roles, the company's Enterprise package, licence and
// the Power BI switch (SOW 8.2: "re-check authorisation on every API request and refresh"), so removing someone in Inaya
// stops their data at the next request even if a token has not expired yet.
//
// Storage, no new collections: grants live in `api_keys` (kind "oauth_grant"; never matched by the API-key resolver, which
// looks up `tokenHash`), authorisation codes and emailed sign-in codes in `mfa_pending`.

import { createHmac, createHash, timingSafeEqual, randomInt } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, toObjectId, hashToken, generateToken, normalizeEmail, isValidEmail, getMembership, canManageOrg, createSession } from "../orgs.js";
import { connectToDatabase } from "../mongodb.js";
import { planAllows, PLAN_GATE_PROJECTION } from "../planGates.js";
import { isFeatureEnabled } from "../featureFlags.js";
import { logOrgActivity } from "../org-activity-log.js";

export const CLIENT_ID = "inaya-powerbi";
// Power Query's OAuth redirect for custom connectors (Power BI Desktop, the gateway and the Service all use it).
export const REDIRECT_URIS = ["https://oauth.powerbi.com/views/oauthredirect.html"];
export const SCOPE = "analytics.read";
const CODE_TTL_MS = 2 * 60 * 1000;
export const ACCESS_TTL_S = 60 * 60;
export const REFRESH_IDLE_MS = 90 * 24 * 60 * 60 * 1000;
const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
const nowIso = () => new Date().toISOString();

export class OAuthError extends Error { constructor(status, error, description) { super(description); this.status = status; this.error = error; } }
const fail = (status, error, description) => { throw new OAuthError(status, error, description); };

async function cols() {
  const { db } = await connectToDatabase();
  return { grants: db.collection("api_keys"), pending: db.collection("mfa_pending") };
}
function tokenKey() {
  const k = process.env.INTEGRATION_ENCRYPTION_KEY || (process.env.NODE_ENV !== "production" ? "inaya-dev-analytics-key" : "");
  if (!k) fail(503, "server_error", "Token signing is not configured on this server.");
  return createHash("sha256").update(`inaya-analytics-access-token|${k}`).digest();
}
const b64u = (x) => Buffer.from(x).toString("base64url");

/** Pure helpers. */
export const challengeOf = (verifier) => createHash("sha256").update(String(verifier)).digest("base64url");
export function signAccessToken({ grantId, exp }) {
  const body = b64u(JSON.stringify({ g: String(grantId), exp }));
  return `iat1.${body}.${b64u(createHmac("sha256", tokenKey()).update(body).digest())}`;
}
export function readAccessToken(token, now = Date.now()) {
  const [v, body, sig] = String(token || "").split(".");
  if (v !== "iat1" || !body || !sig) return null;
  const want = createHmac("sha256", tokenKey()).update(body).digest(); const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let p; try { p = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return null; }
  if (!p?.g || !Number.isFinite(p.exp) || p.exp * 1000 <= now) return null;
  return p;
}

// ------------------------------------------------------------------------------------------------ eligibility
/** Who may connect Power BI for a company: the company is entitled, and the person is an owner/admin, or the company lets members connect. */
export async function connectEligibility(orgId, email) {
  const { orgs } = await getOrgCollections();
  const org = await orgs.findOne({ _id: toObjectId(orgId) }, { projection: { name: 1, powerBi: 1, ...PLAN_GATE_PROJECTION } });
  if (!org) return { ok: false, reason: "Company not found." };
  if (!planAllows(org, "powerBi")) return { ok: false, reason: "Power BI is included in the Enterprise package." };
  if (!(await isFeatureEnabled("FEATURE_POWER_BI", String(org._id)))) return { ok: false, reason: "Power BI is not switched on for this company yet." };
  const { companyMayOperate } = await import("../licensing/gate.js");
  if (!(await companyMayOperate(org._id))) return { ok: false, reason: "This company's Business OS license is not active." };
  const membership = await getMembership(String(org._id), email);
  if (!membership) return { ok: false, reason: "You are not an active member of this company." };
  if (!canManageOrg(membership) && !org.powerBi?.membersMayConnect) return { ok: false, reason: "Only owners and admins can connect Power BI for this company. Ask an admin to allow members." };
  return { ok: true, org, membership };
}

/** Companies the signed-in person could connect, for the authorise page. */
export async function connectableCompanies(email) {
  const { orgMembers } = await getOrgCollections();
  const ms = await orgMembers.find({ email: normalizeEmail(email), status: "active" }, { projection: { orgId: 1 } }).limit(50).toArray();
  const out = [];
  for (const m of ms) { const e = await connectEligibility(String(m.orgId), email); out.push({ orgId: String(m.orgId), name: e.org?.name || null, ok: e.ok, reason: e.ok ? null : e.reason }); }
  const { orgs } = await getOrgCollections();
  const names = new Map((await orgs.find({ _id: { $in: ms.map((m) => m.orgId) } }, { projection: { name: 1 } }).toArray()).map((o) => [String(o._id), o.name]));
  return out.map((c) => ({ ...c, name: c.name || names.get(c.orgId) || "Company" }));
}

// ------------------------------------------------------------------------------------------------ authorise
export function validateAuthorizeParams(q) {
  if (q.response_type !== "code") fail(400, "unsupported_response_type", "Only response_type=code is supported.");
  if (q.client_id !== CLIENT_ID) fail(400, "invalid_client", "Unknown client.");
  if (!REDIRECT_URIS.includes(q.redirect_uri)) fail(400, "invalid_request", "This redirect address is not allowed.");
  if (q.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(String(q.code_challenge || ""))) fail(400, "invalid_request", "A PKCE S256 code challenge is required.");
  if (typeof q.state !== "string" || !q.state || q.state.length > 500) fail(400, "invalid_request", "state is required.");
  return { clientId: q.client_id, redirectUri: q.redirect_uri, codeChallenge: q.code_challenge, state: q.state };
}

/** Consent given on the authorise page: returns the redirect (with code and state) for the browser. */
export async function approve({ email, orgId, params }) {
  const p = validateAuthorizeParams(params);
  const e = await connectEligibility(orgId, email); if (!e.ok) fail(403, "access_denied", e.reason);
  const code = generateToken();
  await (await cols()).pending.insertOne({ tokenHash: hashToken(code), purpose: "pbi-code", email: normalizeEmail(email), orgId: e.org._id, clientId: p.clientId, redirectUri: p.redirectUri, codeChallenge: p.codeChallenge, usedAt: null, attempts: 0, expiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(), createdAt: nowIso() });
  const u = new URL(p.redirectUri); u.searchParams.set("code", code); u.searchParams.set("state", p.state);
  return { redirect: u.toString() };
}

// ------------------------------------------------------------------------------------------------ token
function tokenResponse(grantId, refreshToken) {
  const exp = Math.floor(Date.now() / 1000) + ACCESS_TTL_S;
  return { access_token: signAccessToken({ grantId, exp }), token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refreshToken, scope: SCOPE };
}

export async function exchangeToken(form) {
  const { grants, pending } = await cols();
  if (form.client_id && form.client_id !== CLIENT_ID) fail(401, "invalid_client", "Unknown client.");
  if (form.grant_type === "authorization_code") {
    const row = await pending.findOneAndUpdate({ tokenHash: hashToken(String(form.code || "")), purpose: "pbi-code", usedAt: null }, { $set: { usedAt: nowIso() } });
    if (!row || new Date(row.expiresAt).getTime() < Date.now()) fail(400, "invalid_grant", "The authorisation code is invalid or expired.");
    if (form.redirect_uri !== row.redirectUri) fail(400, "invalid_grant", "The redirect address does not match.");
    if (challengeOf(String(form.code_verifier || "")) !== row.codeChallenge) fail(400, "invalid_grant", "The PKCE verifier does not match.");
    const e = await connectEligibility(String(row.orgId), row.email); if (!e.ok) fail(400, "invalid_grant", e.reason);
    const refresh = generateToken(); const _id = new ObjectId();
    await grants.insertOne({ _id, kind: "oauth_grant", tokenHash: `oauth-grant:${_id}`, client: CLIENT_ID, /* tokenHash: the collection's unique index; never the sha256 of an API key */ orgId: row.orgId, email: row.email, refreshHash: hashToken(refresh), previousRefreshHashes: [], scope: SCOPE, createdAt: nowIso(), lastUsedAt: nowIso(), refreshedAt: nowIso(), revokedAt: null, revokedBy: null, label: "Power BI" });
    await logOrgActivity({ orgId: row.orgId, recordType: "POWER_BI", recordId: _id, actorEmail: row.email, action: "POWERBI_CONNECTED", previousState: null, newState: null, metadata: {} }).catch(() => {});
    return tokenResponse(_id, refresh);
  }
  if (form.grant_type === "refresh_token") {
    const h = hashToken(String(form.refresh_token || ""));
    const g = await grants.findOne({ kind: "oauth_grant", refreshHash: h });
    if (!g) {
      const reused = await grants.findOne({ kind: "oauth_grant", previousRefreshHashes: h, revokedAt: null });
      if (reused) { await revokeGrant({ grantId: reused._id, by: "system: refresh token reused" }); }
      fail(400, "invalid_grant", "The refresh token is invalid.");
    }
    if (g.revokedAt) fail(400, "invalid_grant", "This connection was revoked in Inaya.");
    if (Date.now() - new Date(g.refreshedAt || g.createdAt).getTime() > REFRESH_IDLE_MS) { await revokeGrant({ grantId: g._id, by: "system: unused for 90 days" }); fail(400, "invalid_grant", "This connection expired. Sign in again."); }
    const e = await connectEligibility(String(g.orgId), g.email); if (!e.ok) fail(400, "invalid_grant", e.reason);
    const refresh = generateToken();
    const r = await grants.updateOne({ _id: g._id, refreshHash: h, revokedAt: null }, { $set: { refreshHash: hashToken(refresh), refreshedAt: nowIso() }, $push: { previousRefreshHashes: { $each: [h], $slice: -20 } } });
    if (!r.modifiedCount) fail(400, "invalid_grant", "The refresh token is invalid.");
    return tokenResponse(g._id, refresh);
  }
  fail(400, "unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
}

export async function revokeGrant({ grantId, by }) {
  const { grants } = await cols();
  const g = await grants.findOneAndUpdate({ _id: toObjectId(grantId), kind: "oauth_grant", revokedAt: null }, { $set: { revokedAt: nowIso(), revokedBy: by } });
  if (g) await logOrgActivity({ orgId: g.orgId, recordType: "POWER_BI", recordId: g._id, actorEmail: String(by).slice(0, 120), action: "POWERBI_REVOKED", previousState: null, newState: null, metadata: { person: g.email } }).catch(() => {});
  return !!g;
}

/** RFC 7009: revoke by refresh or access token. Always succeeds from the caller's point of view. */
export async function revokeToken(token) {
  const { grants } = await cols();
  const p = (() => { try { return readAccessToken(token); } catch { return null; } })();
  const g = p ? await grants.findOne({ _id: toObjectId(p.g), kind: "oauth_grant" }) : await grants.findOne({ kind: "oauth_grant", refreshHash: hashToken(String(token || "")) });
  if (g) await revokeGrant({ grantId: g._id, by: g.email });
  return { ok: true };
}

// ------------------------------------------------------------------------------------------------ resource-server check
/** For every Analytics API request: { orgId, email, membership, grant } or throws 401/403. */
export async function requireAnalyticsToken(req) {
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Bearer ")) fail(401, "invalid_token", "Sign in to Inaya from Power BI.");
  const p = readAccessToken(h.slice(7).trim()); if (!p) fail(401, "invalid_token", "The access token is invalid or expired.");
  const { grants } = await cols();
  const g = await grants.findOne({ _id: toObjectId(p.g), kind: "oauth_grant" });
  if (!g || g.revokedAt) fail(401, "invalid_token", "This Power BI connection was revoked in Inaya. Sign in again.");
  const e = await connectEligibility(String(g.orgId), g.email); if (!e.ok) fail(403, "insufficient_scope", e.reason);
  const { slidingWindowCheck } = await import("../rateLimit.js");
  const rl = await slidingWindowCheck({ action: "analytics-api", key: String(g._id), max: 600, windowMs: 10 * 60 * 1000 }).catch(() => ({ allowed: true }));
  if (rl && rl.allowed === false) fail(429, "rate_limited", "Too many requests. Power BI will retry; spread refreshes out or contact Inaya to raise the limit.");
  grants.updateOne({ _id: g._id }, { $set: { lastUsedAt: nowIso() } }).catch(() => {});
  return { orgId: String(g.orgId), email: g.email, membership: e.membership, grant: g };
}

// ------------------------------------------------------------------------------------------------ admin
export async function powerBiAdmin({ orgId, membership }) {
  const { orgs } = await getOrgCollections();
  const org = await orgs.findOne({ _id: toObjectId(orgId) }, { projection: { name: 1, powerBi: 1, ...PLAN_GATE_PROJECTION } });
  const entitled = planAllows(org || {}, "powerBi"); const switchedOn = await isFeatureEnabled("FEATURE_POWER_BI", orgId);
  const { grants } = await cols();
  const q = { kind: "oauth_grant", orgId: toObjectId(orgId), ...(canManageOrg(membership) ? {} : { email: normalizeEmail(membership.email) }) };
  const rows = await grants.find(q, { projection: { refreshHash: 0, previousRefreshHashes: 0 } }).sort({ createdAt: -1 }).limit(200).toArray();
  return { entitled, switchedOn, canManage: canManageOrg(membership), membersMayConnect: !!org?.powerBi?.membersMayConnect,
    connections: rows.map((g) => ({ id: String(g._id), email: g.email, createdAt: g.createdAt, lastUsedAt: g.lastUsedAt, revokedAt: g.revokedAt, revokedBy: g.revokedAt ? g.revokedBy : null })) };
}
export async function setPowerBiSettings({ orgId, membership, actorEmail, membersMayConnect }) {
  if (!canManageOrg(membership)) fail(403, "access_denied", "Only an owner or admin can change Power BI settings.");
  const { orgs } = await getOrgCollections();
  await orgs.updateOne({ _id: toObjectId(orgId) }, { $set: { "powerBi.membersMayConnect": membersMayConnect === true, "powerBi.updatedAt": nowIso(), "powerBi.updatedBy": actorEmail } });
  await logOrgActivity({ orgId, recordType: "POWER_BI", recordId: toObjectId(orgId), actorEmail, action: "POWERBI_SETTINGS_UPDATED", previousState: null, newState: null, metadata: { membersMayConnect: membersMayConnect === true } }).catch(() => {});
  return powerBiAdmin({ orgId, membership });
}
export async function adminRevoke({ orgId, membership, actorEmail, grantId }) {
  const { grants } = await cols();
  const g = await grants.findOne({ _id: toObjectId(grantId), kind: "oauth_grant", orgId: toObjectId(orgId) });
  if (!g) fail(404, "not_found", "Connection not found.");
  if (!canManageOrg(membership) && g.email !== normalizeEmail(membership.email)) fail(403, "access_denied", "You can only disconnect your own Power BI connection.");
  await revokeGrant({ grantId: g._id, by: actorEmail });
  return powerBiAdmin({ orgId, membership });
}
/** Every connection of one person in one company ends (used when someone loses access). */
export async function revokeAllFor({ orgId, email, by }) {
  const { grants } = await cols();
  const ids = (await grants.find({ kind: "oauth_grant", orgId: toObjectId(orgId), email: normalizeEmail(email), revokedAt: null }, { projection: { _id: 1 } }).toArray()).map((g) => g._id);
  for (const id of ids) await revokeGrant({ grantId: id, by });
  return ids.length;
}

// ------------------------------------------------------------------------------------------------ emailed sign-in code
// The Power BI sign-in window is an embedded browser: an email link would open somewhere else. So the authorise page can
// also sign someone in with a 6-digit code sent to their email (10 minutes, 5 tries). People with two-step verification
// must also give their authenticator code; companies that require SSO cannot use it.
export async function sendEmailCode(rawEmail) {
  const email = normalizeEmail(rawEmail); if (!isValidEmail(email)) fail(400, "invalid_request", "Enter a valid email.");
  const { ssoRequiredFor } = await import("../workforceSso.js"); const sso = await ssoRequiredFor(email); if (sso) fail(403, "access_denied", sso);
  const { orgMembers } = await getOrgCollections();
  const member = await orgMembers.findOne({ email, status: "active" }, { projection: { _id: 1 } });
  const { pending } = await cols();
  if (member) {
    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    await pending.deleteMany({ purpose: "pbi-email-code", email });
    await pending.insertOne({ tokenHash: hashToken(`${email}:${code}`), purpose: "pbi-email-code", email, usedAt: null, attempts: 0, expiresAt: new Date(Date.now() + EMAIL_CODE_TTL_MS).toISOString(), createdAt: nowIso() });
    const { sendEmail } = await import("../email.js");
    await sendEmail({ to: email, subject: `Your Inaya sign-in code: ${code}`, text: `Your code to sign in to Inaya from Power BI is ${code}. It expires in 10 minutes.\n\nIf you did not try to connect Power BI, ignore this email.\n\nInaya Network` }).catch(() => {});
  }
  return { sent: true }; // same answer whether or not the email has an account
}
export async function verifyEmailCode(rawEmail, code) {
  const email = normalizeEmail(rawEmail); const { pending } = await cols();
  const row = await pending.findOne({ purpose: "pbi-email-code", email, usedAt: null });
  if (!row || new Date(row.expiresAt).getTime() < Date.now() || row.attempts >= 5) fail(400, "invalid_grant", "The code has expired. Request a new one.");
  if (row.tokenHash !== hashToken(`${email}:${String(code || "").trim()}`)) { await pending.updateOne({ _id: row._id }, { $inc: { attempts: 1 } }); fail(400, "invalid_grant", "That code is not right."); }
  await pending.updateOne({ _id: row._id }, { $set: { usedAt: nowIso() } });
  const { isMfaEnrolled, issueMfaPendingToken } = await import("../mfa.js");
  if (await isMfaEnrolled(email)) return { mfaRequired: true, mfaPendingToken: await issueMfaPendingToken(email) };
  const { sessionToken } = await createSession(email);
  return { sessionToken, email };
}
