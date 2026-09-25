// src/lib/documentAutomation/delivery.js
//
// Document Automation SOW §16-§19/§30 -- secure delivery. Reuses, rather
// than rebuilds, two existing mechanisms:
//
//   1. Secure share links (document-permissions.js): 256-bit unguessable
//      tokens, atomic expiry / revocation / use-count enforcement. Bearer
//      access: whoever holds the link can open it, so the recipient's email
//      is RECORDED (for the audit trail and the notification) but not
//      verified -- stated plainly rather than implied to be identity.
//   2. The external Data Room (external-data-room.js): magic-link identity
//      for a named external email, expiring/revocable sessions, NDA gate and
//      an access log. This is the identity-verified path (§17): the
//      recipient must prove control of the email address to open the room.
//
// Both bind to the EXACT document version and hash (§16): a link whose
// document was superseded, voided, cancelled or expired fails closed with a
// named reason, and never silently resolves to a newer version. Every view
// and download is logged (documentAccessEvents + an evidence node on the
// document + the audit chain), and the first recipient access moves the
// document to VIEWED. Email is a notification channel only -- it carries
// the secure link, never the document (§18).

import { getOrgCollections, toObjectId } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";
import { createDocumentShare, consumeDocumentShare, revokeDocumentShare, resolveExpiresAt, hashShareToken } from "../document-permissions.js";
import { createDataRoom, addDocumentToRoom, inviteExternalUser, revokeRoomAccess, closeDataRoom, recordRoomAccess } from "../external-data-room.js";
import { createHash } from "node:crypto";
import { getDocumentType, canViewDocument } from "./documentTypes.js";
import { readDocumentBytes } from "./storage.js";
import { recordEvidence } from "./evidence.js";
import { notifyUser, sendDeliveryEmail } from "./notify.js";
import { recordMetric } from "./metrics.js";
import { appBaseUrl, ACTIVE_FINAL_STATES } from "./pipeline.js";
import { label as i18nLabel } from "./i18n.js";

const err = (error, status = 400, extra = {}) => ({ error, status, ...extra });
const SYNTHETIC_OWNER = { role: "owner" };
const DELIVERABLE = [...ACTIVE_FINAL_STATES, "PAID"];
const sha = (s) => createHash("sha256").update(s).digest("hex");
const hint = (email) => (email ? String(email).replace(/^([^@]{1,2})[^@]*(@.*)$/, "$1***$2") : null);

const GONE_REASONS = {
  SUPERSEDED: "This document has been superseded by a newer version. Ask the sender for an updated link.",
  VOID: "This document has been voided by the sender.",
  CANCELLED: "This document is no longer valid.",
  EXPIRED: "This document has expired.",
  REJECTED: "This document is not available.",
  DRAFT: "This document is not available.", GENERATED: "This document is not available.", PENDING_APPROVAL: "This document is not available.", APPROVED: "This document is not available.",
};

