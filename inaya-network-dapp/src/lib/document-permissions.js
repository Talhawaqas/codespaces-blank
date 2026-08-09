// src/lib/document-permissions.js
//
// Phase 3 — resource-level authorization + secure sharing, layered on top
// of Phase 1/2's existing org/member/department/project/document
// infrastructure. No new auth system, no new storage system — this file
// only adds permission RESOLUTION logic and two new collections
// (document_permissions for explicit grants, document_shares for external
// links) plus project_members for project-level membership.
//
// PERMISSION RESOLUTION — one function, one place, in this precedence order:
//   1. Org owner/admin (canManageOrg)  -> MANAGE on every document, org-wide.
//      Per the SOW: admin can "Manage documents" / "Manage document
//      permissions" org-wide, not scoped to their own departments — this
//      is intentionally broader than canAccessDepartment's owner/admin
//      bypass, which only concerns navigating the department tree.
//   2. Document owner (org_documents.uploadedByEmail === caller)  -> MANAGE.
//   3. An explicit grant in document_permissions                 -> that level.
//   4. Otherwise, based on the document's accessLevel:
//        PRIVATE    -> no implicit access (null)
//        DEPARTMENT -> EDIT if the caller can access the document's department
//        PROJECT    -> EDIT if the caller is a member of the document's project
//   5. Otherwise -> null (no access at all).
//
// Why EDIT, not VIEW, as the department/project default: Phase 2 already
// shipped "any department member can submit/revise a document" as tested,
// working behavior, and the SOW requires Phase 2's document workflow to
// keep working unmodified. Collapsing implicit department/project access
// down to VIEW-only would silently break that. VIEW/EDIT/MANAGE distinctions
// do their real work on PRIVATE documents (nothing is implicit there) and
// as explicit per-person overrides — narrowing one person to VIEW-only on
// an otherwise-editable department document, or granting MANAGE to someone
// who wouldn't otherwise have it — exactly like the SOW's own example
// ("Ahmed — View, Fibha — Edit" on one document).
//
// This NEVER grants workflow approval authority — transitionDocument()
// (document-workflow.js) still gates startReview/approve/reject/archive/
// restore purely on canManageOrg, completely independent of whatever
// document-level permission a user holds. An EDIT/MANAGE grant lets you
// edit or manage sharing for a document; it does not make you a reviewer.
// That separation is a hard requirement (SOW section 7), not an oversight.
//
// PERFORMANCE: getBulkDocumentAccess() resolves permissions for an entire
// document list with exactly two queries total (one for this user's
// explicit grants in the org, one for their project memberships), not one
// query per document — the SOW explicitly calls out avoiding
// per-request full-permission-table loads.
//
// SHARE TOKENS: cryptographically random (32 bytes via node:crypto),
// stored only as a SHA-256 hash — never the documentId, email, a
// timestamp, or an incrementing ID, and never recoverable from the
// database. consumeDocumentShare() validates AND increments useCount in a
// single atomic findOneAndUpdate, the same pattern transitionDocument()
// uses for workflow transitions — that's what makes concurrent access
// against a maxUses-limited link race-safe without extra locking.

import { randomBytes, createHash } from "node:crypto";
import { getOrgCollections, canManageOrg, canAccessDepartment, toObjectId } from "./orgs.js";
import { logDocumentActivity } from "./activity-log.js";

export const PERMISSION_LEVELS = ["VIEW", "EDIT", "MANAGE"];
export const ACCESS_LEVELS = ["PRIVATE", "DEPARTMENT", "PROJECT"];
const LEVEL_RANK = { VIEW: 1, EDIT: 2, MANAGE: 3 };

export function meetsLevel(actualLevel, requiredLevel) {
  if (!actualLevel) return false;
  return (LEVEL_RANK[actualLevel] || 0) >= (LEVEL_RANK[requiredLevel] || Infinity);
}

function resolveLevel({ doc, isOrgManager, email, explicitLevel, isProjMember, membership }) {
  if (isOrgManager) return "MANAGE";
  if (doc.uploadedByEmail === email) return "MANAGE";
  if (explicitLevel) return explicitLevel;
  // Documents created before Phase 3 (or any fixture that predates
  // accessLevel) have no accessLevel field at all — default them to
  // DEPARTMENT, the same default new uploads get, rather than silently
  // treating them as PRIVATE (no implicit access for anyone). Must match
  // the fallback the document list route uses for display.
  const accessLevel = doc.accessLevel || "DEPARTMENT";
  switch (accessLevel) {
    case "DEPARTMENT":
      return canAccessDepartment(membership, doc.departmentId) ? "EDIT" : null;
    case "PROJECT":
      return isProjMember ? "EDIT" : null;
    case "PRIVATE":
    default:
      return null;
  }
}

