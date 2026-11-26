// src/lib/passkeys.js
//
// Passkey sign-in for Inaya Business OS (WebAuthn: Face ID, Touch ID, Windows Hello, Android, security keys). Included in
// every package ("Passkey Authentication" on the pricing card).
//
// * Identity-scoped like MFA (mfa.js): passkeys hang off the person's `member_mfa` document (`passkeys` array), so one passkey
//   signs a person into every company they belong to. No new collection; in-flight ceremonies use `mfa_pending`
//   (`purpose: "passkey-register" | "passkey-login"`, hashed single-use token, 5 minutes).
// * A passkey is registered while signed in (Settings > Security) and used later from the sign-in screen without typing an
//   email (discoverable credential).
// * User verification is REQUIRED (biometric or device PIN), so a passkey sign-in is two factors in one step (something you
//   have + something you are/know). It therefore completes sign-in without the authenticator-app/SMS step.
// * A passkey belongs to one site: inayanetwork.com (www and apex share it), localhost in development, or a company's verified
//   custom domain. Requests from any other origin are refused.
// * The signature counter is checked and stored; a counter that goes backwards (a cloned authenticator) is refused.

import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from "@simplewebauthn/server";
import { connectToDatabase } from "./mongodb.js";
import { hashToken, generateToken, normalizeEmail } from "./orgs.js";

const TTL_MS = 5 * 60 * 1000;
const MAX_PASSKEYS = 10;
const RP_NAME = "Inaya Business OS";

export class PasskeyError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new PasskeyError(status, message); };

async function cols() {
  const { db } = await connectToDatabase();
  return { memberMfa: db.collection("member_mfa"), mfaPending: db.collection("mfa_pending") };
}

/** Which site (RP ID) and exact origin a request belongs to, or a 400. `isWorkspaceHost` is injectable for tests. */
export async function relyingPartyFor(origin, { isWorkspaceHost } = {}) {
  let u; try { u = new URL(String(origin || "")); } catch { fail(400, "Passkeys need a browser request with an origin."); }
  const host = u.hostname.toLowerCase();
  if (host === "localhost" && process.env.NODE_ENV !== "production") return { rpID: "localhost", origin: u.origin };
  if (u.protocol !== "https:") fail(400, "Passkeys work only over HTTPS.");
  if (host === "inayanetwork.com" || host.endsWith(".inayanetwork.com")) return { rpID: "inayanetwork.com", origin: u.origin };
  const check = isWorkspaceHost || (async (h) => { const { workspaceForHost } = await import("./branding/branding.js"); return !!(await workspaceForHost(h)); });
  if (await check(host)) return { rpID: host, origin: u.origin };
  fail(400, "Passkeys are not available on this address.");
}

async function storeChallenge(purpose, email, challenge, rp) {
  const { mfaPending } = await cols(); const token = generateToken();
  await mfaPending.insertOne({ tokenHash: hashToken(token), purpose, email: email || null, challenge, rpID: rp.rpID, origin: rp.origin, attempts: 0, usedAt: null, expiresAt: new Date(Date.now() + TTL_MS).toISOString(), createdAt: new Date().toISOString() });
  return token;
}
async function takeChallenge(purpose, token) {
  const { mfaPending } = await cols();
  const row = await mfaPending.findOneAndUpdate({ tokenHash: hashToken(String(token || "")), purpose, usedAt: null }, { $set: { usedAt: new Date().toISOString() } });
  if (!row) fail(400, "This passkey request is no longer valid. Please try again.");
  if (new Date(row.expiresAt).getTime() < Date.now()) fail(400, "This passkey request expired. Please try again.");
  return row;
}

const publicView = (p) => ({ id: p.credentialId, name: p.name, rpID: p.rpID, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt || null, deviceType: p.deviceType || null, backedUp: !!p.backedUp });

export async function listPasskeys(email) {
  const { memberMfa } = await cols(); const doc = await memberMfa.findOne({ _id: normalizeEmail(email) }, { projection: { passkeys: 1 } });
  return (doc?.passkeys || []).map(publicView);
}

