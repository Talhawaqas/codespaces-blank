// src/lib/workforceSso.js
//
// Staff single sign-on (SSO) into Inaya Business OS: Enterprise package ("SSO & Advanced Admin Controls"). Two protocols,
// chosen per company:
//   * OpenID Connect: authorization-code flow with PKCE (Microsoft Entra ID, Google Workspace, Okta, Auth0, Keycloak...). The
//     ID-token checks are the customer-portal SSO's (support/sso.js: RS256/ES256 only, provider keys, issuer, audience,
//     expiry, nonce), reused rather than duplicated.
//   * SAML 2.0: SP-initiated, HTTP-Redirect AuthnRequest and HTTP-POST response, validated by @node-saml/node-saml (signature
//     against the company's IdP certificate, audience, destination, time window, InResponseTo of a request we issued).
//
// Configuration lives on the organization document (`workforceSso`), no new collection:
//   { enabled, protocol: "oidc"|"saml", issuer, clientId, clientSecretEncrypted, samlEntryPoint, samlIdpIssuer, samlIdpCert,
//     domains: ["example.com"], enforce, requireVerifiedEmail, updatedAt, updatedBy }
// * `domains`: the email domains this company signs in with. A domain can belong to only one company's SSO.
// * `enforce`: when on, people with those email domains can no longer sign in with an email link or Google; they must use SSO
//   (passkeys still work: they are registered only after a signed-in session).
// * SSO proves who someone is. It never creates access by itself: the person must already be an active member of the
//   company, or hold a pending invitation to it (which SSO then accepts, exactly as an email link would).
// * The sign-in comes back to the address it started from (www.inayanetwork.com, inayanetwork.com, or the company's verified
//   custom domain), so the session cookie is set where the person is, including inside the desktop app.
//
// In-flight logins use `mfa_pending` (`purpose: "workforce-sso"`, hashed single-use state, 10 minutes; SAML request ids as
// `purpose: "saml-request"`).

import { createHash, X509Certificate } from "node:crypto";
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
const PUBLIC_DOMAINS = ["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "live.com", "msn.com", "proton.me", "aol.com"];

export class SsoError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new SsoError(status, message); };

export const appUrl = () => (process.env.NEXT_PUBLIC_APP_URL || "https://www.inayanetwork.com").replace(/\/$/, "");
export const OIDC_CALLBACK_PATH = "/api/orgs/login/sso/callback";
export const SAML_ACS_PATH = "/api/orgs/login/saml/acs";
export const workforceRedirectUri = (base = appUrl()) => `${base}${OIDC_CALLBACK_PATH}`;
/** The SAML service-provider entity id: one stable value per company, whatever address the sign-in starts from. */
export const samlSpEntityId = (orgId) => `https://www.inayanetwork.com/saml/${orgId}`;
const OWN_ORIGINS = ["https://www.inayanetwork.com", "https://inayanetwork.com"];

/** The address a sign-in may come back to: Inaya's own addresses, a verified company domain, or (outside production) localhost. */
export async function allowedOrigin(origin, { isWorkspaceHost } = {}) {
  let u; try { u = new URL(String(origin || "")); } catch { return appUrl(); }
  if (OWN_ORIGINS.includes(u.origin)) return u.origin;
  if (u.hostname === "localhost" && process.env.NODE_ENV !== "production") return u.origin;
  if (u.protocol === "https:") {
    const check = isWorkspaceHost || (async (h) => { const { workspaceForHost } = await import("./branding/branding.js"); return !!(await workspaceForHost(h)); });
    if (await check(u.hostname)) return u.origin;
  }
  return appUrl();
}

function certSummary(pem) {
  try { const c = new X509Certificate(pemOf(pem)); return { subject: c.subject.replace(/\n/g, ", ").slice(0, 160), validTo: new Date(c.validTo).toISOString(), fingerprint256: c.fingerprint256 }; } catch { return null; }
}
/** Accepts a PEM or a bare base64 certificate (as Entra and Okta download it); returns a PEM. */
export function pemOf(input) {
  const raw = String(input || "").replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
  return `-----BEGIN CERTIFICATE-----\n${raw.match(/.{1,64}/g)?.join("\n") || ""}\n-----END CERTIFICATE-----\n`;
}

