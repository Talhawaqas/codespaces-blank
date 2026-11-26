// src/lib/workforceSso.js
//
// Staff single sign-on (SSO) into Inaya Business OS: Enterprise package ("SSO & Advanced Admin Controls"). OpenID Connect
// authorization-code flow with PKCE against the company's own identity provider: Microsoft Entra ID, Google Workspace, Okta,
// Auth0, Keycloak or any standards-compliant OIDC provider. The ID-token checks are the customer-portal SSO's (support/sso.js:
// RS256/ES256 only, provider keys, issuer, audience, expiry, nonce), reused rather than duplicated.
//
// Configuration lives on the organization document (`workforceSso`), no new collection:
//   { enabled, issuer, clientId, clientSecretEncrypted, domains: ["example.com"], enforce, requireVerifiedEmail, updatedAt, updatedBy }
// * `domains`: the email domains this company signs in with. A domain can belong to only one company's SSO.
// * `enforce`: when on, people with those email domains can no longer sign in with an email link or Google; they must use SSO
//   (passkeys still work: they are registered only after a signed-in session). The owner who switches it on is never locked
//   out by it: the setting cannot be saved until the provider answers the test.
// * SSO proves who someone is. It never creates access by itself: the person must already be an active member of the
//   company, or hold a pending invitation to it (which SSO then accepts, exactly as an email link would).
//
// In-flight logins use `mfa_pending` (`purpose: "workforce-sso"`, hashed single-use state, 10 minutes).

import { createHash } from "node:crypto";
import { getOrgCollections, toObjectId, normalizeEmail, isValidEmail, hashToken, generateToken } from "./orgs.js";
import { canManageOrg } from "./orgGates.js";
import { connectToDatabase } from "./mongodb.js";
import { discover, verifyIdToken } from "./support/sso.js";
import { assertWebhookUrl } from "./support/webhooks.js";
import { encryptIntegrationSecret, decryptIntegrationSecret, isIntegrationCryptoConfigured } from "./integrationCrypto.js";
import { requirePlanFeature, planAllows, PLAN_GATE_PROJECTION } from "./planGates.js";
import { logOrgActivity } from "./org-activity-log.js";

const STATE_TTL_MS = 10 * 60 * 1000;
const DOMAIN = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const nowIso = () => new Date().toISOString();

export class SsoError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new SsoError(status, message); };

export const appUrl = () => (process.env.NEXT_PUBLIC_APP_URL || "https://www.inayanetwork.com").replace(/\/$/, "");
export const workforceRedirectUri = () => `${appUrl()}/api/orgs/login/sso/callback`;

const view = (c) => ({ enabled: !!c?.enabled, issuer: c?.issuer || "", clientId: c?.clientId || "", clientSecretSet: !!c?.clientSecretEncrypted, domains: c?.domains || [], enforce: !!c?.enforce, requireVerifiedEmail: c?.requireVerifiedEmail !== false, updatedAt: c?.updatedAt || null, redirectUri: workforceRedirectUri() });

async function loadOrg(orgId) {
  const { orgs } = await getOrgCollections();
  return orgs.findOne({ _id: toObjectId(orgId) }, { projection: { name: 1, workforceSso: 1, ...PLAN_GATE_PROJECTION } });
}
async function gate(orgId, membership) {
  if (!canManageOrg(membership)) fail(403, "Only an owner or admin can manage single sign-on.");
  const g = await requirePlanFeature(orgId, "sso"); if (g) fail(403, g.error);
}

export async function getWorkforceSso({ orgId, membership }) { await gate(orgId, membership); return view((await loadOrg(orgId))?.workforceSso); }

