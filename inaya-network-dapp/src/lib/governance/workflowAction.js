// src/lib/governance/workflowAction.js
//
// The `action.file_governance` workflow node (Competitive Expansion SOW, WF-FILE actions). Runs as the workflow's owner, so every operation
// goes through the same permission checks a person would hit. Operations are deliberately small and reversible:
//   classify       run the published classification rules on a document (suggest or apply, per rule)
//   set_metadata   set metadata fields
//   revoke_shares  revoke every active share link of a document (needs Manage)
//   lock / unlock  take or release the document's edit lock as the workflow owner (needs Edit); the lease is short and expires on its own
//   set_retention  set the document's retention class (standard, extended, permanent, short)
// Nothing here deletes, quarantines or moves data.

import { ObjectId } from "mongodb";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { requireDocumentAccess } from "../document-permissions.js";
import { classifyDocument } from "./classification.js";
import { setDocumentMetadata } from "./metadata.js";
import { logOrgActivity } from "../org-activity-log.js";

export const FILE_OPERATIONS = ["classify", "set_metadata", "revoke_shares", "lock", "unlock", "set_retention"];
export const RETENTION_CLASSES = ["standard", "extended", "permanent", "short"];

export async function runFileGovernanceAction({ orgId, membership, email, cfg }) {
  const documentId = String(cfg.documentId || "");
  if (!/^[0-9a-f]{24}$/.test(documentId)) throw Object.assign(new Error("documentId is not valid."), { retryable: false, code: "BAD_INPUT" });
  if (cfg.operation === "classify") { const r = await classifyDocument({ orgId, documentId, membership, email, source: "workflow" }); return { operation: "classify", documentId, proposed: r.proposed, applied: r.applied, suggested: r.suggested, blockedBy: r.blockedBy || null }; }
  if (cfg.operation === "set_metadata") { const r = await setDocumentMetadata({ orgId, documentId, membership, email, values: cfg.values || {} }); return { operation: "set_metadata", documentId, changed: r.changed }; }
  if (cfg.operation === "set_retention") {
    if (!RETENTION_CLASSES.includes(cfg.retentionClass)) throw Object.assign(new Error(`retentionClass must be one of ${RETENTION_CLASSES.join(", ")}.`), { retryable: false, code: "BAD_INPUT" });
    const r = await setDocumentMetadata({ orgId, documentId, membership, email, values: { retention_class: cfg.retentionClass } }); return { operation: "set_retention", documentId, retentionClass: cfg.retentionClass, changed: r.changed };
  }
  if (cfg.operation === "lock" || cfg.operation === "unlock") {
    const access = await requireDocumentAccess({ orgId, documentId, membership, email, minLevel: "EDIT" }); if (access.error) throw Object.assign(new Error(access.error), { retryable: false, code: "FORBIDDEN" });
    const L = await import("../filelocks.js");
    if (cfg.operation === "lock") { const lock = await L.acquireLock({ orgId, documentId, actorEmail: email, leaseMinutes: Math.min(Math.max(Number(cfg.leaseMinutes) || 30, 1), 240), reason: "workflow" }); return { operation: "lock", documentId, locked: true, expiresAt: lock?.lock?.expiresAt || lock?.expiresAt || null }; }
    await L.releaseLock({ orgId, documentId, actorEmail: email, membership }); return { operation: "unlock", documentId, locked: false };
  }
  if (cfg.operation === "revoke_shares") {
    const access = await requireDocumentAccess({ orgId, documentId, membership, email, minLevel: "MANAGE" }); if (access.error) throw Object.assign(new Error(access.error), { retryable: false, code: "FORBIDDEN" });
    const { documentShares } = await getOrgCollections(); const at = new Date().toISOString();
    const r = await documentShares.updateMany({ orgId: toObjectId(orgId), documentId: new ObjectId(documentId), revokedAt: null }, { $set: { revokedAt: at, revokedBy: `workflow:${email}` } });
    await logOrgActivity({ orgId, recordType: "DOCUMENT", recordId: new ObjectId(documentId), actorEmail: email, action: "SHARES_REVOKED_BY_WORKFLOW", previousState: null, newState: null, metadata: { count: r.modifiedCount } }).catch(() => {});
    return { operation: "revoke_shares", documentId, revoked: r.modifiedCount };
  }
  throw Object.assign(new Error(`operation must be one of ${FILE_OPERATIONS.join(", ")}.`), { retryable: false, code: "BAD_INPUT" });
}