/** Standalone check, for route-level gates (e.g. "can this caller list this
 *  project's documents at all") separate from full document resolution. */
export async function isProjectMember({ orgId, projectId, email }) {
  const { projectMembers } = await getOrgCollections();
  const row = await projectMembers.findOne({ orgId: toObjectId(orgId), projectId: toObjectId(projectId), email });
  return !!row;
}

/** Single-document resolution — one or two targeted queries (skipped
 *  entirely for org owner/admin or the document's own uploader). */
export async function getDocumentAccessLevel({ orgId, doc, membership, email }) {
  const isOrgManager = canManageOrg(membership);
  if (isOrgManager || doc.uploadedByEmail === email) {
    return resolveLevel({ doc, isOrgManager, email, explicitLevel: null, isProjMember: false, membership });
  }

  const { documentPermissions, projectMembers } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const [grant, projMembership] = await Promise.all([
    documentPermissions.findOne({ orgId: orgObjectId, documentId: doc._id, email }),
    doc.accessLevel === "PROJECT" ? projectMembers.findOne({ orgId: orgObjectId, projectId: doc.projectId, email }) : Promise.resolve(null),
  ]);

  return resolveLevel({
    doc,
    isOrgManager: false,
    email,
    explicitLevel: grant?.level || null,
    isProjMember: !!projMembership,
    membership,
  });
}

/** Bulk resolution for a document list — see module comment on why this
 *  is exactly two queries regardless of list size. */
export async function getBulkDocumentAccess({ orgId, email, membership, docs }) {
  const result = new Map();
  const isOrgManager = canManageOrg(membership);
  if (isOrgManager) {
    for (const doc of docs) result.set(doc._id.toString(), "MANAGE");
    return result;
  }

  const { documentPermissions, projectMembers } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const [grants, projMemberships] = await Promise.all([
    documentPermissions.find({ orgId: orgObjectId, email }).toArray(),
    projectMembers.find({ orgId: orgObjectId, email }).toArray(),
  ]);
  const grantByDoc = new Map(grants.map((g) => [g.documentId.toString(), g.level]));
  const projectIdSet = new Set(projMemberships.map((m) => m.projectId.toString()));

  for (const doc of docs) {
    const level = resolveLevel({
      doc,
      isOrgManager: false,
      email,
      explicitLevel: grantByDoc.get(doc._id.toString()) || null,
      isProjMember: doc.projectId ? projectIdSet.has(doc.projectId.toString()) : false,
      membership,
    });
    result.set(doc._id.toString(), level);
  }
  return result;
}

/** The full chain for a single-document route: load the document (scoped to
 *  orgId, so cross-org IDs 404 the same way document-workflow.js's org
 *  isolation does), resolve access, and enforce a minimum level. Returns
 *  { doc, accessLevel } on success or { error, status } on failure — same
 *  convention as requireMembership(). */
export async function requireDocumentAccess({ orgId, documentId, membership, email, minLevel }) {
  const { orgDocuments } = await getOrgCollections();
  const doc = await orgDocuments.findOne({ _id: toObjectId(documentId), orgId: toObjectId(orgId) });
  if (!doc) return { error: "Document not found.", status: 404 };

  const accessLevel = await getDocumentAccessLevel({ orgId, doc, membership, email });
  if (!meetsLevel(accessLevel, minLevel)) {
    return { error: "You don't have permission to do that.", status: 403 };
  }
  return { doc, accessLevel };
}

// ============================================================
// Secure sharing
// ============================================================
export const SHARE_EXPIRATION_PRESETS = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};
const MAX_CUSTOM_EXPIRATION_MS = 365 * 24 * 60 * 60 * 1000; // sanity cap on custom expirations

export function resolveExpiresAt({ preset, customExpiresAt }) {
  if (preset && SHARE_EXPIRATION_PRESETS[preset]) {
    return new Date(Date.now() + SHARE_EXPIRATION_PRESETS[preset]).toISOString();
  }
  if (customExpiresAt) {
    const ms = new Date(customExpiresAt).getTime();
    if (Number.isNaN(ms)) return null;
    if (ms <= Date.now()) return null; // must be in the future
    if (ms - Date.now() > MAX_CUSTOM_EXPIRATION_MS) return null; // sanity cap
    return new Date(ms).toISOString();
  }
  return null;
}

