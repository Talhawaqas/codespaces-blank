// src/lib/org-activity-log.js
//
// The generalized, cross-module audit log for Business Operations (Tasks,
// and later CRM/Procurement/Inventory) — a sibling to activity-log.js,
// not a modification of it. document_activity stays exactly as it is
// (document-scoped, untouched, its own existing tests unaffected); this
// is a new, additive collection with a recordType discriminator so an
// org-wide "everything that happened" feed can be built by querying both
// collections and merge-sorting by timestamp, without retrofitting a
// collection three other files and a full test suite already depend on.
//
// Append-only, same discipline as activity-log.js: this is the only code
// path that writes to org_activity, and it only ever inserts. Don't add
// an update/delete path for this collection either.

import { randomUUID } from "node:crypto";
import { getOrgCollections, toObjectId } from "./orgs.js";
import { appendAuditEntry } from "./auditChain.js";

export async function logOrgActivity({ orgId, recordType, recordId, actorEmail, action, previousState, newState, metadata }) {
  const { orgActivity } = await getOrgCollections();
  const event = {
    eventId: randomUUID(),
    orgId: toObjectId(orgId),
    recordType,
    recordId: toObjectId(recordId),
    actorEmail,
    action,
    previousState: previousState ?? null,
    newState: newState ?? null,
    timestamp: new Date().toISOString(),
    metadata: metadata || {},
  };
  await orgActivity.insertOne(event);
  // Best-effort: the human-readable event above is the record of truth for
  // every existing caller/UI; the hash-chained copy is an additive
  // integrity layer, so a chain-append failure (e.g. transient write
  // contention exhausting retries) must never block the actual workflow
  // transition that's already committed.
  try {
    await appendAuditEntry({ orgId, recordType, recordId, actorEmail, action, previousState, newState, metadata });
  } catch (err) {
    console.error("org-activity-log: audit chain append failed:", err.message);
  }
  return event;
}

export async function listOrgActivityForRecord({ orgId, recordType, recordId }) {
  const { orgActivity } = await getOrgCollections();
  return orgActivity
    .find({ orgId: toObjectId(orgId), recordType, recordId: toObjectId(recordId) })
    .sort({ timestamp: -1 })
    .toArray();
}