/** Step 1 of adding a passkey (signed in). Returns { options, requestToken }. */
export async function startRegistration({ email, origin, rpOverride }) {
  const e = normalizeEmail(email); const rp = rpOverride || (await relyingPartyFor(origin));
  const { memberMfa } = await cols(); const doc = await memberMfa.findOne({ _id: e }, { projection: { passkeys: 1 } });
  const existing = (doc?.passkeys || []).filter((p) => p.rpID === rp.rpID);
  if ((doc?.passkeys || []).length >= MAX_PASSKEYS) fail(400, `You can register up to ${MAX_PASSKEYS} passkeys. Remove one first.`);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME, rpID: rp.rpID, userName: e, userDisplayName: e, userID: new TextEncoder().encode(hashToken(e).slice(0, 32)),
    attestationType: "none", excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  return { options, requestToken: await storeChallenge("passkey-register", e, options.challenge, rp) };
}

/** Step 2 of adding a passkey. `verify` is injectable for tests. */
export async function finishRegistration({ email, requestToken, response, name, verify = verifyRegistrationResponse }) {
  const e = normalizeEmail(email); const row = await takeChallenge("passkey-register", requestToken);
  if (row.email !== e) fail(400, "This passkey request belongs to a different account.");
  let v; try { v = await verify({ response, expectedChallenge: row.challenge, expectedOrigin: row.origin, expectedRPID: row.rpID, requireUserVerification: true }); } catch (err) { fail(400, `The passkey could not be verified (${String(err?.message || "").slice(0, 120)}).`); }
  if (!v?.verified || !v.registrationInfo) fail(400, "The passkey could not be verified.");
  const { credential, credentialDeviceType, credentialBackedUp } = v.registrationInfo;
  const { memberMfa } = await cols();
  const clash = await memberMfa.findOne({ "passkeys.credentialId": credential.id }, { projection: { _id: 1 } });
  if (clash) fail(409, "This passkey is already registered.");
  const entry = { credentialId: credential.id, publicKey: Buffer.from(credential.publicKey).toString("base64url"), counter: credential.counter || 0, transports: response?.response?.transports || credential.transports || [], rpID: row.rpID, name: String(name || "").trim().slice(0, 60) || "Passkey", deviceType: credentialDeviceType || null, backedUp: !!credentialBackedUp, createdAt: new Date().toISOString(), lastUsedAt: null };
  await memberMfa.updateOne({ _id: e }, { $push: { passkeys: entry }, $setOnInsert: { createdAt: new Date().toISOString() } }, { upsert: true });
  return publicView(entry);
}

export async function removePasskey({ email, id }) {
  const { memberMfa } = await cols(); const r = await memberMfa.updateOne({ _id: normalizeEmail(email) }, { $pull: { passkeys: { credentialId: String(id || "") } } });
  if (!r.modifiedCount) fail(404, "Passkey not found.");
  return { ok: true };
}

/** Step 1 of signing in with a passkey (no email needed). Returns { options, requestToken }. */
export async function startLogin({ origin, rpOverride }) {
  const rp = rpOverride || (await relyingPartyFor(origin));
  const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: "required", allowCredentials: [] });
  return { options, requestToken: await storeChallenge("passkey-login", null, options.challenge, rp) };
}

/** Step 2 of signing in. Returns { email } of the verified person. `verify` is injectable for tests. */
export async function finishLogin({ requestToken, response, verify = verifyAuthenticationResponse }) {
  const row = await takeChallenge("passkey-login", requestToken);
  const id = String(response?.id || ""); if (!id) fail(400, "No passkey was returned.");
  const { memberMfa } = await cols();
  const doc = await memberMfa.findOne({ "passkeys.credentialId": id }, { projection: { passkeys: 1 } });
  const pk = doc?.passkeys?.find((p) => p.credentialId === id);
  if (!pk || pk.rpID !== row.rpID) fail(401, "This passkey is not registered with Inaya on this address. Sign in another way and add it in Settings > Security.");
  let v; try {
    v = await verify({ response, expectedChallenge: row.challenge, expectedOrigin: row.origin, expectedRPID: row.rpID, requireUserVerification: true, credential: { id: pk.credentialId, publicKey: new Uint8Array(Buffer.from(pk.publicKey, "base64url")), counter: pk.counter || 0, transports: pk.transports } });
  } catch (err) { fail(401, `The passkey could not be verified (${String(err?.message || "").slice(0, 120)}).`); }
  if (!v?.verified) fail(401, "The passkey could not be verified.");
  const newCounter = v.authenticationInfo?.newCounter ?? 0;
  await memberMfa.updateOne({ _id: doc._id, "passkeys.credentialId": id }, { $set: { "passkeys.$.counter": newCounter, "passkeys.$.lastUsedAt": new Date().toISOString() } });
  return { email: doc._id };
}