// ---------------------------------------------------------------------
// Create / list / revoke
// ---------------------------------------------------------------------
export async function createDelivery({ orgId, documentId, mode = "link", recipientEmail, expiresPreset = "7d", customExpiresAt, maxUses = null, notify = true, ndaRequired = false, ndaText, membership, email, actorType = "human" }) {
  if (!["link", "data_room"].includes(mode)) return err('mode must be "link" or "data_room".');
  if (recipientEmail !== undefined && recipientEmail !== null && recipientEmail !== "" && (typeof recipientEmail !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail) || recipientEmail.length > 200)) return err("recipientEmail is not a valid email address.");
  if (mode === "data_room" && !recipientEmail) return err("A Data Room delivery needs the recipient's email (it is their verified identity).");
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000)) return err("maxUses must be a whole number from 1 to 1000.");

  const { generatedDocuments, documentDeliveries } = await getOrgCollections();
  let _id;
  try { _id = toObjectId(documentId); } catch { return err("Document not found.", 404); }
  const doc = await generatedDocuments.findOne({ _id, orgId: toObjectId(orgId), deletedAt: null });
  if (!doc || !canViewDocument(membership, doc, email)) return err("Document not found.", 404);
  const def = getDocumentType(doc.documentType);
  if (!def.canDeliver(membership)) return err("You don't have permission to share this type of document.", 403);
  if (!DELIVERABLE.includes(doc.status)) return err(doc.status === "SUPERSEDED" ? "This version has been superseded -- share the current version instead." : `Only a finalized document can be shared (this one is ${doc.status}).`, 409);
  if (doc.pipelineState && !["COMPLETE", "EVIDENCE_PENDING"].includes(doc.pipelineState)) return err(`This document is not ready to share (${doc.pipelineState}).`, 409);

  const expiresAt = resolveExpiresAt({ preset: customExpiresAt ? undefined : expiresPreset, customExpiresAt });
  if (!expiresAt) return err("Invalid expiry.");

  // Idempotency: a double click within two minutes cannot mint two links.
  const bucket = Math.floor(Date.now() / (2 * 60 * 1000));
  const deliveryKey = sha(`${orgId}|${documentId}|${mode}|${(recipientEmail || "").toLowerCase()}|${expiresPreset}|${bucket}`);
  const now = new Date().toISOString();
  const base = {
    orgId: toObjectId(orgId), documentId: doc._id, documentVersion: doc.documentVersion, documentHash: doc.documentHash, documentNumber: doc.documentNumber,
    mode, recipientEmail: recipientEmail ? recipientEmail.toLowerCase() : null, identityVerified: mode === "data_room",
    expiresAt, maxUses, status: "ACTIVE", emailState: "NONE", emailAttempts: 0, deliveryKey, createdByEmail: email, createdByActorType: actorType, createdAt: now, revokedAt: null, expiryNotified: false,
  };
  let delivery;
  try {
    const ins = await documentDeliveries.insertOne(base);
    delivery = { ...base, _id: ins.insertedId };
  } catch (e) {
    if (e?.code === 11000) return err("An identical delivery was just created. Use the link that was shown, or wait two minutes.", 409, { duplicate: true });
    throw e;
  }

  let url;
  let extra = {};
  try {
    if (mode === "link") {
      const { shareId, token } = await createDocumentShare({ orgId, documentId, createdByEmail: email, expiresAt, maxUses });
      await documentDeliveries.updateOne({ _id: delivery._id }, { $set: { shareId } });
      delivery.shareId = shareId;
      url = `${appBaseUrl()}/shared-document/${token}`;
      extra = { token };
    } else {
      const roomRes = await createDataRoom({ orgId, roomType: "document_delivery", name: `Delivery: ${doc.documentNumber} v${doc.documentVersion}`, relatedRecordId: doc._id, ndaRequired, ndaText, actorEmail: email, membership: SYNTHETIC_OWNER });
      if (roomRes.error) throw new Error(roomRes.error);
      const added = await addDocumentToRoom({ orgId, roomId: roomRes.room._id, documentId: doc.storageReference.objectId, actorEmail: email, membership: SYNTHETIC_OWNER });
      if (added.error) throw new Error(added.error);
      const hours = Math.max(1, Math.round((new Date(expiresAt).getTime() - Date.now()) / 3600000));
      const invite = await inviteExternalUser({ orgId, roomId: roomRes.room._id, externalEmail: recipientEmail, expiresInHours: hours, actorEmail: email, membership: SYNTHETIC_OWNER });
      if (invite.error) throw new Error(invite.error);
      await documentDeliveries.updateOne({ _id: delivery._id }, { $set: { roomId: roomRes.room._id } });
      delivery.roomId = roomRes.room._id;
      url = `${appBaseUrl()}/document-room/${invite.token}`;
      extra = { roomId: String(roomRes.room._id), note: "The recipient must open the link within 30 minutes; it verifies their email, then gives them access until the expiry." };
    }
  } catch (e) {
    await documentDeliveries.updateOne({ _id: delivery._id }, { $set: { status: "FAILED", failureReason: String(e.message).slice(0, 300) } });
    await generatedDocuments.updateOne({ _id: doc._id }, { $set: { "delivery.state": "DELIVERY_FAILED" } });
    await recordMetric({ orgId, metric: "delivery_failure", dimensions: { mode } });
    return err(`Could not create the ${mode === "link" ? "secure link" : "Data Room delivery"}: ${e.message}`, 502, { deliveryId: String(delivery._id) });
  }

  await recordEvidence({ orgId, documentId: doc._id, nodeType: "SECURE_LINK_CREATED", actorEmail: email, actorType, membership, gate: "deliver", data: { deliveryId: String(delivery._id), shareId: delivery.shareId ? String(delivery.shareId) : null, mode, expiresAt, recipient: hint(recipientEmail), documentHash: doc.documentHash, boundVersion: doc.documentVersion } });

  let emailResult = null;
  if (notify && recipientEmail) {
    emailResult = await sendDeliveryEmail({ orgId, doc, delivery, url, senderName: undefined });
    await recordEvidence({ orgId, documentId: doc._id, nodeType: "NOTIFICATION_SENT", actorEmail: email, actorType: "system", data: { deliveryId: String(delivery._id), state: emailResult.state, recipient: hint(recipientEmail) }, logActivity: false });
  }
  const deliveryState = emailResult?.state === "FAILED" ? "DELIVERY_FAILED" : "DELIVERED";
  const nextStatus = ["FINALIZED"].includes(doc.status) ? "DELIVERED" : doc.status;
  await generatedDocuments.updateOne({ _id: doc._id, status: doc.status }, { $set: { status: nextStatus, updatedAt: now } });
  await generatedDocuments.updateOne({ _id: doc._id }, { $set: { "delivery.state": deliveryState, "delivery.lastDeliveryId": delivery._id, "delivery.lastDeliveredAt": now } });
  await notifyUser({ orgId, targetEmail: email, type: "document_delivery_completed", title: `${doc.documentNumber} shared`, body: `A ${mode === "link" ? "secure link" : "Data Room invitation"} was created${recipientEmail ? ` for ${recipientEmail}` : ""}, expiring ${expiresAt}.`, doc, dedupeKey: `${orgId}:document_delivery_completed:${delivery._id}` }).catch(() => {});
  await recordMetric({ orgId, metric: "delivery_ms", value: Date.now() - new Date(now).getTime(), dimensions: { mode } });

  return { delivery: publicDelivery({ ...delivery, emailState: emailResult?.state || "NONE" }), url, ...extra, email: emailResult };
}

