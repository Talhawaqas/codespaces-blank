// src/lib/nas/evidence.js
//
// Sovereign NAS SOW, Workstreams U and V (evidence and cryptographic proof
// of NAS state). NOT a second audit chain (SOW 5.6/29):
//
//   1. Every consequential NAS operation is written through logOrgActivity,
//      i.e. the organization's existing hash-chained audit trail.
//   2. The audit entry's metadata carries `evidenceHash`, the canonical hash
//      of the evidence row, so the audit chain itself commits to what the row
//      said. A row edited later no longer matches its audit entry, and a
//      forged row has no audit entry at all (verifyNasEvidence catches both).
//   3. The Evidence Graph links the share/appliance (a Business Event
//      subject) to the operation with a typed relationship, so the existing
//      timeline, passport and explain views see NAS activity.
//
// Evidence never stores file plaintext (SOW 28): only ids, hashes, counts,
// states, policy fingerprints and approval references.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";
import { verifyChainIntegrity } from "../auditChain.js";
import { createBusinessEvent, addBusinessEventRelationship } from "../businessEvents.js";
import { canonicalHash } from "../documentAutomation/manifest.js";
import { SYNTHETIC_OWNER } from "./common.js";

/** The SOW's Workstream U vocabulary, plus the operational events this
 *  implementation also records. */
export const NAS_EVENTS = [
  "SHARE_CREATED", "SHARE_PERMISSION_CHANGED", "USER_GRANTED_ACCESS", "USER_REVOKED_ACCESS",
  "FILE_DELETED", "FILE_RESTORED", "SNAPSHOT_CREATED", "SNAPSHOT_LOCKED",
  "BACKUP_STARTED", "BACKUP_VERIFIED", "BACKUP_FAILED",
  "REPLICATION_STARTED", "REPLICATION_COMPLETED", "REPLICATION_FAILED",
  "RECOVERY_STARTED", "RECOVERY_COMPLETED", "RECOVERY_FAILED",
  "THREAT_DETECTED", "PROTECTION_TRIGGERED", "POLICY_CHANGED",
  "REMOTE_ACCESS_ENABLED", "REMOTE_ACCESS_DISABLED",
  // additional operational events
  "SNAPSHOT_DELETED", "SNAPSHOT_DELETE_DENIED", "SNAPSHOT_RELEASED", "QUOTA_CHANGED", "QUOTA_STATE_CHANGED",
  "SHARE_LOCKDOWN", "SHARE_LOCKDOWN_LIFTED", "STATE_COMMITTED", "UPDATE_APPLIED", "UPDATE_ROLLED_BACK",
  "TIER_PROPOSED", "TIER_APPLIED", "TIER_RECALLED", "FAILOVER_PROMOTED", "POOL_CREATED", "POOL_DEGRADED", "POOL_REBUILT",
];

// Events that become Evidence Graph relationships (the rest live in the
// activity/audit trail and the evidence collection).
const GRAPH_RELATIONSHIP = {
  BACKUP_VERIFIED: "PROVEN_BY", RECOVERY_COMPLETED: "PROVEN_BY", REPLICATION_COMPLETED: "PROVEN_BY",
  SNAPSHOT_LOCKED: "PROVEN_BY", SNAPSHOT_CREATED: "DERIVED_FROM", FILE_RESTORED: "DERIVED_FROM",
  THREAT_DETECTED: "CHECKED_BY", PROTECTION_TRIGGERED: "EXECUTED_AS", STATE_COMMITTED: "PROVEN_BY", FAILOVER_PROMOTED: "EXECUTED_AS",
  SHARE_PERMISSION_CHANGED: "REFERENCES", USER_REVOKED_ACCESS: "REFERENCES",
};

function rowFingerprint(row) {
  const { _id, rowHash, auditRef, ...content } = row;
  return canonicalHash(content);
}

/**
 * Records one NAS evidence event. Never throws to the caller: the operation
 * itself has already happened, so a recording failure is returned as
 * { ok: false } and logged, not allowed to undo or hide the operation.
 */
