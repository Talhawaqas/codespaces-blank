// src/lib/orgs.js
//
// Data model and auth primitives for Company/Department/Project/Document
// business records management (Phase 1 of the ERP-style scope — Phase 2
// layers document workflow states on top of this).
//
// DELIBERATELY SEPARATE from the wallet-based personal file system
// (src/lib/metadata-auth.js, the `metadata_files` collection): that
// system's `owner` field is always a wallet address, cross-checked
// against on-chain data via verifyOnChainFileOwner(). Org members
// authenticate by email + session, not a wallet signature — mixing the
// two ownership semantics into one collection risked silently breaking
// that system's on-chain-ownership invariant. Org documents live in their
// own `org_documents` collection instead (see the "wire document upload"
// task), reusing the same encrypt/shard/pin/on-chain-registration
// pipeline, just recorded differently afterward — same pattern the
// Corporate Reserve/PAYG card-customer flow already uses (treasury
// wallet registers on-chain on the customer's behalf, see
// app/api/stripe-webhook/route.js's settlePaygUpload()).
//
// AUTH: magic links are generated here and emailed via Resend (see
// src/lib/email.js's sendMagicLinkEmail(), called from orgs/create,
// orgs/invite, and orgs/login/request) whenever RESEND_API_KEY is
// configured. Only falls back to returning the raw link directly to the
// caller when delivery isn't configured or a send fails — see each
// route's own comment for why that fallback is safe there specifically.
// Session tokens are opaque random values, stored SHA-256-hashed
// (not in plaintext) so a database leak doesn't directly yield usable
// sessions — there's no reason to store them recoverable, hashing costs
// nothing extra here.