export function publicDelivery(d) {
  return {
    id: String(d._id), documentId: String(d.documentId), documentVersion: d.documentVersion, mode: d.mode, recipientEmail: d.recipientEmail || null, identityVerified: !!d.identityVerified,
    expiresAt: d.expiresAt, maxUses: d.maxUses ?? null, status: d.status, emailState: d.emailState, createdByEmail: d.createdByEmail, createdAt: d.createdAt, revokedAt: d.revokedAt || null, firstAccessAt: d.firstAccessAt || null, accessCount: d.accessCount || 0, failureReason: d.failureReason || null,
  };
}

export async function listDeliveries({ orgId, documentId, membership, email }) {
  const { generatedDocuments, documentDeliveries, documentAccessEvents } = await getOrgCollections();
  let _id;
  try { _id = toObjectId(documentId); } catch { return err("Document not found.", 404); }
  const doc = await generatedDocuments.findOne({ _id, orgId: toObjectId(orgId), deletedAt: null });
  if (!doc || !canViewDocument(membership, doc, email)) return err("Document not found.", 404);
  const rows = await documentDeliveries.find({ orgId: doc.orgId, documentId: doc._id }).sort({ createdAt: -1 }).limit(100).toArray();
  const events = await documentAccessEvents.find({ orgId: doc.orgId, documentId: doc._id }).sort({ at: -1 }).limit(100).toArray();
  return { deliveries: rows.map(publicDelivery), accessEvents: events.map((e) => ({ id: String(e._id), deliveryId: e.deliveryId ? String(e.deliveryId) : null, type: e.type, result: e.result, at: e.at, mode: e.mode, recipient: e.recipientHint || null })) };
}