const view = (c, orgId) => ({
  enabled: !!c?.enabled, protocol: c?.protocol === "saml" ? "saml" : "oidc",
  issuer: c?.issuer || "", clientId: c?.clientId || "", clientSecretSet: !!c?.clientSecretEncrypted,
  samlEntryPoint: c?.samlEntryPoint || "", samlIdpIssuer: c?.samlIdpIssuer || "", samlCert: c?.samlIdpCert ? certSummary(c.samlIdpCert) : null,
  domains: c?.domains || [], enforce: !!c?.enforce, requireVerifiedEmail: c?.requireVerifiedEmail !== false, updatedAt: c?.updatedAt || null,
  redirectUris: OWN_ORIGINS.map((o) => workforceRedirectUri(o)), redirectUri: workforceRedirectUri(),
  saml: { spEntityId: samlSpEntityId(orgId), acsUrls: OWN_ORIGINS.map((o) => `${o}${SAML_ACS_PATH}`), metadataUrl: `${appUrl()}/api/orgs/login/saml/metadata?orgId=${orgId}` },
});

async function loadOrg(orgId) {
  const { orgs } = await getOrgCollections();
  return orgs.findOne({ _id: toObjectId(orgId) }, { projection: { name: 1, workforceSso: 1, ...PLAN_GATE_PROJECTION } });
}
async function gate(orgId, membership) {
  if (!canManageOrg(membership)) fail(403, "Only an owner or admin can manage single sign-on.");
  const g = await requirePlanFeature(orgId, "sso"); if (g) fail(403, g.error);
}

export async function getWorkforceSso({ orgId, membership }) { await gate(orgId, membership); return view((await loadOrg(orgId))?.workforceSso, orgId); }

/** Pure validation of the editable fields. Returns { value, errors }. */
export function validateSsoInput(input = {}, existing = {}) {
  const errors = []; const v = {};
  v.protocol = (input.protocol ?? existing.protocol) === "saml" ? "saml" : "oidc";
  const https = (s, label) => { if (!s) return; try { const u = new URL(s); if (u.protocol !== "https:") errors.push(`${label} must start with https://.`); } catch { errors.push(`${label} must be a web address.`); } };
  v.issuer = String(input.issuer ?? existing.issuer ?? "").trim().replace(/\/$/, ""); https(v.issuer, "The issuer");
  v.clientId = String(input.clientId ?? existing.clientId ?? "").trim().slice(0, 300);
  v.samlEntryPoint = String(input.samlEntryPoint ?? existing.samlEntryPoint ?? "").trim().slice(0, 500); https(v.samlEntryPoint, "The SAML sign-in URL");
  v.samlIdpIssuer = String(input.samlIdpIssuer ?? existing.samlIdpIssuer ?? "").trim().slice(0, 300);
  if (typeof input.samlIdpCert === "string" && input.samlIdpCert.trim()) {
    const pem = pemOf(input.samlIdpCert);
    if (!certSummary(pem)) errors.push("The SAML certificate could not be read. Paste the Base64 certificate from your identity provider.");
    else v.samlIdpCert = pem;
  }
  const domains = (Array.isArray(input.domains) ? input.domains : existing.domains || []).map((d) => String(d).trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
  if (domains.length > 20) errors.push("Up to 20 email domains."); if (domains.some((d) => !DOMAIN.test(d))) errors.push("Each domain must look like example.com.");
  if (domains.some((d) => PUBLIC_DOMAINS.includes(d))) errors.push("Public email domains (such as gmail.com) cannot be claimed for SSO.");
  v.domains = [...new Set(domains)];
  v.enabled = input.enabled === undefined ? !!existing.enabled : input.enabled === true;
  v.enforce = input.enforce === undefined ? !!existing.enforce : input.enforce === true;
  v.requireVerifiedEmail = input.requireVerifiedEmail === undefined ? existing.requireVerifiedEmail !== false : input.requireVerifiedEmail !== false;
  if (v.enabled && v.protocol === "oidc" && (!v.issuer || !v.clientId || !v.domains.length)) errors.push("To switch SSO on, enter the issuer, the client ID and at least one email domain.");
  if (v.enabled && v.protocol === "saml" && (!v.samlEntryPoint || !(v.samlIdpCert || existing.samlIdpCert) || !v.domains.length)) errors.push("To switch SAML SSO on, enter the SAML sign-in URL, the identity provider's certificate and at least one email domain.");
  if (v.enforce && !v.enabled) errors.push("SSO must be on before it can be required.");
  return { value: v, errors };
}

/** Saves settings. Switching OpenID Connect on first checks the provider answers, so a wrong issuer cannot lock people out. */
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
  if (value.enabled && value.protocol === "oidc") {
    if (!$set["workforceSso.clientSecretEncrypted"] && !existing.clientSecretEncrypted) fail(400, "Enter the client secret from your identity provider.");
    if (!existing.enabled || existing.protocol === "saml" || value.issuer !== existing.issuer) { try { await probe(value.issuer); } catch (err) { fail(502, `The identity provider could not be reached: ${err.message}`); } }
  }
  await orgs.updateOne({ _id: toObjectId(orgId) }, { $set });
  await logOrgActivity({ orgId, recordType: "SSO", recordId: toObjectId(orgId), actorEmail, action: "SSO_SETTINGS_UPDATED", previousState: null, newState: null, metadata: { enabled: value.enabled, protocol: value.protocol, enforce: value.enforce, domains: value.domains } }).catch(() => {});
  return view((await loadOrg(orgId))?.workforceSso, orgId);
}