import { randomBytes, createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { connectToDatabase } from "./mongodb.js";

export const ROLES = ["owner", "admin", "member"];
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const MAGIC_LINK_TTL_MS = 30 * 60 * 1000; // 30 minutes — short-lived, single-use
export const SESSION_COOKIE = "inaya_org_session";

export function normalizeEmail(email) {
  if (typeof email !== "string") return "";
  return email.trim().toLowerCase();
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function generateToken() {
  return randomBytes(32).toString("hex");
}

export async function getOrgCollections() {
  const { db } = await connectToDatabase();
  return {
    db,
    orgs: db.collection("orgs"),
    orgMembers: db.collection("org_members"),
    departments: db.collection("departments"),
    projects: db.collection("projects"),
    magicLinks: db.collection("magic_links"),
    sessions: db.collection("sessions"),
    orgDocuments: db.collection("org_documents"),
    documentActivity: db.collection("document_activity"),
    projectMembers: db.collection("project_members"),
    documentPermissions: db.collection("document_permissions"),
    documentShares: db.collection("document_shares"),
  };
}

let indexesEnsured = false;

export async function ensureOrgIndexes() {
  if (indexesEnsured) return;
  const {
    orgMembers, departments, projects, magicLinks, sessions, orgDocuments, documentActivity,
    projectMembers, documentPermissions, documentShares,
  } = await getOrgCollections();

  await Promise.all([
    orgMembers.createIndex({ orgId: 1, email: 1 }, { unique: true }),
    orgMembers.createIndex({ email: 1 }),
    departments.createIndex({ orgId: 1 }),
    projects.createIndex({ orgId: 1, departmentId: 1 }),
    magicLinks.createIndex({ tokenHash: 1 }, { unique: true }),
    magicLinks.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    sessions.createIndex({ tokenHash: 1 }, { unique: true }),
    sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    orgDocuments.createIndex({ orgId: 1, departmentId: 1, projectId: 1 }),
    orgDocuments.createIndex({ fileHash: 1 }, { unique: true }),
    documentActivity.createIndex({ documentId: 1, timestamp: 1 }),
    documentActivity.createIndex({ eventId: 1 }, { unique: true }),
    // Phase 3 — permissions & secure sharing
    projectMembers.createIndex({ orgId: 1, projectId: 1, email: 1 }, { unique: true }),
    projectMembers.createIndex({ orgId: 1, email: 1 }),
    documentPermissions.createIndex({ orgId: 1, documentId: 1, email: 1 }, { unique: true }),
    documentPermissions.createIndex({ orgId: 1, email: 1 }),
    documentShares.createIndex({ tokenHash: 1 }, { unique: true }),
    documentShares.createIndex({ documentId: 1 }),
    documentShares.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);

  indexesEnsured = true;
}

/** Extracts the raw session token from a request. Web clients send it as the
 *  inaya_org_session cookie (set by GET /api/orgs/login/consume). Mobile has no
 *  cookie jar shared with the app's own fetch calls (a magic link opened from an
 *  email opens the device's system browser, not the app, so any cookie it gets
 *  set stays trapped there) — so the mobile client instead consumes its login
 *  token via POST /api/orgs/login/consume-token, gets the raw session token back
 *  in the JSON body, and sends it back as `Authorization: Bearer <token>` on
 *  every subsequent request. Both paths resolve to the same sessions collection,
 *  so nothing else about session validation differs between web and mobile. */
export function getRawSessionToken(req) {
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }
  return req.cookies.get(SESSION_COOKIE)?.value || null;
}

/** Looks up the active session for a request's session cookie value (the raw token,
 *  not the hash). Returns null for missing/expired/unknown tokens rather than throwing —
 *  callers decide whether that's a 401 or an anonymous view. */
export async function getSession(rawToken) {
  if (!rawToken) return null;
  const { sessions } = await getOrgCollections();
  const session = await sessions.findOne({ tokenHash: hashToken(rawToken) });
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) return null;
  return session;
}

/** Fetches the caller's membership + role for a specific org, or null if they aren't a
 *  member. Every org-scoped route should call this rather than trusting a client-supplied
 *  role — role is only ever read from the stored org_members doc. */
export async function getMembership(orgId, email) {
  const { orgMembers } = await getOrgCollections();
  return orgMembers.findOne({ orgId: toObjectId(orgId), email: normalizeEmail(email), status: "active" });
}

export function canManageOrg(membership) {
  return membership?.role === "owner" || membership?.role === "admin";
}

export function toObjectId(id) {
  return id instanceof ObjectId ? id : new ObjectId(id);
}

/** The session-cookie -> membership resolution every org-scoped route needs. Returns
 *  { session, membership } or a { error, status } pair to return directly — callers do:
 *    const auth = await requireMembership(req, orgId);
 *    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
 *  Pass requireManage:true for owner/admin-only actions (inviting members, creating
 *  departments/projects); omit it for anything any active member can do. */
export async function requireMembership(req, orgId, { requireManage = false } = {}) {
  const rawToken = getRawSessionToken(req);
  const session = await getSession(rawToken);
  if (!session) return { error: "Not signed in.", status: 401 };

  let membership;
  try {
    membership = await getMembership(orgId, session.email);
  } catch {
    return { error: "Invalid company ID.", status: 400 };
  }
  if (!membership) return { error: "You're not a member of this company.", status: 403 };
  if (requireManage && !canManageOrg(membership)) {
    return { error: "Only the owner or an admin can do that.", status: 403 };
  }

  return { session, membership };
}

/** Issues a fresh session for an email whose identity has already been verified by the
 *  caller — a consumed magic-link token, or a verified Google ID token. Returns
 *  { email, sessionToken }. Does NOT set a cookie — callers decide how to hand it back. */
export async function createSession(email) {
  const { sessions } = await getOrgCollections();
  const sessionToken = generateToken();
  await sessions.insertOne({
    tokenHash: hashToken(sessionToken),
    email,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    createdAt: new Date().toISOString(),
  });
  return { email, sessionToken };
}

/** Validates and consumes a magic-link token (shared by the web GET redirect route and
 *  the mobile POST JSON route) — marks it used, flips an invite's membership to active,
 *  and issues a fresh session via createSession(). Returns { error, status } or
 *  { email, sessionToken }. Does NOT set a cookie or build a response — callers decide
 *  how to hand the token back. */
export async function consumeLoginToken(token) {
  if (!token) return { error: "missing_token", status: 400 };

  await ensureOrgIndexes();
  const { magicLinks, orgMembers } = await getOrgCollections();

  const link = await magicLinks.findOne({ tokenHash: hashToken(token) });
  if (!link || link.usedAt || new Date(link.expiresAt).getTime() < Date.now()) {
    return { error: "invalid_or_expired", status: 400 };
  }

  const now = new Date().toISOString();
  await magicLinks.updateOne({ _id: link._id }, { $set: { usedAt: now } });

  if (link.purpose === "invite" && link.orgId) {
    await orgMembers.updateOne(
      { orgId: link.orgId, email: link.email },
      { $set: { status: "active", joinedAt: now } }
    );
  }

  return createSession(link.email);
}

/** Members see documents in departments they're assigned to; owner/admin see everything
 *  in the org. Phase 1's whole permission model in one place so Phase 2's workflow logic
 *  has one function to extend rather than re-deriving this in every route. */
export function canAccessDepartment(membership, departmentId) {
  if (!membership) return false;
  if (canManageOrg(membership)) return true;
  return (membership.departmentIds || []).some((id) => id.toString() === departmentId.toString());
}