export async function revokeDelivery({ orgId, documentId, deliveryId, membership, email, reason = "revoked by sender" }) {
  const { generatedDocuments, documentDeliveries } = await getOrgCollections();
  let doc; let delivery;
  try {
    doc = await generatedDocuments.findOne({ _id: toObjectId(documentId), orgId: toObjectId(orgId), deletedAt: null });
    delivery = await documentDeliveries.findOne({ _id: toObjectId(deliveryId), orgId: toObjectId(orgId), documentId: toObjectId(documentId) });
  } catch { return err("Delivery not found.", 404); }
  if (!doc || !delivery || !canViewDocument(membership, doc, email)) return err("Delivery not found.", 404);
  if (!getDocumentType(doc.documentType).canDeliver(membership)) return err("You don't have permission to revoke this delivery.", 403);
  if (delivery.status !== "ACTIVE") return err(`This delivery is already ${delivery.status}.`, 409);
  await revokeOne({ orgId, doc, delivery, actorEmail: email, reason });
  return { revoked: true };
}

async function revokeOne({ orgId, doc, delivery, actorEmail, reason }) {
  const { documentDeliveries } = await getOrgCollections();
  const now = new Date().toISOString();
  const res = await documentDeliveries.updateOne({ _id: delivery._id, status: "ACTIVE" }, { $set: { status: "REVOKED", revokedAt: now, revokeReason: reason } });
  if (!res.modifiedCount) return;
  if (delivery.mode === "link" && delivery.shareId) await revokeDocumentShare({ orgId, documentId: doc._id, shareId: delivery.shareId }).catch(() => {});
  if (delivery.mode === "data_room" && delivery.roomId) {
    await revokeRoomAccess({ orgId, roomId: delivery.roomId, externalEmail: delivery.recipientEmail, actorEmail, membership: SYNTHETIC_OWNER }).catch(() => {});
    await closeDataRoom({ orgId, roomId: delivery.roomId, actorEmail, membership: SYNTHETIC_OWNER }).catch(() => {});
  }
  await recordEvidence({ orgId, documentId: doc._id, nodeType: "SECURE_LINK_REVOKED", actorEmail, actorType: actorEmail?.startsWith("system") ? "system" : "human", data: { deliveryId: String(delivery._id), mode: delivery.mode, reason } });
  if (doc.createdByEmail && doc.createdByEmail !== actorEmail) await notifyUser({ orgId, targetEmail: doc.createdByEmail, type: "document_link_revoked", severity: "warning", title: `Link revoked for ${doc.documentNumber}`, body: `Reason: ${reason}.`, doc, dedupeKey: `${orgId}:document_link_revoked:${delivery._id}` }).catch(() => {});
}

/** Revokes every active delivery of a document -- called when it is
 *  superseded, voided, cancelled or expired, so no link can outlive its
 *  document's validity. */
export async function revokeAllDeliveries({ orgId, documentId, actorEmail, reason }) {
  const { generatedDocuments, documentDeliveries } = await getOrgCollections();
  const doc = await generatedDocuments.findOne({ _id: toObjectId(documentId), orgId: toObjectId(orgId) });
  if (!doc) return 0;
  const active = await documentDeliveries.find({ orgId: doc.orgId, documentId: doc._id, status: "ACTIVE" }).toArray();
  for (const d of active) await revokeOne({ orgId, doc, delivery: d, actorEmail, reason });
  return active.length;
}

