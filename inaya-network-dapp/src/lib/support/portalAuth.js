// src/lib/support/portalAuth.js
//
// SOW §41, §42, §29.2: customer identity for the portal. A SEPARATE security domain from organization members:
//   - passwordless: a single-use magic link sent to a verified mailbox (no passwords to leak or reuse);
//   - a portal user is bound to exactly ONE organization and to a CRM contact of that organization (found by
//     email; created as a CRM lead only if the organization opted into open signup);
//   - the session cookie is valid only for the portal of the organization it was issued for; nothing about it is
//     accepted by any organization or agent route;
//   - the request-link endpoint answers identically whether or not the address is eligible, so it cannot be used
//     to discover who the organization's customers are;
//   - tokens are random, stored only as SHA-256 hashes, expire (15 min for links, 14 days for sessions), and a
//     link is consumed atomically (it can be used once).

import { toObjectId } from "../orgs.js";
import { sendEmail } from "../email.js";
import { checkRateLimit } from "../rateLimit.js";
import { getSupportCollections, ensureSupportIndexes } from "./db.js";
import { fail, nowIso, normEmail, isEmail, sha256, newToken } from "./common.js";
import { findContactByEmail, createLeadContact } from "./customers.js";
import { audit, emit } from "./record.js";
import { emailBody, portalUrl } from "./notify.js";

export const PORTAL_COOKIE = "inaya_portal_session";
const LINK_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 14 * 24 * 3600 * 1000;
export const GENERIC_LINK_MESSAGE = "If that address can use this portal, a sign-in link is on its way. It expires in 15 minutes.";

/** Always resolves to the same shape and the same message; only the side effect differs. */
export async function requestLogin({ orgId, settings, email, ip = "unknown", origin = null }) {
  await ensureSupportIndexes();
  const e = normEmail(email);
  const out = { ok: true, message: GENERIC_LINK_MESSAGE };
  if (!isEmail(e)) return out;
  try {
    await checkRateLimit({ action: `portal:login:ip:${orgId}`, key: ip, max: 30, windowMs: 60 * 60 * 1000 });
    await checkRateLimit({ action: `portal:login:email:${orgId}`, key: sha256(e), max: settings.rate.loginPerHour, windowMs: 60 * 60 * 1000 });
  } catch { return out; } // throttled: say nothing different
  const contact = await findContactByEmail(orgId, e);
  const { supportPortalUsers, supportPortalLoginTokens } = await getSupportCollections();
  const existing = await supportPortalUsers.findOne({ orgId: toObjectId(orgId), email: e });
  if (existing?.status === "BLOCKED") return out;
  if (!contact && settings.signup !== "open" && !existing) return out; // not a customer of this organization
  const token = newToken(32);
  await supportPortalLoginTokens.insertOne({ tokenHash: sha256(token), orgId: toObjectId(orgId), email: e, createdAt: nowIso(), expiresAt: new Date(Date.now() + LINK_TTL_MS), usedAt: null });
  const base = origin ? `${origin.replace(/\/$/, "")}/portal/${settings.portalSlug}` : portalUrl(settings);
  const url = `${base}?token=${encodeURIComponent(token)}`;
  const body = emailBody({ heading: "Your sign-in link", message: "Use this link to sign in to the support portal. It works once and expires in 15 minutes. If you did not ask for it, you can ignore this email.", linkUrl: url, linkLabel: "Sign in" });
  const sent = await sendEmail({ to: e, subject: `Your sign-in link${settings.portalName ? ` for ${settings.portalName}` : ""}`, html: body.html, text: body.text });
  if (process.env.SUPPORT_PORTAL_RETURN_LINK === "1" && process.env.NODE_ENV !== "production" && !process.env.VERCEL) out.devLink = url; // automated tests only
  await audit({ orgId, action: "PORTAL_LOGIN_LINK_SENT", actorEmail: e, metadata: { delivered: sent.sent === true } });
  return out;
}

/** Consumes a link (once) and opens a session. Returns { sessionToken, user } or { error }. */
export async function verifyLogin({ orgId, settings, token }) {
  const { supportPortalLoginTokens } = await getSupportCollections();
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return fail("This sign-in link is not valid or has expired.", 401);
  const t = await supportPortalLoginTokens.findOneAndUpdate({ tokenHash: sha256(token), orgId: toObjectId(orgId), usedAt: null, expiresAt: { $gt: new Date() } }, { $set: { usedAt: nowIso() } });
  if (!t) return fail("This sign-in link is not valid or has expired.", 401);
  return establishSession({ orgId, settings, email: t.email, via: "email_link" });
}

/**
 * Opens a portal session for an email address that has ALREADY been proven (by a single-use link or by a verified
 * identity-provider assertion). Applies the same eligibility rules either way: a CRM contact of this organization,
 * or anyone when the organization opted into open sign-up (which creates a CRM lead); blocked users never get in.
 */
