// src/lib/document-workflow.js
//
// Phase 2 — document lifecycle state machine + append-only activity log.
// Reuses Phase 1's org/member/auth infrastructure entirely (getOrgCollections,
// requireMembership, canManageOrg, canAccessDepartment, toObjectId) — no
// second auth system, no new storage layer, nothing new here except the
// state machine and the activity collection itself.
//
// STATES: DRAFT -> PENDING -> UNDER_REVIEW -> APPROVED | REJECTED -> ARCHIVED
//         REJECTED -> DRAFT (revise, then resubmit via the same DRAFT->PENDING
//         transition)     ARCHIVED -> APPROVED (restore)
//
// ROLES: "revise" and "submit" require at least EDIT-level document access
// (Phase 3's getDocumentAccessLevel — org owner/admin, the document owner,
// an explicit EDIT/MANAGE grant, or implicit VIEW-only department/project
// access does NOT qualify, since editing a draft is more than viewing it).
// Every other transition (starting a review, approving, rejecting,
// archiving, restoring) requires owner/admin (canManageOrg) — these are
// the org's actual review authority, and Phase 1 has no separate
// "reviewer" role to delegate to without inventing a new permission
// concept the SOW didn't ask for. Document-level permissions (VIEW/EDIT/
// MANAGE) NEVER grant workflow approval authority — that separation is a
// hard requirement, not an oversight (see document-permissions.js's
// module comment).
//
// ATOMICITY + REPLAY SAFETY: transitionDocument() does ONE findOneAndUpdate
// with a filter requiring the document's CURRENT status to still equal the
// transition's `from` state. A duplicate/replayed request (or a genuine
// race between two people acting on the same document) finds the status
// has already moved and gets a clean 409 — no double-transition, no
// duplicate activity entry, and no separate idempotency-key machinery
// needed. This is the same pattern atomicCappedIncrement() uses for the
// referral program's caps (src/lib/referrals.js).
//
// The activity log is genuinely append-only: every code path in this file
// only ever calls documentActivity.insertOne(). There is no update/delete
// path for this collection anywhere in the codebase — don't add one.

import { getOrgCollections, canManageOrg, toObjectId } from "./orgs.js";
import { getDocumentAccessLevel, meetsLevel } from "./document-permissions.js";
import { logDocumentActivity } from "./activity-log.js";

export { logDocumentActivity }; // re-exported — existing imports across the codebase use this path

export const DOCUMENT_STATES = ["DRAFT", "PENDING", "UNDER_REVIEW", "APPROVED", "REJECTED", "ARCHIVED"];

export const TRANSITIONS = {
  submit: { from: "DRAFT", to: "PENDING", requiresManage: false, activityAction: "SUBMITTED" },
  startReview: { from: "PENDING", to: "UNDER_REVIEW", requiresManage: true, activityAction: "REVIEW_STARTED" },
  approve: { from: "UNDER_REVIEW", to: "APPROVED", requiresManage: true, activityAction: "APPROVED" },
  reject: { from: "UNDER_REVIEW", to: "REJECTED", requiresManage: true, activityAction: "REJECTED" },
  revise: { from: "REJECTED", to: "DRAFT", requiresManage: false, activityAction: "REVISED" },
  archive: { from: "APPROVED", to: "ARCHIVED", requiresManage: true, activityAction: "ARCHIVED" },
  restore: { from: "ARCHIVED", to: "APPROVED", requiresManage: true, activityAction: "RESTORED" },
};

/** The single enforcement point for every document state change. Returns
 *  { document } on success, or { error, status } on failure — callers
 *  return that pair directly as the HTTP response, same convention as
 *  requireMembership(). */
export async function transitionDocument({ orgId, documentId, action, membership, actorEmail, note }) {
  const definition = TRANSITIONS[action];
  if (!definition) {
    return { error: `Unknown action "${action}".`, status: 400 };
  }
  if (definition.requiresManage && !canManageOrg(membership)) {
    return { error: "Only the owner or an admin can do that.", status: 403 };
  }

  const { orgDocuments } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const documentObjectId = toObjectId(documentId);

  // Org isolation: the filter includes orgId, so a document belonging to a
  // different org can never be found here even if someone guesses a valid
  // documentId — requireMembership() already proved the caller belongs to
  // THIS orgId, but this is the check that stops them acting on some other
  // org's document by ID alone.
  const doc = await orgDocuments.findOne({ _id: documentObjectId, orgId: orgObjectId });
  if (!doc) {
    return { error: "Document not found.", status: 404 };
  }
  if (!definition.requiresManage) {
    // submit/revise: EDIT-level document access, not just department
    // visibility — see this file's ROLES comment.
    const accessLevel = await getDocumentAccessLevel({ orgId, doc, membership, email: actorEmail });
    if (!meetsLevel(accessLevel, "EDIT")) {
      return { error: "You don't have permission to do that.", status: 403 };
    }
  }

  const updated = await orgDocuments.findOneAndUpdate(
    { _id: documentObjectId, orgId: orgObjectId, status: definition.from },
    { $set: { status: definition.to, updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) {
    // Someone else already moved it (or this is a replay of a request that
    // already succeeded) — the document's real current status no longer
    // matches what this transition requires.
    return { error: `This document isn't in ${definition.from} state (it's currently ${doc.status}), so "${action}" can't be applied.`, status: 409 };
  }

  await logDocumentActivity({
    organizationId: orgObjectId,
    documentId: documentObjectId,
    actorId: actorEmail,
    action: definition.activityAction,
    previousState: definition.from,
    newState: definition.to,
    metadata: note ? { note } : {},
  });

  return { document: updated };
}
