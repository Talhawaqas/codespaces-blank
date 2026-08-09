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
// AUTH: no email-sending service exists in this codebase yet (same gap
// hit building the referral system) so real magic-link delivery isn't
// wired up — login/invite links are generated here and returned to the
// caller (an org owner/admin) to share manually, same as referral invite
// links. Session tokens are opaque random values, stored SHA-256-hashed
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
  };
}

let indexesEnsured = false;

export async function ensureOrgIndexes() {
  if (indexesEnsured) return;
  const { orgMembers, departments, projects, magicLinks, sessions, orgDocuments, documentActivity } = await getOrgCollections();

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
  ]);

  indexesEnsured = true;
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
  const rawToken = req.cookies.get(SESSION_COOKIE)?.value;
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

/** Members see documents in departments they're assigned to; owner/admin see everything
 *  in the org. Phase 1's whole permission model in one place so Phase 2's workflow logic
 *  has one function to extend rather than re-deriving this in every route. */
export function canAccessDepartment(membership, departmentId) {
  if (!membership) return false;
  if (canManageOrg(membership)) return true;
  return (membership.departmentIds || []).some((id) => id.toString() === departmentId.toString());
}