// ---------------------------------------------------------------------
// Recipient access
// ---------------------------------------------------------------------
async function logAccess({ orgId, doc, delivery, type, result, mode, ip, recipient }) {
  const { documentAccessEvents } = await getOrgCollections();
  await documentAccessEvents.insertOne({ orgId: doc.orgId, documentId: doc._id, deliveryId: delivery?._id || null, type, result, mode, at: new Date().toISOString(), recipientHint: hint(recipient || delivery?.recipientEmail), ipHash: ip ? sha(ip).slice(0, 16) : null });
}

async function markViewed({ orgId, doc, delivery, type, mode, recipient }) {
  const { generatedDocuments, documentDeliveries } = await getOrgCollections();
  const now = new Date().toISOString();
  const first = await documentDeliveries.findOneAndUpdate({ _id: delivery._id, firstAccessAt: { $exists: false } }, { $set: { firstAccessAt: now } }, { returnDocument: "after" });
  await documentDeliveries.updateOne({ _id: delivery._id }, { $inc: { accessCount: 1 }, $set: { lastAccessAt: now } });
  const viewedNow = await generatedDocuments.updateOne({ _id: doc._id, status: { $in: ["FINALIZED", "DELIVERED"] } }, { $set: { status: "VIEWED", firstViewedAt: now, updatedAt: now } });
  await recordEvidence({ orgId, documentId: doc._id, nodeType: type === "DOWNLOAD" ? "DOCUMENT_DOWNLOADED" : "DOCUMENT_ACCESSED", actorEmail: recipient || "external-recipient", actorType: "external", data: { deliveryId: String(delivery._id), mode, documentHash: doc.documentHash, boundVersion: doc.documentVersion, recipient: hint(recipient || delivery.recipientEmail) }, previousState: viewedNow.modifiedCount ? doc.status : null, newState: viewedNow.modifiedCount ? "VIEWED" : null });
  if (first) await notifyUser({ orgId, targetEmail: doc.createdByEmail, type: "document_recipient_access", title: `${doc.documentNumber} was opened`, body: `${hint(recipient || delivery.recipientEmail) || "The recipient"} opened the document.`, doc, dedupeKey: `${orgId}:document_recipient_access:${delivery._id}` }).catch(() => {});
}

function goneError(doc) {
  const reason = GONE_REASONS[doc.status];
  return reason ? err(reason, 410, { reasonCode: doc.status }) : null;
}

/** Non-consuming metadata for a link -- what the recipient page shows
 *  before/without opening the PDF. Reveals nothing internal (no ids, no
 *  source records, no organization data beyond the issuing name). */
export async function peekShare(token) {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return err("This link is invalid.", 404);
  const { documentShares, generatedDocuments } = await getOrgCollections();
  const share = await documentShares.findOne({ tokenHash: hashShareToken(token) });
  if (!share) return err("This link is invalid.", 404);
  if (share.revokedAt) return err("This link has been revoked.", 410);
  if (new Date(share.expiresAt).getTime() < Date.now()) return err("This link has expired.", 410);
  if (share.maxUses !== null && share.useCount >= share.maxUses) return err("This link has reached its maximum number of uses.", 410);
  const doc = await generatedDocuments.findOne({ _id: share.documentId, deletedAt: null });
  if (!doc) return err("This document is no longer available.", 404);
  const gone = goneError(doc) || (!DELIVERABLE.includes(doc.status) ? err("This document is not available.", 410) : null);
  if (gone) return gone;
  const def = getDocumentType(doc.documentType);
  return { meta: { documentNumber: doc.documentNumber, documentType: def?.label || doc.documentType, documentVersion: doc.documentVersion, finalizedAt: doc.finalizedAt, expiresAt: share.expiresAt, documentHash: doc.documentHash, pages: doc.pageCount, sizeBytes: doc.sizeBytes, locale: doc.locale, issuer: doc.renderInput?.org?.name || null } };
}

