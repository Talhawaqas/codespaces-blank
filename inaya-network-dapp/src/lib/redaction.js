// src/lib/redaction.js
//
// Healthcare & Legal Expansion SOW, Phase 7 (§11.16) — redaction.
// Redacting a document NEVER mutates the original — this produces a new
// `org_documents` row (the redacted output) linked back to the original
// via `redactedFromDocumentId`, exactly the storage-indirection principle
// every other domain record in this SOW uses for its own document links.
// The original stays exactly as it was, still reachable by anyone with
// its own (typically narrower) access grant.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canAccessLegalMatters, canManageLegal } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

/** `suggestions` is a plain array of {text, reason} the caller has
 *  already identified (via a sensitive-data-suggestion pass elsewhere, or
 *  manual review) — this module does not itself scan document content
 *  for sensitive data; that's a separate concern this module doesn't
 *  take on, matching the SOW's "manual redaction + sensitive-data
 *  suggestions" framing as two distinct inputs to the same review step. */
export async function createRedactionRequest({ orgId, matterId, originalDocumentId, suggestions, actorEmail, membership }) {
  if (!canAccessLegalMatters(membership)) return { error: "You don't have permission to request a redaction.", status: 403 };
  const { db } = await getOrgCollections();
  const redactionRequests = db.collection("legal_redaction_requests");
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), matterId: toObjectId(matterId), originalDocumentId: toObjectId(originalDocumentId),
    suggestions: suggestions || [], status: "PENDING_REVIEW", redactedDocumentId: null,
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await redactionRequests.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "REDACTION_REQUEST", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: "PENDING_REVIEW", metadata: { originalDocumentId } });
  return { request: inserted };
}

/** Completes the review — the caller has already produced the actual
 *  redacted file content and uploaded it as a new org_documents row
 *  through the ordinary document-upload path (reusing the existing
 *  encrypt/shard/pin pipeline, not a new one); this just links that new
 *  document as the redacted output and marks review complete. The
 *  original document's own row is never touched by this call. */
export async function completeRedaction({ orgId, requestId, redactedDocumentId, actorEmail, membership }) {
  if (!canManageLegal(membership)) return { error: "Only a legal manager or the owner/admin can finalize a redaction.", status: 403 };
  const { db } = await getOrgCollections();
  const redactionRequests = db.collection("legal_redaction_requests");
  const updated = await redactionRequests.findOneAndUpdate(
    { _id: toObjectId(requestId), orgId: toObjectId(orgId), status: "PENDING_REVIEW" },
    { $set: { status: "COMPLETED", redactedDocumentId: toObjectId(redactedDocumentId), updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Redaction request not found, or already completed.", status: 409 };
  await logOrgActivity({ orgId, recordType: "REDACTION_REQUEST", recordId: updated._id, actorEmail, action: "COMPLETED", previousState: "PENDING_REVIEW", newState: "COMPLETED", metadata: { redactedDocumentId } });
  return { request: updated };
}

export async function listRedactionRequestsForMatter(orgId, matterId) {
  const { db } = await getOrgCollections();
  const redactionRequests = db.collection("legal_redaction_requests");
  return redactionRequests.find({ orgId: toObjectId(orgId), matterId: toObjectId(matterId) }).sort({ createdAt: -1 }).toArray();
}
