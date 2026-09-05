// src/lib/legal-discovery-workflow.js
//
// Healthcare & Legal Expansion SOW, Phase 7 (§11.14-11.15) — discovery /
// eDiscovery foundation. Lifecycle: collection -> review -> tagging
// (responsiveness + privilege) -> production. SOW §11.15 is explicit:
// "Do not claim full eDiscovery certification" — this is a foundation
// (collection metadata, dedup-by-hash, tagging, production package
// references), not a certified eDiscovery platform.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canAccessLegalMatters, canManageLegal } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export const DISCOVERY_STATES = ["COLLECTED", "REVIEW", "TAGGED", "PRODUCED"];

export async function createDiscoveryRequest({ orgId, matterId, requestingParty, respondingParty, scope, actorEmail, membership }) {
  if (!canAccessLegalMatters(membership)) return { error: "You don't have permission to create a discovery request.", status: 403 };
  const { legalDiscovery } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), matterId: toObjectId(matterId), requestingParty, respondingParty, scope: scope || "",
    status: "COLLECTED", documentIds: [], custodians: [],
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await legalDiscovery.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "DISCOVERY", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: "COLLECTED", metadata: { matterId } });
  return { discovery: inserted };
}

/** Adds collected documents by hash — deduplicating against what's
 *  already collected for this request, matching SOW §11.15's "collection,
 *  deduplication, metadata extraction, hashing" list. A document already
 *  present (by documentId) is silently skipped, not re-added. */
export async function addCollectedDocuments({ orgId, discoveryId, documentIds, custodianEmail, actorEmail, membership }) {
  if (!canAccessLegalMatters(membership)) return { error: "You don't have permission to add documents to discovery.", status: 403 };
  const { legalDiscovery } = await getOrgCollections();
  const discovery = await legalDiscovery.findOne({ _id: toObjectId(discoveryId), orgId: toObjectId(orgId) });
  if (!discovery) return { error: "Discovery request not found.", status: 404 };

  const existingIds = new Set(discovery.documentIds.map((id) => id.toString()));
  const newIds = (documentIds || []).map((id) => toObjectId(id)).filter((id) => !existingIds.has(id.toString()));
  if (!newIds.length) return { added: 0, skippedAsDuplicate: (documentIds || []).length };

  const updated = await legalDiscovery.findOneAndUpdate(
    { _id: discovery._id },
    { $addToSet: { documentIds: { $each: newIds }, custodians: custodianEmail }, $set: { updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  await logOrgActivity({ orgId, recordType: "DISCOVERY", recordId: updated._id, actorEmail, action: "DOCUMENTS_ADDED", previousState: null, newState: null, metadata: { added: newIds.length } });
  return { added: newIds.length, discovery: updated };
}

/** Tags a document as responsive/privileged (or not) — a simple metadata
 *  map keyed by documentId on the discovery record itself, not a
 *  separate collection, since tags only ever matter in the context of
 *  one discovery request. */
export async function tagDocument({ orgId, discoveryId, documentId, responsive, privileged, confidential, actorEmail, membership }) {
  if (!canAccessLegalMatters(membership)) return { error: "You don't have permission to tag documents.", status: 403 };
  const { legalDiscovery } = await getOrgCollections();
  const updated = await legalDiscovery.findOneAndUpdate(
    { _id: toObjectId(discoveryId), orgId: toObjectId(orgId) },
    { $set: { [`tags.${documentId}`]: { responsive: !!responsive, privileged: !!privileged, confidential: !!confidential, taggedByEmail: actorEmail, taggedAt: new Date().toISOString() }, status: "REVIEW", updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Discovery request not found.", status: 404 };
  return { discovery: updated };
}

/** Production requires manager authority — this is the step that
 *  actually hands documents to the opposing party, a materially higher-
 *  risk action than tagging. Only documents tagged responsive AND not
 *  privileged are included in the production set — a privileged
 *  document is never included even if also marked responsive. */
export async function produceDiscovery({ orgId, discoveryId, actorEmail, membership }) {
  if (!canManageLegal(membership)) return { error: "Only a legal manager or the owner/admin can produce discovery.", status: 403 };
  const { legalDiscovery } = await getOrgCollections();
  const discovery = await legalDiscovery.findOne({ _id: toObjectId(discoveryId), orgId: toObjectId(orgId) });
  if (!discovery) return { error: "Discovery request not found.", status: 404 };

  const tags = discovery.tags || {};
  const productionSet = discovery.documentIds.filter((id) => {
    const tag = tags[id.toString()];
    return tag?.responsive && !tag?.privileged;
  });

  const updated = await legalDiscovery.findOneAndUpdate(
    { _id: discovery._id },
    { $set: { status: "PRODUCED", productionSet, producedByEmail: actorEmail, producedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  await logOrgActivity({ orgId, recordType: "DISCOVERY", recordId: updated._id, actorEmail, action: "PRODUCED", previousState: discovery.status, newState: "PRODUCED", metadata: { producedCount: productionSet.length } });
  return { discovery: updated };
}
