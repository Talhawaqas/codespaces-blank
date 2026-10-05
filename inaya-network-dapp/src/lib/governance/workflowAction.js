// src/lib/governance/workflowAction.js
//
// The `action.file_governance` workflow node (Competitive Expansion SOW, WF-FILE actions). Runs as the workflow's owner, so every operation
// goes through the same permission checks a person would hit. Operations are deliberately small and reversible:
//   classify       run the published classification rules on a document (suggest or apply, per rule)
//   set_metadata   set metadata fields
//   revoke_shares  revoke every active share link of a document (needs Manage)
// Nothing here deletes, quarantines or moves data.

import { ObjectId } from "mongodb";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { requireDocumentAccess } from "../document-permissions.js";
import { classifyDocument } from "./classification.js";
import { setDocumentMetadata } from "./metadata.js";
import { logOrgActivity } from "../org-activity-log.js";

export const FILE_OPERATIONS = ["classify", "set_metadata", "revoke_shares"];

export async function runFileGovernanceAction({ orgId, membership, email, cfg }) {
  const documentId = String(cfg.documentId || "");
  if (!/^[0-9a-f]{24}$/.test(documentId)) throw Object.assign(new Error("documentId is not valid."), { retryable: false, code: "BAD_INPUT" });
  if (cfg.operation === "classify") { const r = await classifyDocument({ orgId, documentId, membership, email, source: "workflow" }); return { operation: "classify", documentId, proposed: r.proposed, applied: r.applied, suggested: r.suggested, blockedBy: r.blockedBy || null }; }
  if (cfg.operation === "set_metadata") { const r = await setDocumentMetadata({ orgId, documentId, membership, email, values: cfg.values || {} }); return { operation: "set_metadata", documentId, changed: r.changed }; }
  if (cfg.operation === "revoke_shares") {
    const access = await requireDocumentAccess({ orgId, documentId, membership, email, minLevel: "MANAGE" }); if (access.error) throw Object.assign(new Error(access.error), { retryable: false, code: "FORBIDDEN" });
    const { documentShares } = await getOrgCollections(); const at = new Date().toISOString();
    const r = await documentShares.updateMany({ orgId: toObjectId(orgId), documentId: new ObjectId(documentId), revokedAt: null }, { $set: { revokedAt: at, revokedBy: `workflow:${email}` } });
    await logOrgActivity({ orgId, recordType: "DOCUMENT", recordId: new ObjectId(documentId), actorEmail: email, action: "SHARES_REVOKED_BY_WORKFLOW", previousState: null, newState: null, metadata: { count: r.modifiedCount } }).catch(() => {});
    return { operation: "revoke_shares", documentId, revoked: r.modifiedCount };
  }
  throw Object.assign(new Error(`operation must be one of ${FILE_OPERATIONS.join(", ")}.`), { retryable: false, code: "BAD_INPUT" });
}
