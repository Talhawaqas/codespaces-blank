// src/lib/evidence.js
//
// Institutional Trust Infrastructure SOW, Phase 2 — a thin, read-only
// consolidation over evidence that already exists and is already being
// written correctly: org-activity-log.js (the human-readable who/what/
// when/result record) and auditChain.js (the tamper-evident hash-linked
// overlay on top of it). This file adds no new write path and no new
// permission logic of its own — every function here is a read/merge over
// data another module already produced under its own, already-tested
// rules.
//
// EXPORT SHAPE: exportEvidencePackage() intentionally matches
// api/orgs/audit/export/route.js's existing JSON shape exactly (same
// field set, same string-or-empty recordId serialization) so a package
// produced here, from api/orgs/audit/export, or from the public Trust
// Center's verifier (Phase 1) are all interchangeable -- one canonical
// "evidence package" format across this SOW, not three similar-but-
// slightly-different ones.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { listOrgActivityForRecord } from "./org-activity-log.js";
import { verifyChainIntegrity } from "./auditChain.js";

/** Chronological evidence for one record: the human-readable org_activity
 *  entries plus, where applicable, the lifecycle of any AI action request
 *  proposed against that same record (proposed/approved/rejected/
 *  cancelled/executed/expired) -- so "who did what, with what
 *  authorization" reads as one timeline instead of two separately-queried
 *  logs. */
export async function getEvidenceTrail({ orgId, recordType, recordId }) {
  const activity = await listOrgActivityForRecord({ orgId, recordType, recordId });

  const { aiActionRequests } = await getOrgCollections();
  const linkedRequests = await aiActionRequests
    .find({ orgId: toObjectId(orgId), targetRecordType: recordType, targetRecordId: toObjectId(recordId) })
    .toArray();

  const requestEvents = linkedRequests.flatMap((r) => {
    const events = [{ timestamp: r.requestedAt, action: "AI_ACTION_PROPOSED", actorEmail: r.requestedByEmail, detail: r.requestedContextSummary, source: "ai-action-request" }];
    if (r.reviewedAt) events.push({ timestamp: r.reviewedAt, action: `AI_ACTION_${r.status}`, actorEmail: r.reviewedByEmail, detail: r.reviewNote, source: "ai-action-request" });
    if (r.executedAt) events.push({ timestamp: r.executedAt, action: "AI_ACTION_EXECUTED", actorEmail: r.reviewedByEmail, detail: null, source: "ai-action-request" });
    return events;
  });

  const trail = [
    ...activity.map((e) => ({ timestamp: e.timestamp, action: e.action, actorEmail: e.actorEmail, previousState: e.previousState, newState: e.newState, detail: e.metadata, source: "org-activity" })),
    ...requestEvents,
  ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return { recordType, recordId: recordId.toString?.() || recordId, count: trail.length, trail };
}

/** Thin wrapper -- exists so callers of the "evidence" concept (Phase 1's
 *  Trust Center language, Phase 4's public API) don't need to know this is
 *  literally the audit chain underneath. */
export async function verifyOrgEvidenceIntegrity(orgId) {
  return verifyChainIntegrity(orgId);
}

/** Same shape as api/orgs/audit/export/route.js's JSON export -- see this
 *  file's header comment. Optionally scoped to one record. */
export async function exportEvidencePackage(orgId, { recordType, recordId } = {}) {
  const { auditChainEntries } = await getOrgCollections();
  const filter = { orgId: toObjectId(orgId) };
  if (recordType) filter.recordType = recordType;
  if (recordId) filter.recordId = recordId.toString?.() || recordId;

  const entries = await auditChainEntries.find(filter).sort({ seq: 1 }).toArray();
  const rows = entries.map((e) => ({
    seq: e.seq, prevHash: e.prevHash, entryHash: e.entryHash,
    recordType: e.recordType, recordId: e.recordId?.toString() || "", actorEmail: e.actorEmail || "",
    action: e.action, previousState: e.previousState, newState: e.newState,
    timestamp: e.timestamp, metadata: e.metadata,
  }));
  return { orgId: orgId.toString?.() || orgId, count: rows.length, entries: rows };
}