/** The unauthenticated recipient path for a share link. */
export async function resolveDeliveryAccess(token, { download = false, ip = null } = {}) {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return err("This link is invalid.", 404);
  const consumed = await consumeDocumentShare(token);
  if (consumed.error) {
    // An expired / revoked / used-up link that we can still attribute to a
    // real delivery is logged too: a denied attempt is exactly what an
    // auditor wants to see.
    if (consumed.status === 410) {
      try {
        const { documentShares, documentDeliveries: deliveries, generatedDocuments: docs } = await getOrgCollections();
        const share = await documentShares.findOne({ tokenHash: hashShareToken(token) });
        const delivery = share ? await deliveries.findOne({ shareId: share._id }) : null;
        const doc = share ? await docs.findOne({ _id: share.documentId }) : null;
        if (doc && delivery) await logAccess({ orgId: doc.orgId, doc, delivery, type: "DENIED", result: `denied:${/expired/i.test(consumed.error) ? "EXPIRED" : /revoked/i.test(consumed.error) ? "REVOKED" : "LIMIT"}`, mode: "link", ip });
      } catch { /* logging a denial never changes the answer */ }
    }
    return consumed;
  }
  const { share } = consumed;
  const { generatedDocuments, documentDeliveries } = await getOrgCollections();
  const [doc, delivery] = await Promise.all([
    generatedDocuments.findOne({ _id: share.documentId, deletedAt: null }),
    documentDeliveries.findOne({ shareId: share._id }),
  ]);
  if (!doc || !delivery) return err("This document is no longer available.", 404);

  const denied = async (e, type = "DENIED") => { await logAccess({ orgId: doc.orgId, doc, delivery, type, result: `denied:${e.reasonCode || e.status}`, mode: "link", ip }); return e; };
  const gone = goneError(doc);
  if (gone) return denied(gone);
  if (delivery.status !== "ACTIVE") return denied(err("This link has been revoked.", 410));
  if (!DELIVERABLE.includes(doc.status)) return denied(err("This document is not available.", 410));
  if (delivery.documentVersion !== doc.documentVersion || delivery.documentHash !== doc.documentHash) return denied(err("This link no longer matches the current document. Ask the sender for a new link.", 409, { reasonCode: "VERSION_MISMATCH" }));

  const bytes = await readDocumentBytes({ orgId: doc.orgId, storageReference: doc.storageReference, expectedHash: doc.documentHash });
  if (bytes.error) return denied(err(bytes.error, bytes.status || 502));
  if (!bytes.hashMatches) {
    await recordEvidence({ orgId: doc.orgId, documentId: doc._id, nodeType: "INTEGRITY_FAILURE", actorEmail: "system", actorType: "system", data: { expected: doc.documentHash, actual: bytes.actualHash, stage: "delivery" } });
    return denied(err("This document's stored content failed its integrity check and was not released.", 500, { reasonCode: "INTEGRITY" }));
  }
  const type = download ? "DOWNLOAD" : "VIEW";
  await logAccess({ orgId: doc.orgId, doc, delivery, type, result: "ok", mode: "link", ip });
  await markViewed({ orgId: doc.orgId, doc, delivery, type, mode: "link", recipient: delivery.recipientEmail });
  return { buffer: bytes.buffer, contentType: "application/pdf", filename: `${doc.documentNumber}.pdf`, documentHash: doc.documentHash, documentNumber: doc.documentNumber };
}

/** Data Room path: the caller has ALREADY authenticated a room session
 *  (external-data-room.js getRoomSession); this only decides whether the
 *  session may read this generated document and serves it. */
