// src/lib/legal-evidence.js
//
// Healthcare & Legal Expansion SOW, Phase 7 (§11.11) — evidence vault.
// The evidence record itself is metadata only + a documentId pointer into
// the existing org_documents (same encrypt/shard/pin pipeline every other
// document uses) — this is NOT a new storage system, matching the
// storage-indirection principle used for clinical records in Phase 2.
// Every acquisition/custody event goes through legal-custody.js's
// recordCustodyEvent, never a direct field mutation.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canAccessLegalMatters } from "./orgGates.js";
import { recordCustodyEvent } from "./legal-custody.js";

export async function acquireEvidence({ orgId, matterId, source, custodianEmail, description, acquisitionInfo, hash, documentId, actorEmail, membership }) {
  if (!canAccessLegalMatters(membership)) return { error: "You don't have permission to add evidence.", status: 403 };
  const { legalEvidence } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), matterId: toObjectId(matterId), source, custodian: custodianEmail || actorEmail,
    description: description || "", acquisitionInfo: acquisitionInfo || {}, hash: hash || null,
    documentId: documentId ? toObjectId(documentId) : null, classification: "EVIDENCE",
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await legalEvidence.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await recordCustodyEvent({ orgId, evidenceId: inserted._id, action: "ACQUIRED", actorEmail, source, hash, reason: "Initial acquisition" });
  if (documentId) await recordCustodyEvent({ orgId, evidenceId: inserted._id, action: "UPLOADED", actorEmail, destination: "org_documents", hash });
  return { evidence: inserted };
}

export async function transferEvidence({ orgId, evidenceId, destination, reason, actorEmail, membership }) {
  if (!canAccessLegalMatters(membership)) return { error: "You don't have permission to transfer evidence.", status: 403 };
  const { legalEvidence } = await getOrgCollections();
  const evidence = await legalEvidence.findOne({ _id: toObjectId(evidenceId), orgId: toObjectId(orgId) });
  if (!evidence) return { error: "Evidence not found.", status: 404 };
  await recordCustodyEvent({ orgId, evidenceId: evidence._id, action: "TRANSFERRED", actorEmail, source: evidence.custodian, destination, reason });
  await legalEvidence.updateOne({ _id: evidence._id }, { $set: { custodian: destination, updatedAt: new Date().toISOString() } });
  return { transferred: true };
}

export async function listEvidenceForMatter(orgId, matterId) {
  const { legalEvidence } = await getOrgCollections();
  return legalEvidence.find({ orgId: toObjectId(orgId), matterId: toObjectId(matterId) }).sort({ createdAt: -1 }).toArray();
}