export function generateShareToken() {
  return randomBytes(32).toString("base64url"); // 256 bits, URL-safe, unguessable
}

export function hashShareToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export async function createDocumentShare({ orgId, documentId, createdByEmail, expiresAt, maxUses }) {
  const { documentShares } = await getOrgCollections();
  const token = generateShareToken();
  const now = new Date().toISOString();
  const result = await documentShares.insertOne({
    orgId: toObjectId(orgId),
    documentId: toObjectId(documentId),
    tokenHash: hashShareToken(token),
    createdByEmail,
    createdAt: now,
    expiresAt,
    maxUses: maxUses ?? null,
    useCount: 0,
    revokedAt: null,
  });
  return { shareId: result.insertedId, token };
}

/** Validates AND consumes one use, atomically — see module comment. Returns
 *  { share } on success or { error, status } on failure. The share document
 *  itself never carries documentId/orgId back to an unauthenticated caller;
 *  route handlers decide what subset of fields to expose. */
export async function consumeDocumentShare(token) {
  const { documentShares } = await getOrgCollections();
  const tokenHash = hashShareToken(token);
  const now = new Date().toISOString();

  // A courtesy lookup for a specific, honest error message — NOT the
  // security boundary. The findOneAndUpdate below re-checks every one of
  // these conditions atomically; that's the actual enforcement.
  const existing = await documentShares.findOne({ tokenHash });
  if (!existing) return { error: "This link is invalid.", status: 404 };
  if (existing.revokedAt) return { error: "This link has been revoked.", status: 410 };
  if (new Date(existing.expiresAt).getTime() < Date.now()) return { error: "This link has expired.", status: 410 };
  if (existing.maxUses !== null && existing.useCount >= existing.maxUses) {
    return { error: "This link has reached its maximum number of uses.", status: 410 };
  }

  const filter = { tokenHash, revokedAt: null, expiresAt: { $gt: now } };
  if (existing.maxUses !== null) filter.useCount = { $lt: existing.maxUses };

  const updated = await documentShares.findOneAndUpdate(filter, { $inc: { useCount: 1 } }, { returnDocument: "after" });
  if (!updated) return { error: "This link is no longer valid.", status: 410 };

  return { share: updated };
}

export async function revokeDocumentShare({ orgId, documentId, shareId }) {
  const { documentShares } = await getOrgCollections();
  return documentShares.findOneAndUpdate(
    { _id: toObjectId(shareId), orgId: toObjectId(orgId), documentId: toObjectId(documentId), revokedAt: null },
    { $set: { revokedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
}

/** The full public-share-access flow: consume the token, look up the
 *  document, and log the appropriate activity event (ACCESSED on success,
 *  EXPIRED when that's specifically why it failed) — all in one place so
 *  the route (GET /api/orgs/share/[token]) stays a thin HTTP wrapper and
 *  this is testable without an HTTP layer. Returns { filename, sizeBytes,
 *  cidAlpha, cidBeta } on success or { error, status } on failure — never
 *  documentId/orgId/shareId, per the SOW's "no internal identifiers in a
 *  share response" requirement. */
export async function resolveShareAccess(token) {
  const result = await consumeDocumentShare(token);
  if (result.error) {
    if (result.status === 410 && /expired/i.test(result.error)) {
      const share = await getOrgCollections().then(({ documentShares }) => documentShares.findOne({ tokenHash: hashShareToken(token) }));
      if (share) {
        await logDocumentActivity({
          organizationId: share.orgId,
          documentId: share.documentId,
          actorId: "external",
          action: "DOCUMENT_SHARE_EXPIRED",
          metadata: { shareId: share._id.toString() },
        });
      }
    }
    return result;
  }

  const { orgDocuments } = await getOrgCollections();
  const doc = await orgDocuments.findOne({ _id: toObjectId(result.share.documentId), orgId: toObjectId(result.share.orgId) });
  if (!doc) return { error: "The shared document no longer exists.", status: 404 };

  await logDocumentActivity({
    organizationId: result.share.orgId,
    documentId: result.share.documentId,
    actorId: "external",
    action: "DOCUMENT_SHARE_ACCESSED",
    metadata: { shareId: result.share._id.toString() },
  });

  return { filename: doc.filename, sizeBytes: doc.sizeBytes, cidAlpha: doc.cidAlpha, cidBeta: doc.cidBeta };
}
