// src/lib/attachments.js
//
// Shared helper for the `attachments` collection — used by both Finance
// (expense receipts) and HR (employee documents). Deliberately its own
// collection, not a reuse of org_documents (see orgs.js's header comment
// on why: mandatory projectId, department/project-based permission model,
// too foundational/heavily-depended-on to risk bending for this).
//
// Reuses the SAME client-side encrypt/shard/pin pipeline every other
// document upload in this app already uses (business/page.js's
// encryptData + /api/upload) — the client encrypts and pins to IPFS
// exactly as before, this just records the resulting shard CIDs against
// a different, simpler metadata shape afterward. No on-chain registration
// for attachments in this testnet-scope pass (see the plan's scope-trim
// notes) — just the real encrypted-shard pointers.

import { getOrgCollections, toObjectId } from "./orgs.js";

export function serializeAttachment(a) {
  return {
    id: a._id.toString(), orgId: a.orgId.toString(), departmentId: a.departmentId.toString(),
    relatedRecordType: a.relatedRecordType, relatedRecordId: a.relatedRecordId.toString(),
    filename: a.filename, sizeBytes: a.sizeBytes, uploadedByEmail: a.uploadedByEmail, createdAt: a.createdAt,
  };
}

export async function createAttachment({ orgId, departmentId, relatedRecordType, relatedRecordId, filename, fileHash, sizeBytes, cidAlpha, cidBeta, uploadedByEmail }) {
  const { attachments } = await getOrgCollections();
  const now = new Date().toISOString();
  const result = await attachments.insertOne({
    orgId: toObjectId(orgId), departmentId: toObjectId(departmentId), relatedRecordType,
    relatedRecordId: toObjectId(relatedRecordId), filename, fileHash, sizeBytes, cidAlpha, cidBeta,
    uploadedByEmail, createdAt: now, deletedAt: null,
  });
  return { _id: result.insertedId, orgId: toObjectId(orgId), departmentId: toObjectId(departmentId), relatedRecordType, relatedRecordId: toObjectId(relatedRecordId), filename, sizeBytes, uploadedByEmail, createdAt: now };
}

export async function listAttachmentsForRecord({ orgId, relatedRecordType, relatedRecordId }) {
  const { attachments } = await getOrgCollections();
  return attachments
    .find({ orgId: toObjectId(orgId), relatedRecordType, relatedRecordId: toObjectId(relatedRecordId), deletedAt: null })
    .sort({ createdAt: -1 })
    .toArray();
}

/** Only for retrieving a single attachment's shard pointers to decrypt —
 *  callers must already have verified the caller's access to the parent
 *  record before calling this. */
export async function getAttachmentForRetrieval({ orgId, attachmentId }) {
  const { attachments } = await getOrgCollections();
  return attachments.findOne({ _id: toObjectId(attachmentId), orgId: toObjectId(orgId), deletedAt: null });
}
