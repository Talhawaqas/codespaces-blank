// src/lib/support/sso.js
//
// Customer single sign-on for the portal: OpenID Connect authorization-code flow with PKCE, for any standards-compliant
// identity provider (Google Workspace, Microsoft Entra ID, Okta, Auth0, Keycloak...). Configured per organization by an
// administrator: issuer, client id, client secret (stored encrypted, never returned), optional email-domain allow-list.
//
// What is enforced, in this order:
//   * the login attempt is bound to THIS browser and organization by a random single-use `state` (stored hashed, 10 min);
//   * PKCE (S256) and a `nonce` tie the code and the ID token to that attempt;
//   * the ID token signature is verified against the provider's published keys (RS256 or ES256 only; "none" and shared-secret
//     algorithms are refused), and issuer, audience, expiry and nonce are checked;
//   * the email must be present and verified by the provider (unless the administrator relaxes that for a provider that
//     does not send the claim) and, when a domain list is set, belong to an allowed domain;
//   * the person must then be eligible exactly as for an email link: a CRM contact of this organization, or anyone when the
//     organization opted into open sign-up. SSO proves WHO someone is; it never grants access by itself.
// Provider calls use https only (loopback http only in automated tests), no redirects, short timeouts.

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { toObjectId } from "../orgs.js";
import { getSupportCollections } from "./db.js";
import { fail, nowIso, sha256, newToken, normEmail, isEmail } from "./common.js";
import { getSsoClientSecret } from "./settings.js";
import { establishSession } from "./portalAuth.js";
import { assertWebhookUrl } from "./webhooks.js";
import { audit } from "./record.js";
import { APP_URL } from "./notify.js";

const STATE_TTL_MS = 10 * 60 * 1000;
const b64u = (buf) => Buffer.from(buf).toString("base64url");

export const redirectUriFor = (slug) => `${APP_URL()}/api/portal/${slug}/sso/callback`;

async function getJson(url, init = {}) {
  assertWebhookUrl(url); // https only, no private/loopback/metadata hosts (loopback http only in test mode)
  const res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10000), headers: { Accept: "application/json", ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`The identity provider answered ${res.status}.`);
  const text = await res.text();
  if (text.length > 512 * 1024) throw new Error("The identity provider's answer was too large.");
  return JSON.parse(text);
}

const discoveryCache = new Map(); const jwksCache = new Map();
async function discover(issuer) {
  const hit = discoveryCache.get(issuer); if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.doc;
  const doc = await getJson(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  if (String(doc.issuer || "").replace(/\/$/, "") !== issuer.replace(/\/$/, "")) throw new Error("The provider's issuer does not match the configured issuer.");
  for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) { if (!doc[k]) throw new Error(`The provider's configuration has no ${k}.`); assertWebhookUrl(doc[k]); }
  discoveryCache.set(issuer, { at: Date.now(), doc });
  return doc;
}
async function jwks(uri, force = false) {
  const hit = jwksCache.get(uri); if (!force && hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.keys;
  const j = await getJson(uri); const keys = Array.isArray(j.keys) ? j.keys : [];
  jwksCache.set(uri, { at: Date.now(), keys }); return keys;
}
export const __resetSsoCaches = () => { discoveryCache.clear(); jwksCache.clear(); };

/** Verifies an ID token. Returns the claims or throws with a short reason. */
export async function verifyIdToken(idToken, { issuer, clientId, nonce, jwksUri, now = Date.now() }) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw new Error("The ID token is malformed.");
  let header; let claims;
  try { header = JSON.parse(Buffer.from(parts[0], "base64url").toString()); claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()); } catch { throw new Error("The ID token is malformed."); }
  if (!["RS256", "ES256"].includes(header.alg)) throw new Error("The ID token uses an algorithm that is not accepted.");
  let keys = await jwks(jwksUri);
  let jwk = keys.find((k) => k.kid === header.kid && (!k.use || k.use === "sig"));
  if (!jwk) { keys = await jwks(jwksUri, true); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk && !header.kid && keys.length === 1) jwk = keys[0];
  if (!jwk) throw new Error("The ID token was signed with an unknown key.");
  if ((header.alg === "RS256" && jwk.kty !== "RSA") || (header.alg === "ES256" && jwk.kty !== "EC")) throw new Error("The signing key does not match the algorithm.");
  const key = createPublicKey({ key: jwk, format: "jwk" });
  const data = Buffer.from(`${parts[0]}.${parts[1]}`); const sig = Buffer.from(parts[2], "base64url");
  const ok = header.alg === "RS256" ? cryptoVerify("RSA-SHA256", data, key, sig) : cryptoVerify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, sig);
  if (!ok) throw new Error("The ID token signature is not valid.");
  if (String(claims.iss || "").replace(/\/$/, "") !== issuer.replace(/\/$/, "")) throw new Error("The ID token was issued by a different provider.");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw new Error("The ID token was issued for a different application.");
  if (aud.length > 1 && claims.azp !== clientId) throw new Error("The ID token authorized party is not this application.");
  const skew = 60;
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 < now - skew * 1000) throw new Error("The ID token has expired.");
  if (Number.isFinite(claims.nbf) && claims.nbf * 1000 > now + skew * 1000) throw new Error("The ID token is not valid yet.");
  if (!nonce || claims.nonce !== nonce) throw new Error("The ID token does not belong to this sign-in attempt.");
  return claims;
}