async function probeProvider(issuer) { const doc = await discover(issuer); return { issuer: doc.issuer, authorizationEndpoint: doc.authorization_endpoint }; }

export async function testWorkforceSso({ orgId, membership }) {
  await gate(orgId, membership); const c = (await loadOrg(orgId))?.workforceSso;
  if (c?.protocol === "saml") {
    if (!c.samlEntryPoint || !c.samlIdpCert) fail(400, "Enter the SAML sign-in URL and certificate first.");
    const cert = certSummary(c.samlIdpCert); if (!cert) fail(400, "The saved SAML certificate could not be read.");
    const expired = new Date(cert.validTo).getTime() < Date.now();
    return { ok: !expired, protocol: "saml", certificate: cert, spEntityId: samlSpEntityId(orgId), acsUrls: OWN_ORIGINS.map((o) => `${o}${SAML_ACS_PATH}`),
      note: expired ? "The identity provider's certificate has expired. Download the new one and save it here." : "In your identity provider, set the Identifier (Entity ID) and Reply URLs (ACS) shown here, and send the email address as the NameID or an email claim." };
  }
  if (!c?.issuer || !c?.clientId) fail(400, "Enter the issuer and client ID first.");
  try { const p = await probeProvider(c.issuer); return { ok: true, protocol: "oidc", ...p, clientSecretSet: !!c.clientSecretEncrypted, redirectUri: workforceRedirectUri(), redirectUris: OWN_ORIGINS.map((o) => workforceRedirectUri(o)), note: "Register both redirect URIs with your identity provider as a web application." }; }
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
const safeReturn = (r) => (String(r || "").startsWith("/") && !String(r).startsWith("//") ? String(r).slice(0, 300) : "/business");

/** SAML InResponseTo cache backed by mfa_pending (works across serverless instances). */
function samlCache(orgId) {
  return {
    async saveAsync(key, value) { await (await pending()).insertOne({ tokenHash: hashToken(`saml:${key}`), purpose: "saml-request", orgId, value, usedAt: null, expiresAt: new Date(Date.now() + STATE_TTL_MS).toISOString(), createdAt: nowIso() }); return { value, createdAt: Date.now() }; },
    async getAsync(key) { const r = await (await pending()).findOne({ tokenHash: hashToken(`saml:${key}`), purpose: "saml-request" }); return r && new Date(r.expiresAt).getTime() > Date.now() ? r.value : null; },
    async removeAsync(key) { const r = await (await pending()).findOneAndDelete({ tokenHash: hashToken(`saml:${key}`), purpose: "saml-request" }); return r ? key : null; },
  };
}
async function samlClient(org, base) {
  const { SAML, ValidateInResponseTo } = await import("@node-saml/node-saml");
  const c = org.workforceSso;
  return new SAML({
    entryPoint: c.samlEntryPoint, issuer: samlSpEntityId(String(org._id)), callbackUrl: `${base}${SAML_ACS_PATH}`, idpCert: c.samlIdpCert,
    ...(c.samlIdpIssuer ? { idpIssuer: c.samlIdpIssuer } : {}), audience: samlSpEntityId(String(org._id)),
    wantAssertionsSigned: true, wantAuthnResponseSigned: false, signatureAlgorithm: "sha256", acceptedClockSkewMs: 120000,
    validateInResponseTo: ValidateInResponseTo.always, requestIdExpirationPeriodMs: STATE_TTL_MS, cacheProvider: samlCache(org._id),
    identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress", disableRequestedAuthnContext: true,
  });
}

/** Starts a login for this email. Returns { url } to send the browser to. `origin` is where the sign-in started. */
export async function startWorkforceSso({ email, returnTo = "/business", origin = null }) {
  const org = await ssoOrgForEmail(email);
  if (!org) fail(404, "Single sign-on is not set up for this email address. Use another sign-in method.");
  const c = org.workforceSso; const base = await allowedOrigin(origin);
  const state = generateToken();
  const row = { tokenHash: hashToken(state), purpose: "workforce-sso", orgId: org._id, email: normalizeEmail(email), base, returnTo: safeReturn(returnTo), usedAt: null, attempts: 0, expiresAt: new Date(Date.now() + STATE_TTL_MS).toISOString(), createdAt: nowIso() };
  if (c.protocol === "saml") {
    if (!c.samlEntryPoint || !c.samlIdpCert) fail(503, "Single sign-on is not fully configured for this company.");
    await (await pending()).insertOne({ ...row, protocol: "saml" });
    const saml = await samlClient(org, base);
    return { url: await saml.getAuthorizeUrlAsync(state, undefined, {}) };
  }
  if (!c.clientSecretEncrypted) fail(503, "Single sign-on is not fully configured for this company.");
  let doc; try { doc = await discover(c.issuer); } catch (err) { fail(502, `Your company's identity provider could not be reached: ${err.message}`); }
  const nonce = generateToken(); const verifier = generateToken() + generateToken(); const redirectUri = workforceRedirectUri(base);
  await (await pending()).insertOne({ ...row, protocol: "oidc", nonce, verifier, redirectUri });
  const u = new URL(doc.authorization_endpoint);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: c.clientId, redirect_uri: redirectUri, scope: "openid email profile", state, nonce, login_hint: normalizeEmail(email), code_challenge: b64u(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256" })) u.searchParams.set(k, v);
  return { url: u.toString() };
}

async function takeState(state, protocol) {
  const st = await (await pending()).findOneAndUpdate({ tokenHash: hashToken(state), purpose: "workforce-sso", usedAt: null, ...(protocol === "saml" ? { protocol: "saml" } : { protocol: { $ne: "saml" } }) }, { $set: { usedAt: nowIso() } });
  if (!st || new Date(st.expiresAt).getTime() < Date.now()) fail(400, "This sign-in attempt expired or was already used. Please start again.");
  return st;
}

/** Same checks for both protocols, after the identity provider has been verified: domain, email, membership. */
async function admit({ org, st, email: rawEmail, emailVerified }) {
  const c = org.workforceSso;
  const email = normalizeEmail(rawEmail);
  if (!isValidEmail(email)) fail(403, "Your identity provider did not share an email address.");
  if (c.requireVerifiedEmail !== false && emailVerified !== undefined && emailVerified !== true && emailVerified !== "true") fail(403, "Your identity provider has not verified this email address.");
  if (!c.domains.includes(email.split("@")[1])) fail(403, "This email domain is not covered by your company's single sign-on.");
  const { orgMembers } = await getOrgCollections();
  const m = await orgMembers.findOne({ orgId: st.orgId, email, status: { $in: ["active", "invited", "pending"] } });
  if (!m) fail(403, `You are not a member of ${org.name} yet. Ask an administrator to invite you.`);
  if (m.status !== "active") await orgMembers.updateOne({ _id: m._id }, { $set: { status: "active", joinedAt: nowIso(), joinedVia: "sso" } });
  await logOrgActivity({ orgId: st.orgId, recordType: "SSO", recordId: st.orgId, actorEmail: email, action: "SSO_SIGN_IN", previousState: null, newState: null, metadata: { protocol: c.protocol === "saml" ? "saml" : "oidc" } }).catch(() => {});
  return { email, orgId: String(st.orgId), returnTo: st.returnTo || "/business", base: st.base || appUrl() };
}
async function rejected(st, err) {
  await logOrgActivity({ orgId: st.orgId, recordType: "SSO", recordId: st.orgId, actorEmail: st.email, action: "SSO_REJECTED", previousState: null, newState: null, metadata: { reason: String(err?.message || "").slice(0, 160) } }).catch(() => {});
}
async function activeOrg(st) {
  const org = await loadOrg(st.orgId);
  if (!org?.workforceSso?.enabled || !planAllows(org, "sso")) fail(403, "Single sign-on is no longer switched on for this company.");
  return org;
}

/** Finishes an OpenID Connect login. Returns { email, orgId, returnTo, base }. `exchange` is injectable for tests. */
export async function finishWorkforceSso({ code, state, exchange = exchangeCode }) {
  if (typeof code !== "string" || typeof state !== "string" || code.length > 4000 || state.length > 200) fail(400, "The sign-in response was not valid.");
  const st = await takeState(state, "oidc"); const org = await activeOrg(st);
  let claims;
  try { claims = await exchange({ config: org.workforceSso, code, verifier: st.verifier, nonce: st.nonce, redirectUri: st.redirectUri || workforceRedirectUri() }); }
  catch (err) { await rejected(st, err); fail(401, "We could not verify your sign-in with your company's identity provider. Please try again."); }
  return admit({ org, st, email: claims.email, emailVerified: claims.email_verified });
}

/** Finishes a SAML login (the POSTed SAMLResponse + RelayState). Returns { email, orgId, returnTo, base }. `validate` is injectable for tests. */
export async function finishWorkforceSaml({ samlResponse, relayState, validate = null }) {
  if (typeof samlResponse !== "string" || typeof relayState !== "string" || samlResponse.length > 400000 || relayState.length > 200) fail(400, "The sign-in response was not valid.");
  const st = await takeState(relayState, "saml"); const org = await activeOrg(st);
  if (org.workforceSso.protocol !== "saml") fail(403, "This company does not use SAML single sign-on.");
  let profile;
  try {
    const run = validate || (async (body) => (await (await samlClient(org, st.base || appUrl())).validatePostResponseAsync(body)).profile);
    profile = await run({ SAMLResponse: samlResponse, RelayState: relayState });
    if (!profile) throw new Error("no profile");
  } catch (err) { await rejected(st, err); fail(401, "We could not verify your sign-in with your company's identity provider. Please try again."); }
  const email = profile.email || profile.mail || profile["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"] || (isValidEmail(normalizeEmail(profile.nameID)) ? profile.nameID : null);
  return admit({ org, st, email, emailVerified: undefined });
}

/** SAML service-provider metadata XML for this company (public: entity id, ACS addresses, no secrets). */
export async function samlMetadata(orgId) {
  const org = await loadOrg(orgId); if (!org?.workforceSso || org.workforceSso.protocol !== "saml") return null;
  const { generateServiceProviderMetadata } = await import("@node-saml/node-saml");
  return generateServiceProviderMetadata({ issuer: samlSpEntityId(String(org._id)), callbackUrl: `https://www.inayanetwork.com${SAML_ACS_PATH}`, identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress", wantAssertionsSigned: true });
}

async function exchangeCode({ config, code, verifier, nonce, redirectUri }) {
  const doc = await discover(config.issuer); assertWebhookUrl(doc.token_endpoint);
  const res = await fetch(doc.token_endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000), headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: config.clientId, client_secret: decryptIntegrationSecret(config.clientSecretEncrypted), code_verifier: verifier }) });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.id_token) throw new Error("The identity provider did not accept the sign-in.");
  return verifyIdToken(tok.id_token, { issuer: config.issuer, clientId: config.clientId, nonce, jwksUri: doc.jwks_uri });
}