export async function resolveRoomDocument({ session, documentObjectId, download = false, ip = null }) {
  const { generatedDocuments, documentDeliveries, dataRooms } = await getOrgCollections();
  const room = await dataRooms.findOne({ _id: session.roomId, orgId: session.orgId });
  if (!room || room.closedAt) return err("This room is closed.", 410);
  if (room.ndaRequired && !session.ndaAcceptedAt) return err("Accept the confidentiality terms first.", 403, { ndaRequired: true });
  let objectId;
  try { objectId = toObjectId(documentObjectId); } catch { return err("Document not found.", 404); }
  if (!(room.documentIds || []).some((id) => String(id) === String(objectId))) return err("Document not found.", 404);
  const doc = await generatedDocuments.findOne({ orgId: session.orgId, "storageReference.objectId": String(objectId), deletedAt: null });
  const delivery = doc ? await documentDeliveries.findOne({ orgId: session.orgId, documentId: doc._id, roomId: room._id }) : null;
  if (!doc || !delivery) return err("Document not found.", 404);
  const denied = async (e) => { await logAccess({ orgId: doc.orgId, doc, delivery, type: "DENIED", result: `denied:${e.reasonCode || e.status}`, mode: "data_room", ip, recipient: session.externalEmail }); return e; };
  const gone = goneError(doc);
  if (gone) return denied(gone);
  if (delivery.status !== "ACTIVE") return denied(err("This access has been revoked.", 410));
  if (!DELIVERABLE.includes(doc.status)) return denied(err("This document is not available.", 410));
  if (delivery.documentVersion !== doc.documentVersion || delivery.documentHash !== doc.documentHash) return denied(err("This delivery no longer matches the current document.", 409, { reasonCode: "VERSION_MISMATCH" }));
  const bytes = await readDocumentBytes({ orgId: doc.orgId, storageReference: doc.storageReference, expectedHash: doc.documentHash });
  if (bytes.error) return denied(err(bytes.error, bytes.status || 502));
  if (!bytes.hashMatches) return denied(err("This document's stored content failed its integrity check and was not released.", 500, { reasonCode: "INTEGRITY" }));
  const type = download ? "DOWNLOAD" : "VIEW";
  await logAccess({ orgId: doc.orgId, doc, delivery, type, result: "ok", mode: "data_room", ip, recipient: session.externalEmail });
  await recordRoomAccess({ session, action: download ? "DOWNLOAD_DOCUMENT" : "VIEW_DOCUMENT", documentId: objectId });
  await markViewed({ orgId: doc.orgId, doc, delivery, type, mode: "data_room", recipient: session.externalEmail });
  return { buffer: bytes.buffer, contentType: "application/pdf", filename: `${doc.documentNumber}.pdf`, documentHash: doc.documentHash };
}

/** Lists the generated documents a Data Room session may see (metadata only). */
export async function listRoomGeneratedDocuments({ session }) {
  const { generatedDocuments, dataRooms, documentDeliveries } = await getOrgCollections();
  const room = await dataRooms.findOne({ _id: session.roomId, orgId: session.orgId });
  if (!room || room.closedAt) return { documents: [] };
  if (room.ndaRequired && !session.ndaAcceptedAt) return { documents: [], ndaRequired: true, ndaText: room.ndaText || null };
  const ids = (room.documentIds || []).map((i) => String(i));
  const docs = ids.length ? await generatedDocuments.find({ orgId: session.orgId, "storageReference.objectId": { $in: ids }, deletedAt: null }).toArray() : [];
  const out = [];
  for (const d of docs) {
    const delivery = await documentDeliveries.findOne({ orgId: session.orgId, documentId: d._id, roomId: room._id });
    if (!delivery || delivery.status !== "ACTIVE" || !DELIVERABLE.includes(d.status)) continue;
    out.push({ objectId: d.storageReference.objectId, documentNumber: d.documentNumber, documentType: getDocumentType(d.documentType)?.label, documentVersion: d.documentVersion, finalizedAt: d.finalizedAt, documentHash: d.documentHash, pages: d.pageCount });
  }
  return { documents: out };
}

export { i18nLabel };