/** Pure validation of the editable fields. Returns { value, errors }. */
export function validateSsoInput(input = {}, existing = {}) {
  const errors = []; const v = {};
  const issuer = String(input.issuer ?? existing.issuer ?? "").trim().replace(/\/$/, "");
  if (issuer) { try { const u = new URL(issuer); if (u.protocol !== "https:") errors.push("The issuer must start with https://."); } catch { errors.push("The issuer must be a web address."); } }
  v.issuer = issuer;
  v.clientId = String(input.clientId ?? existing.clientId ?? "").trim().slice(0, 300);
  const domains = (Array.isArray(input.domains) ? input.domains : existing.domains || []).map((d) => String(d).trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
  if (domains.length > 20) errors.push("Up to 20 email domains."); if (domains.some((d) => !DOMAIN.test(d))) errors.push("Each domain must look like example.com.");
  if (domains.some((d) => ["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "live.com"].includes(d))) errors.push("Public email domains (such as gmail.com) cannot be claimed for SSO.");
  v.domains = [...new Set(domains)];
  v.enabled = input.enabled === undefined ? !!existing.enabled : input.enabled === true;
  v.enforce = input.enforce === undefined ? !!existing.enforce : input.enforce === true;
  v.requireVerifiedEmail = input.requireVerifiedEmail === undefined ? existing.requireVerifiedEmail !== false : input.requireVerifiedEmail !== false;
  if (v.enabled && (!v.issuer || !v.clientId || !v.domains.length)) errors.push("To switch SSO on, enter the issuer, the client ID and at least one email domain.");
  if (v.enforce && !v.enabled) errors.push("SSO must be on before it can be required.");
  return { value: v, errors };
}

/** Saves settings. Switching on (or requiring) SSO first checks the provider answers, so a wrong issuer cannot lock people out. */
export async function setWorkforceSso({ orgId, membership, actorEmail, input, probe = probeProvider }) {
  await gate(orgId, membership);
  const org = await loadOrg(orgId); const existing = org?.workforceSso || {};
  const { value, errors } = validateSsoInput(input, existing); if (errors.length) fail(400, errors.join(" "));
  const { orgs } = await getOrgCollections();
  if (value.domains.length) {
    const other = await orgs.findOne({ _id: { $ne: toObjectId(orgId) }, "workforceSso.enabled": true, "workforceSso.domains": { $in: value.domains } }, { projection: { _id: 1 } });
    if (other) fail(409, "One of these email domains is already used for SSO by another company.");
  }
  const $set = { ...Object.fromEntries(Object.entries(value).map(([k, x]) => [`workforceSso.${k}`, x])), "workforceSso.updatedAt": nowIso(), "workforceSso.updatedBy": actorEmail };
  if (typeof input.clientSecret === "string" && input.clientSecret.trim()) {
    if (!isIntegrationCryptoConfigured()) fail(503, "Secret storage is not configured on this server.");
    $set["workforceSso.clientSecretEncrypted"] = encryptIntegrationSecret(input.clientSecret.trim().slice(0, 500));
  }
  if (value.enabled && !$set["workforceSso.clientSecretEncrypted"] && !existing.clientSecretEncrypted) fail(400, "Enter the client secret from your identity provider.");
  if (value.enabled && (!existing.enabled || value.issuer !== existing.issuer)) { try { await probe(value.issuer); } catch (err) { fail(502, `The identity provider could not be reached: ${err.message}`); } }
  await orgs.updateOne({ _id: toObjectId(orgId) }, { $set });
  await logOrgActivity({ orgId, recordType: "SSO", recordId: toObjectId(orgId), actorEmail, action: "SSO_SETTINGS_UPDATED", previousState: null, newState: null, metadata: { enabled: value.enabled, enforce: value.enforce, domains: value.domains } }).catch(() => {});
  return view((await loadOrg(orgId))?.workforceSso);
}

async function probeProvider(issuer) { const doc = await discover(issuer); return { issuer: doc.issuer, authorizationEndpoint: doc.authorization_endpoint }; }

export async function testWorkforceSso({ orgId, membership }) {
  await gate(orgId, membership); const c = (await loadOrg(orgId))?.workforceSso;
  if (!c?.issuer || !c?.clientId) fail(400, "Enter the issuer and client ID first.");
  try { const p = await probeProvider(c.issuer); return { ok: true, ...p, clientSecretSet: !!c.clientSecretEncrypted, redirectUri: workforceRedirectUri(), note: "Register this exact redirect URI with your identity provider as a web application." }; }
  catch (err) { fail(502, `The identity provider could not be reached: ${err.message}`); }
}

/** The company whose SSO covers this email, or null. Only Enterprise (or grandfathered/legacy) companies with SSO switched on. */
export async function ssoOrgForEmail(email) {
  const e = normalizeEmail(email); if (!isValidEmail(e)) return null;
  const domain = e.split("@")[1];
  const { orgs } = await getOrgCollections();
  const org = await orgs.findOne({ "workforceSso.enabled": true, "workforceSso.domains": domain }, { projection: { name: 1, workforceSso: 1, ...PLAN_GATE_PROJECTION } });
  if (!org || !planAllows(org, "sso")) return null;
  return org;
}

/** For the email-link and Google sign-in routes: a refusal message when this email's company requires SSO, else null. */
export async function ssoRequiredFor(email) {
  try { const org = await ssoOrgForEmail(email); return org?.workforceSso?.enforce ? `${org.name} requires single sign-on. Use "Sign in with company SSO".` : null; }
  catch { return null; }
}

async function pending() { const { db } = await connectToDatabase(); return db.collection("mfa_pending"); }

/** Starts a login for this email. Returns { url } to send the browser to. */
export async function startWorkforceSso({ email, returnTo = "/business" }) {
  const org = await ssoOrgForEmail(email);
  if (!org) fail(404, "Single sign-on is not set up for this email address. Use another sign-in method.");
  const c = org.workforceSso; if (!c.clientSecretEncrypted) fail(503, "Single sign-on is not fully configured for this company.");
  let doc; try { doc = await discover(c.issuer); } catch (err) { fail(502, `Your company's identity provider could not be reached: ${err.message}`); }
  const state = generateToken(); const nonce = generateToken(); const verifier = generateToken() + generateToken();
  await (await pending()).insertOne({ tokenHash: hashToken(state), purpose: "workforce-sso", orgId: org._id, email: normalizeEmail(email), nonce, verifier, returnTo: String(returnTo).startsWith("/") && !String(returnTo).startsWith("//") ? String(returnTo).slice(0, 200) : "/business", usedAt: null, attempts: 0, expiresAt: new Date(Date.now() + STATE_TTL_MS).toISOString(), createdAt: nowIso() });
  const u = new URL(doc.authorization_endpoint);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: c.clientId, redirect_uri: workforceRedirectUri(), scope: "openid email profile", state, nonce, login_hint: normalizeEmail(email), code_challenge: b64u(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256" })) u.searchParams.set(k, v);
  return { url: u.toString() };
}

/** Finishes a login. Returns { email, orgId, returnTo } of a verified, eligible person. `exchange` is injectable for tests. */
export async function finishWorkforceSso({ code, state, exchange = exchangeCode }) {
  if (typeof code !== "string" || typeof state !== "string" || code.length > 4000 || state.length > 200) fail(400, "The sign-in response was not valid.");
  const st = await (await pending()).findOneAndUpdate({ tokenHash: hashToken(state), purpose: "workforce-sso", usedAt: null }, { $set: { usedAt: nowIso() } });
  if (!st || new Date(st.expiresAt).getTime() < Date.now()) fail(400, "This sign-in attempt expired or was already used. Please start again.");
  const org = await loadOrg(st.orgId); const c = org?.workforceSso;
  if (!c?.enabled || !planAllows(org, "sso")) fail(403, "Single sign-on is no longer switched on for this company.");
  let claims;
  try { claims = await exchange({ config: c, code, verifier: st.verifier, nonce: st.nonce }); }
  catch (err) {
    await logOrgActivity({ orgId: st.orgId, recordType: "SSO", recordId: st.orgId, actorEmail: st.email, action: "SSO_REJECTED", previousState: null, newState: null, metadata: { reason: String(err.message).slice(0, 160) } }).catch(() => {});
    fail(401, "We could not verify your sign-in with your company's identity provider. Please try again.");
  }
  const email = normalizeEmail(claims.email);
  if (!isValidEmail(email)) fail(403, "Your identity provider did not share an email address.");
  if (c.requireVerifiedEmail !== false && claims.email_verified !== undefined && claims.email_verified !== true && claims.email_verified !== "true") fail(403, "Your identity provider has not verified this email address.");
  if (!c.domains.includes(email.split("@")[1])) fail(403, "This email domain is not covered by your company's single sign-on.");
  const { orgMembers } = await getOrgCollections();
  const m = await orgMembers.findOne({ orgId: st.orgId, email, status: { $in: ["active", "invited", "pending"] } });
  if (!m) fail(403, `You are not a member of ${org.name} yet. Ask an administrator to invite you.`);
  if (m.status !== "active") await orgMembers.updateOne({ _id: m._id }, { $set: { status: "active", joinedAt: nowIso(), joinedVia: "sso" } });
  await logOrgActivity({ orgId: st.orgId, recordType: "SSO", recordId: st.orgId, actorEmail: email, action: "SSO_SIGN_IN", previousState: null, newState: null, metadata: {} }).catch(() => {});
  return { email, orgId: String(st.orgId), returnTo: st.returnTo || "/business" };
}

async function exchangeCode({ config, code, verifier, nonce }) {
  const doc = await discover(config.issuer); assertWebhookUrl(doc.token_endpoint);
  const res = await fetch(doc.token_endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000), headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: workforceRedirectUri(), client_id: config.clientId, client_secret: decryptIntegrationSecret(config.clientSecretEncrypted), code_verifier: verifier }) });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.id_token) throw new Error("The identity provider did not accept the sign-in.");
  return verifyIdToken(tok.id_token, { issuer: config.issuer, clientId: config.clientId, nonce, jwksUri: doc.jwks_uri });
}
