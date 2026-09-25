// src/lib/documentAutomation/delivery.js
//
// Native Document & Invoice Automation Engine SOW, Section 16/19. Secure
// delivery -- reuses document-permissions.js's REAL share-token system
// (generateShareToken/createDocumentShare/consumeDocumentShare/
// revokeDocumentShare: unguessable 256-bit tokens, atomic expiry/
// revocation/max-uses enforcement) rather than building a second one.
//
// One real difference from that module's own existing external-facing
// route (api/orgs/share/[token]/route.js): that route serves cidAlpha/
// cidBeta back to the CLIENT to decrypt with an out-of-band passkey,
// because org_documents are client-side encrypted. Generated documents
// (see generate.js) are SERVER-managed encryption -- there is no
// external recipient passkey to hand out for a PDF the server itself
// generated -- so this module's retrieval path decrypts and serves the
// PDF bytes directly once the token is validated. The token validation
// IS the entire security boundary here, same as the existing route's
// own documented model.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";
import { createNotification } from "../notifications.js";
import { createDocumentShare, consumeDocumentShare, revokeDocumentShare, resolveExpiresAt } from "../document-permissions.js";
import { getS3ObjectBody } from "../s3-compat/store.js";

export async function createDocumentDeliveryLink({ orgId, documentId, membership, actorEmail, expiresPreset = "7d", recipientEmail }) {
  const { generatedDocuments } = await getOrgCollections();
  const doc = await generatedDocuments.findOne({ _id: toObjectId(documentId), orgId: toObjectId(orgId), deletedAt: null });
  if (!doc) return { error: "Document not found.", status: 404 };
  if (doc.status === "SUPERSEDED") return { error: "This document version has been superseded -- share the current version instead.", status: 409 };

  const expiresAt = resolveExpiresAt({ preset: expiresPreset });
  if (!expiresAt) return { error: "Invalid expiration preset.", status: 400 };

  // createDocumentShare's own documentId field is a generic, opaque
  // reference -- it does not require the id to exist in org_documents
  // specifically (consumeDocumentShare only validates the TOKEN;
  // resolving what "documentId" means is left entirely to the caller,
  // confirmed by reading both functions before reusing them this way).
  const { shareId, token } = await createDocumentShare({ orgId, documentId, createdByEmail: actorEmail, expiresAt, maxUses: null });

  await logOrgActivity({
    orgId, recordType: "GENERATED_DOCUMENT", recordId: toObjectId(documentId), actorEmail,
    action: "SECURE_LINK_CREATED", previousState: null, newState: null,
    metadata: { shareId: shareId.toString(), expiresAt, documentNumber: doc.documentNumber },
  });

  if (recipientEmail) {
    await createNotification({
      scope: "org", orgId, targetEmail: actorEmail, category: "documentAutomation", severity: "info",
      type: "document_delivery_created", title: `Secure link created for ${doc.documentNumber}`,
      body: `A link expiring ${expiresAt} was created to share this document with ${recipientEmail}.`,
      sourceModule: "document-automation", sourceId: documentId, actionUrl: "/business?view=finance",
      dedupeKey: `${orgId}:document_delivery_created:${shareId}`,
    }).catch((err) => console.error("createDocumentDeliveryLink: notification failed (non-fatal):", err.message));
  }

  return { shareId: shareId.toString(), token, expiresAt };
}

export async function revokeDocumentDeliveryLink({ orgId, documentId, shareId, membership, actorEmail }) {
  const result = await revokeDocumentShare({ orgId, documentId, shareId });
  if (result?.error) return result;
  await logOrgActivity({
    orgId, recordType: "GENERATED_DOCUMENT", recordId: toObjectId(documentId), actorEmail,
    action: "SECURE_LINK_REVOKED", previousState: null, newState: null, metadata: { shareId },
  });
  return { revoked: true };
}

/** The unauthenticated recipient path (SOW §19). Validates the token
 *  (the real security boundary -- see consumeDocumentShare's own atomic
 *  expiry/revocation/use-count check), resolves the generatedDocuments
 *  record, fetches and decrypts the real bytes, and logs the access --
 *  all before returning anything to the caller. */
export async function resolveDocumentDelivery(token) {
  const consumed = await consumeDocumentShare(token);
  if (consumed.error) return consumed;

  const { share } = consumed;
  const { generatedDocuments } = await getOrgCollections();
  const doc = await generatedDocuments.findOne({ _id: share.documentId, deletedAt: null });
  if (!doc) return { error: "This document is no longer available.", status: 404 };

  const stored = await getS3ObjectBody({ orgId: doc.orgId.toString(), bucket: doc.storageReference.bucket, key: doc.storageReference.key });
  if (!stored) return { error: "This document's stored content could not be retrieved.", status: 500 };

  await logOrgActivity({
    orgId: doc.orgId, recordType: "GENERATED_DOCUMENT", recordId: doc._id, actorEmail: "external-recipient",
    action: doc.status === "SUPERSEDED" ? "ACCESS_DENIED_SUPERSEDED" : "RECIPIENT_ACCESS",
    previousState: null, newState: null, metadata: { shareId: share._id.toString() },
  }).catch((err) => console.error("resolveDocumentDelivery: audit log failed (non-fatal):", err.message));

  // A superseded document's link must never silently resolve to the new
  // version either (SOW §16's "never silently resolve to a different
  // version") -- it fails closed instead, naming the reason.
  if (doc.status === "SUPERSEDED") {
    return { error: "This document has been superseded by a newer version. Ask the sender for an updated link.", status: 410 };
  }

  return {
    buffer: stored.buffer, contentType: "application/pdf",
    filename: `${doc.documentNumber}.pdf`, documentHash: doc.documentHash, documentNumber: doc.documentNumber,
  };
}