export async function recordNasEvidence({
  orgId, applianceId, subjectType = "NAS_SHARE", subjectId, action, actorEmail, actorType = "human", result = "OK",
  previousState = null, newState = null, integrityHash = null, policy = null, approval = null, data = {}, graph = true,
}) {
  try {
    if (!NAS_EVENTS.includes(action)) return { ok: false, error: `Unknown NAS event ${action}` };
    const { nasEvidence } = await getOrgCollections();
    const _id = toObjectId(subjectId ? subjectId : applianceId);
    const now = new Date().toISOString();
    const row = {
      orgId: toObjectId(orgId), applianceId: applianceId ? toObjectId(applianceId) : null, subjectType, subjectId: subjectId ? toObjectId(subjectId) : null,
      action, result, actor: { email: actorEmail || "system", type: actorType }, previousState, newState, integrityHash,
      policy: policy || null, approval: approval || null, data: JSON.parse(JSON.stringify(data || {})), createdAt: now,
    };
    row.rowHash = rowFingerprint(row);
    const inserted = await nasEvidence.insertOne(row);
    const event = await logOrgActivity({
      orgId, recordType: subjectType, recordId: _id, actorEmail: actorEmail || "system", action, previousState, newState,
      metadata: { evidenceId: String(inserted.insertedId), evidenceHash: row.rowHash, result, integrityHash, applianceId: applianceId ? String(applianceId) : null, actorType, ...(policy ? { policy: canonicalHash(policy) } : {}) },
    });
    if (event.auditChain) await nasEvidence.updateOne({ _id: inserted.insertedId }, { $set: { auditRef: event.auditChain } });
    let graphResult = null;
    if (graph && GRAPH_RELATIONSHIP[action] && subjectType === "NAS_SHARE" && subjectId) {
      graphResult = await linkNasGraph({ orgId, shareId: subjectId, evidenceId: inserted.insertedId, type: GRAPH_RELATIONSHIP[action], note: `${action}${integrityHash ? " " + String(integrityHash).slice(0, 16) : ""}`, actorEmail });
    }
    return { ok: true, evidenceId: String(inserted.insertedId), rowHash: row.rowHash, auditRef: event.auditChain || null, graph: graphResult };
  } catch (err) {
    console.error("recordNasEvidence failed (non-fatal):", err.message);
    return { ok: false, error: err.message };
  }
}

/** Ensures the share is an Evidence Graph subject and adds a relationship. */
export async function linkNasGraph({ orgId, shareId, evidenceId, type, note, actorEmail }) {
  try {
    const { businessEvents } = await getOrgCollections();
    let event = await businessEvents.findOne({ orgId: toObjectId(orgId), subjectType: "NAS_SHARE", subjectId: toObjectId(shareId), deletedAt: null });
    if (!event) {
      const created = await createBusinessEvent({ orgId, subjectType: "NAS_SHARE", subjectId: shareId, membership: SYNTHETIC_OWNER, actorEmail: actorEmail || "system", relationships: [] });
      if (created.error) return { ok: false, error: created.error };
      event = created.event;
    }
    await addBusinessEventRelationship({ orgId, eventId: String(event._id), membership: SYNTHETIC_OWNER, actorEmail: actorEmail || "system", type, targetType: "NAS_EVIDENCE", targetId: String(evidenceId), note });
    return { ok: true, eventId: String(event._id) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Lists evidence for a share/appliance, newest first. */
export async function listNasEvidence({ orgId, applianceId, shareId, action, limit = 100 }) {
  const { nasEvidence } = await getOrgCollections();
  const q = { orgId: toObjectId(orgId) };
  if (applianceId) q.applianceId = toObjectId(applianceId);
  if (shareId) q.subjectId = toObjectId(shareId);
  if (action) q.action = action;
  return nasEvidence.find(q).sort({ createdAt: -1 }).limit(Math.min(limit, 500)).toArray();
}

/**
 * Independently verifies NAS evidence (SOW 28/29 "can an auditor check it?"):
 *  - each row's content still hashes to its rowHash;
 *  - the audit-chain entry it references exists, matches the row, and
 *    committed the same evidenceHash;
 *  - the whole audit chain is intact.
 */
export async function verifyNasEvidence({ orgId, applianceId, shareId, limit = 500 }) {
  const { nasEvidence, auditChainEntries } = await getOrgCollections();
  const q = { orgId: toObjectId(orgId) };
  if (applianceId) q.applianceId = toObjectId(applianceId);
  if (shareId) q.subjectId = toObjectId(shareId);
  const rows = await nasEvidence.find(q).sort({ createdAt: -1 }).limit(limit).toArray();
  const problems = [];
  for (const row of rows) {
    if (rowFingerprint(row) !== row.rowHash) { problems.push({ evidenceId: String(row._id), problem: "ROW_ALTERED", action: row.action }); continue; }
    if (!row.auditRef) { problems.push({ evidenceId: String(row._id), problem: "NO_AUDIT_ENTRY", action: row.action }); continue; }
    const entry = await auditChainEntries.findOne({ orgId: row.orgId, seq: row.auditRef.seq });
    if (!entry || entry.entryHash !== row.auditRef.entryHash) { problems.push({ evidenceId: String(row._id), problem: "AUDIT_ENTRY_MISSING_OR_ALTERED", action: row.action }); continue; }
    if (entry.action !== row.action || entry.metadata?.evidenceHash !== row.rowHash) problems.push({ evidenceId: String(row._id), problem: "AUDIT_ENTRY_DOES_NOT_MATCH_ROW", action: row.action });
  }
  const chain = await verifyChainIntegrity(orgId).catch((e) => ({ valid: false, reason: e.message }));
  return { verified: problems.length === 0 && chain.valid, rowsChecked: rows.length, problems, auditChain: { valid: chain.valid, entries: chain.count ?? null, reason: chain.reason || null } };
}