/** Starts a login: returns { url } to send the browser to. */
export async function startSso({ orgId, settings, slug }) {
  const so = settings.sso;
  if (!so?.enabled) return fail("Single sign-on is not enabled for this portal.", 404);
  if (!(await getSsoClientSecret(orgId))) return fail("Single sign-on is not fully configured.", 503);
  let doc; try { doc = await discover(so.issuer); } catch (err) { return fail(`The identity provider could not be reached: ${err.message}`, 502); }
  const state = newToken(24); const nonce = newToken(24); const verifier = newToken(48);
  const { supportSsoStates } = await getSupportCollections();
  await supportSsoStates.insertOne({ orgId: toObjectId(orgId), stateHash: sha256(state), nonce, verifier, createdAt: nowIso(), expiresAt: new Date(Date.now() + STATE_TTL_MS) });
  const u = new URL(doc.authorization_endpoint);
  u.searchParams.set("response_type", "code"); u.searchParams.set("client_id", so.clientId); u.searchParams.set("redirect_uri", redirectUriFor(slug));
  u.searchParams.set("scope", "openid email profile"); u.searchParams.set("state", state); u.searchParams.set("nonce", nonce);
  u.searchParams.set("code_challenge", b64u(createHash("sha256").update(verifier).digest())); u.searchParams.set("code_challenge_method", "S256");
  return { url: u.toString() };
}

/** Finishes a login. Returns { sessionToken, user, maxAgeSeconds } or { error } (safe to show). */
export async function finishSso({ orgId, settings, slug, code, state }) {
  const so = settings.sso;
  if (!so?.enabled) return fail("Single sign-on is not enabled for this portal.", 404);
  if (typeof code !== "string" || typeof state !== "string" || code.length > 2000 || state.length > 200) return fail("The sign-in response was not valid.", 400);
  const { supportSsoStates } = await getSupportCollections();
  const st = await supportSsoStates.findOneAndDelete({ orgId: toObjectId(orgId), stateHash: sha256(state), expiresAt: { $gt: new Date() } }); // single use, this org only
  if (!st) return fail("This sign-in attempt expired or was already used. Please start again.", 400);
  const secret = await getSsoClientSecret(orgId);
  if (!secret) return fail("Single sign-on is not fully configured.", 503);
  let claims;
  try {
    const doc = await discover(so.issuer);
    assertWebhookUrl(doc.token_endpoint);
    const res = await fetch(doc.token_endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000), headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUriFor(slug), client_id: so.clientId, client_secret: secret, code_verifier: st.verifier }).toString() });
    const tok = await res.json().catch(() => ({}));
    if (!res.ok || !tok.id_token) throw new Error("The identity provider did not accept the sign-in.");
    claims = await verifyIdToken(tok.id_token, { issuer: so.issuer, clientId: so.clientId, nonce: st.nonce, jwksUri: doc.jwks_uri });
  } catch (err) {
    await audit({ orgId, action: "PORTAL_SSO_REJECTED", actorEmail: "unknown", metadata: { reason: String(err.message).slice(0, 160) } });
    return fail("We could not verify your sign-in. Please try again.", 401, { reasonCode: "SSO_VERIFICATION_FAILED" });
  }
  const email = normEmail(claims.email);
  if (!isEmail(email)) return fail("Your account did not share an email address, so we cannot match it.", 403);
  if (so.requireVerifiedEmail !== false && claims.email_verified !== true && claims.email_verified !== "true") { await audit({ orgId, action: "PORTAL_SSO_REJECTED", actorEmail: email, metadata: { reason: "email not verified by the provider" } }); return fail("Your identity provider has not verified this email address.", 403); }
  const domain = email.split("@")[1];
  if (so.allowedDomains?.length && !so.allowedDomains.map((d) => d.toLowerCase()).includes(domain)) { await audit({ orgId, action: "PORTAL_SSO_REJECTED", actorEmail: email, metadata: { reason: "domain not allowed" } }); return fail("This email domain is not allowed to use this portal.", 403); }
  const s = await establishSession({ orgId, settings, email, via: "sso" });
  if (s.error) return { ...s, error: "This account is not set up for this support portal. Contact the company that gave you the link." };
  return s;
}

/** Administrator check: can the provider be reached and is it configured sensibly? */
export async function testSso({ orgId, settings, slug }) {
  const so = settings.sso;
  if (!so?.issuer || !so?.clientId) return fail("Enter the issuer and client id first.");
  try {
    const doc = await discover(so.issuer);
    const keys = await jwks(doc.jwks_uri, true);
    return { ok: true, issuer: doc.issuer, authorizationEndpoint: doc.authorization_endpoint, keys: keys.length, clientSecretSet: !!(await getSsoClientSecret(orgId)), redirectUri: redirectUriFor(slug), note: `Register this exact redirect URI with your identity provider: ${redirectUriFor(slug)}` };
  } catch (err) { return fail(`The identity provider could not be reached: ${err.message}`, 502); }
}
