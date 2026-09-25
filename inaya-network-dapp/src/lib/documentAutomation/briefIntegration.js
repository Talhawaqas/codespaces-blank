// src/lib/documentAutomation/briefIntegration.js
//
// Document Automation SOW §31 -- Business Brief / Activity Center /
// trust-health integration. Counts real, already-timestamped
// generatedDocuments rows (same "genuine period counts, no fabricated
// deltas" discipline as the existing sections), and ONLY across documents
// the caller may see (visibility.js), so a brief can never mention a
// document its reader could not open. Nothing here builds a second search
// or activity timeline: it produces bullet strings for the existing ones.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { getAccessibleScope } from "../document-permissions.js";
import { documentVisibilityFilter } from "./visibility.js";

export async function documentAutomationBullets({ orgId, membership, email, sinceIso }) {
  const scope = await getAccessibleScope({ orgId, membership, email });
  const { generatedDocuments } = await getOrgCollections();
  const visible = { orgId: toObjectId(orgId), deletedAt: null, ...documentVisibilityFilter({ membership, email, visibleDepartmentIds: scope.visibleDepartments.map((d) => d._id) }) };
  const count = (extra) => generatedDocuments.countDocuments({ $and: [visible, extra] });
  const [generated, finalized, awaiting, failing, delivered, viewed, voided] = await Promise.all([
    count({ createdAt: { $gte: sinceIso } }),
    count({ finalizedAt: { $gte: sinceIso } }),
    count({ status: "PENDING_APPROVAL" }),
    count({ pipelineState: { $in: ["GENERATION_FAILED", "STORAGE_FAILED", "EVIDENCE_PENDING", "DELIVERY_FAILED"] }, status: { $nin: ["SUPERSEDED", "CANCELLED", "VOID"] } }),
    count({ "delivery.lastDeliveredAt": { $gte: sinceIso } }),
    count({ firstViewedAt: { $gte: sinceIso } }),
    count({ voidedAt: { $gte: sinceIso } }),
  ]);
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const bullets = [];
  if (generated > 0) bullets.push(`${plural(generated, "document")} generated this period, ${finalized} finalized.`);
  else if (finalized > 0) bullets.push(`${plural(finalized, "document")} finalized this period.`);
  if (delivered > 0) bullets.push(`${plural(delivered, "document")} shared securely; ${viewed} opened by a recipient.`);
  if (awaiting > 0) bullets.push(`${plural(awaiting, "document")} awaiting approval.`);
  if (failing > 0) bullets.push(`${plural(failing, "document")} need attention (a storage, evidence or delivery step failed and is being retried).`);
  if (voided > 0) bullets.push(`${plural(voided, "document")} voided this period.`);
  return bullets;
}

/** Org-wide document health, for the trust-health snapshot (manager view). */
export async function documentHealthSnapshot({ orgId }) {
  const { generatedDocuments } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const live = { orgId: orgObjectId, deletedAt: null, status: { $nin: ["SUPERSEDED", "CANCELLED", "VOID", "REJECTED", "EXPIRED"] } };
  const [failed, evidencePending, awaitingApproval, staleApproval] = await Promise.all([
    generatedDocuments.countDocuments({ ...live, pipelineState: { $in: ["GENERATION_FAILED", "STORAGE_FAILED", "DELIVERY_FAILED"] } }),
    generatedDocuments.countDocuments({ ...live, pipelineState: "EVIDENCE_PENDING" }),
    generatedDocuments.countDocuments({ ...live, status: "PENDING_APPROVAL" }),
    generatedDocuments.countDocuments({ ...live, status: "PENDING_APPROVAL", "approval.expiresAt": { $lt: new Date().toISOString() } }),
  ]);
  return { failed, evidencePending, awaitingApproval, staleApproval };
}