export async function establishSession({ orgId, settings, email, via }) {
  const { supportPortalUsers, supportPortalSessions } = await getSupportCollections();
  const oid = toObjectId(orgId);
  const e = normEmail(email);
  let user = await supportPortalUsers.findOne({ orgId: oid, email: e });
  if (user?.status === "BLOCKED") return fail("This account cannot sign in.", 403);
  let contact = await findContactByEmail(orgId, e);
  if (!contact && !user && settings.signup === "open") contact = await createLeadContact({ orgId, email: e });
  if (!contact && !user && settings.signup !== "open") return fail("This sign-in link is not valid or has expired.", 401);
  if (!user) {
    const doc = { orgId: oid, email: e, name: contact?.name || null, contactId: contact?._id || null, status: "ACTIVE", prefs: { notifications: {} }, timezone: null, createdAt: nowIso(), lastLoginAt: nowIso() };
    try { doc._id = (await supportPortalUsers.insertOne(doc)).insertedId; user = doc; } catch (err) { if (err?.code === 11000) user = await supportPortalUsers.findOne({ orgId: oid, email: e }); else throw err; }
    await emit({ orgId, type: "customer.created", data: { email: e, contactLinked: !!contact, via }, actor: e });
  } else {
    const set = { lastLoginAt: nowIso() };
    if (!user.contactId && contact) set.contactId = contact._id;
    await supportPortalUsers.updateOne({ _id: user._id }, { $set: set });
    user = { ...user, ...set };
  }
  const sessionToken = newToken(32);
  await supportPortalSessions.insertOne({ tokenHash: sha256(sessionToken), orgId: oid, userId: user._id, createdAt: nowIso(), expiresAt: new Date(Date.now() + SESSION_TTL_MS), via });
  await audit({ orgId, action: "PORTAL_SIGNED_IN", actorEmail: user.email, metadata: { contactLinked: !!user.contactId, via } });
  await emit({ orgId, type: "customer.signed_in", data: { via }, actor: user.email });
  return { sessionToken, user, maxAgeSeconds: SESSION_TTL_MS / 1000 };
}

export function readSessionToken(req) {
  const raw = req.headers.get("cookie") || "";
  const m = raw.split(/;\s*/).find((c) => c.startsWith(`${PORTAL_COOKIE}=`));
  return m ? decodeURIComponent(m.slice(PORTAL_COOKIE.length + 1)) : null;
}

/** The portal user for this request, for THIS organization only; otherwise null. */
export async function getPortalUser({ req, orgId }) {
  const token = readSessionToken(req);
  if (!token) return null;
  const { supportPortalSessions, supportPortalUsers } = await getSupportCollections();
  const s = await supportPortalSessions.findOne({ tokenHash: sha256(token), orgId: toObjectId(orgId), expiresAt: { $gt: new Date() } });
  if (!s) return null;
  const u = await supportPortalUsers.findOne({ _id: s.userId, orgId: toObjectId(orgId) });
  return u && u.status === "ACTIVE" ? u : null;
}

export async function logout({ req, orgId }) {
  const token = readSessionToken(req);
  if (!token) return { ok: true };
  const { supportPortalSessions } = await getSupportCollections();
  await supportPortalSessions.deleteOne({ tokenHash: sha256(token), orgId: toObjectId(orgId) });
  return { ok: true };
}

export function sessionCookie(token, maxAgeSeconds) {
  return `${PORTAL_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeSeconds)}${process.env.NODE_ENV === "production" || process.env.VERCEL ? "; Secure" : ""}`;
}
export const clearCookie = () => `${PORTAL_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

export const publicUser = (u) => ({ id: String(u._id), email: u.email, name: u.name, timezone: u.timezone || null, prefs: u.prefs?.notifications || {}, contactLinked: !!u.contactId });

export async function updateProfile({ orgId, user, name, timezone, prefs }) {
  const { supportPortalUsers } = await getSupportCollections();
  const set = {};
  if (name !== undefined) set.name = String(name || "").slice(0, 120);
  if (timezone !== undefined) { try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); set.timezone = timezone; } catch { return fail("That timezone is not valid."); } }
  if (prefs && typeof prefs === "object") { const allowed = ["ticketUpdates", "productAnnouncements", "ideaUpdates", "kbSubscriptions"]; for (const k of allowed) if (typeof prefs[k] === "boolean") set[`prefs.notifications.${k}`] = prefs[k]; }
  await supportPortalUsers.updateOne({ _id: user._id, orgId: toObjectId(orgId) }, { $set: set });
  return { user: publicUser(await supportPortalUsers.findOne({ _id: user._id })) };
}

/** For API keys bound to a customer: the customer's portal record, created on first use if (and only if) they are a CRM contact. */
export async function ensurePortalUser({ orgId, email }) {
  const e = normEmail(email);
  const { supportPortalUsers } = await getSupportCollections();
  const oid = toObjectId(orgId);
  const ex = await supportPortalUsers.findOne({ orgId: oid, email: e });
  if (ex) return ex.status === "ACTIVE" ? ex : null;
  const contact = await findContactByEmail(orgId, e);
  if (!contact) return null;
  const doc = { orgId: oid, email: e, name: contact.name || null, contactId: contact._id, status: "ACTIVE", prefs: { notifications: {} }, timezone: null, createdAt: nowIso(), lastLoginAt: null };
  try { doc._id = (await supportPortalUsers.insertOne(doc)).insertedId; return doc; } catch (err) { if (err?.code === 11000) return supportPortalUsers.findOne({ orgId: oid, email: e }); throw err; }
}
