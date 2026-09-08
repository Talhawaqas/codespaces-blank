// src/lib/government-cases.js
//
// Government & Public Sector Sovereign OS SOW, Phase 1 (§4 "Case
// Management"). Same STATE + TRANSITIONS map + atomic findOneAndUpdate
// template every workflow in this codebase follows (incidents.js is the
// clearest precedent). Optionally links to a citizen record — a case can
// exist without one yet (e.g. an intake case not yet matched to a citizen
// record) — and to Documents/Evidence via attachmentIds, same shape as
// incidents.js's affectedRecordIds.
//
// Every state change goes through org-activity-log.js's logOrgActivity
// AND government-audit.js's logCitizenRecordAccess (when linked to a
// citizen record) -- no parallel audit system, matching every prior
// module's discipline.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canAccessGovernment, canManageGovernment, isCitizenRecordAssignee } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";
import { logCitizenRecordAccess } from "./government-audit.js";
import { createNotification } from "./notifications.js";

export const CASE_CATEGORIES = [
  "citizen_services", "regulatory", "procurement_dispute", "records_request",
  "internal_investigation", "interdepartmental", "policy_exception", "other",
];

export const CASE_PRIORITIES = ["low", "medium", "high", "urgent"];

export const CASE_STATES = ["OPEN", "ASSIGNED", "IN_PROGRESS", "PENDING_REVIEW", "RESOLVED", "CLOSED"];

export const CASE_TRANSITIONS = {
  assign: { from: "OPEN", to: "ASSIGNED", activityAction: "ASSIGNED" },
  start: { from: "ASSIGNED", to: "IN_PROGRESS", activityAction: "STARTED" },
  submitForReview: { from: "IN_PROGRESS", to: "PENDING_REVIEW", activityAction: "SUBMITTED_FOR_REVIEW" },
  returnToProgress: { from: "PENDING_REVIEW", to: "IN_PROGRESS", activityAction: "RETURNED_TO_PROGRESS" },
  resolve: { from: "PENDING_REVIEW", to: "RESOLVED", activityAction: "RESOLVED" },
  close: { from: "RESOLVED", to: "CLOSED", activityAction: "CLOSED" },
  reopen: { from: "RESOLVED", to: "IN_PROGRESS", activityAction: "REOPENED" },
};

async function assertCitizenRecordAccessIfLinked({ orgId, citizenRecordId, membership }) {
  if (!citizenRecordId) return { ok: true };
  if (canManageGovernment(membership)) return { ok: true };
  const { citizenRecordAssignments } = await getOrgCollections();
  const assignments = await citizenRecordAssignments.find({ orgId: toObjectId(orgId), recordId: toObjectId(citizenRecordId) }).toArray();
  if (!isCitizenRecordAssignee(membership, citizenRecordId, assignments)) {
    return { error: "This case is linked to a citizen record you're not assigned to.", status: 403 };
  }
  return { ok: true };
}

export async function createCase({ orgId, category, priority, title, description, department, citizenRecordId, attachmentIds, ownerEmail, actorEmail, membership }) {
  if (!canAccessGovernment(membership)) return { error: "You don't have permission to open a case.", status: 403 };
  if (!CASE_CATEGORIES.includes(category)) return { error: `Unknown case category "${category}".`, status: 400 };
  if (!CASE_PRIORITIES.includes(priority)) return { error: `Unknown priority "${priority}".`, status: 400 };
  if (!title?.trim()) return { error: "A title is required.", status: 400 };

  const linkCheck = await assertCitizenRecordAccessIfLinked({ orgId, citizenRecordId, membership });
  if (linkCheck.error) return linkCheck;

  const { governmentCases } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const now = new Date().toISOString();
  const doc = {
    orgId: orgObjectId,
    category, priority, title: title.trim(), description: description || "",
    department: department || null,
    citizenRecordId: citizenRecordId ? toObjectId(citizenRecordId) : null,
    attachmentIds: attachmentIds || [],
    status: "OPEN",
    ownerEmail: ownerEmail || null,
    timeline: [{ event: "OPENED", actorEmail, at: now }],
    createdByEmail: actorEmail,
    createdAt: now, updatedAt: now, resolvedAt: null, closedAt: null,
  };
  const result = await governmentCases.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "GOVERNMENT_CASE", recordId: inserted._id, actorEmail, action: "OPENED", previousState: null, newState: "OPEN", metadata: { category, priority } });
  if (citizenRecordId) await logCitizenRecordAccess({ orgId, recordId: citizenRecordId, actorEmail, action: "CASE_OPENED", metadata: { caseId: inserted._id.toString() } });

  return { case: inserted };
}

export async function transitionCase({ orgId, caseId, action, ownerEmail, actorEmail, membership, note }) {
  if (!canAccessGovernment(membership)) return { error: "You don't have permission to update this case.", status: 403 };
  const definition = CASE_TRANSITIONS[action];
  if (!definition) return { error: `Unknown action "${action}".`, status: 400 };

  const { governmentCases } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const caseObjectId = toObjectId(caseId);
  const now = new Date().toISOString();

  const setDoc = { status: definition.to, updatedAt: now };
  if (action === "assign" && ownerEmail) setDoc.ownerEmail = ownerEmail;
  if (definition.to === "RESOLVED") setDoc.resolvedAt = now;
  if (definition.to === "CLOSED") setDoc.closedAt = now;

  const updated = await governmentCases.findOneAndUpdate(
    { _id: caseObjectId, orgId: orgObjectId, status: definition.from },
    { $set: setDoc, $push: { timeline: { event: definition.activityAction, actorEmail, at: now, note: note || null } } },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await governmentCases.findOne({ _id: caseObjectId, orgId: orgObjectId });
    if (!current) return { error: "Case not found.", status: 404 };
    return { error: `This case isn't in ${definition.from} state (it's currently ${current.status}).`, status: 409 };
  }

  await logOrgActivity({ orgId, recordType: "GOVERNMENT_CASE", recordId: caseObjectId, actorEmail, action: definition.activityAction, previousState: definition.from, newState: definition.to, metadata: note ? { note } : {} });
  if (updated.citizenRecordId) await logCitizenRecordAccess({ orgId, recordId: updated.citizenRecordId, actorEmail, action: `CASE_${definition.activityAction}`, metadata: { caseId: caseObjectId.toString() } });

  if (definition.to === "ASSIGNED" && updated.ownerEmail) {
    await createNotification({
      scope: "org", orgId, targetEmail: updated.ownerEmail, category: "case", severity: "info",
      type: "case_assigned", title: `Case assigned: ${updated.title}`, body: updated.description || "",
      sourceModule: "government-cases", sourceId: updated._id, actionUrl: "/business?view=government",
      dedupeKey: `${orgId}:case_assigned:${updated._id}`,
    }).catch((err) => console.error("government-cases: notification failed (non-fatal):", err.message));
  }

  return { case: updated };
}

export async function getCase({ orgId, caseId, membership }) {
  const { governmentCases } = await getOrgCollections();
  const record = await governmentCases.findOne({ _id: toObjectId(caseId), orgId: toObjectId(orgId) });
  if (!record) return { error: "Case not found.", status: 404 };
  const linkCheck = await assertCitizenRecordAccessIfLinked({ orgId, citizenRecordId: record.citizenRecordId, membership });
  if (linkCheck.error) return linkCheck;
  return { case: record };
}

export async function listCases(orgId, { status, category, department, membership } = {}) {
  if (!canAccessGovernment(membership)) return { error: "You don't have Government OS access.", status: 403 };
  const { governmentCases } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (status) query.status = status;
  if (category) query.category = category;
  if (department) query.department = department;
  // List-level: org managers see everything; staff see only cases NOT
  // linked to a citizen record they aren't assigned to (a case linked to
  // a record they can't access is filtered out of their own list, same
  // "need-to-know" principle as requireCitizenRecordAccess).
  const cases = await governmentCases.find(query).sort({ createdAt: -1 }).toArray();
  if (canManageGovernment(membership)) return { cases };

  const { citizenRecordAssignments } = await getOrgCollections();
  const assignments = await citizenRecordAssignments.find({ orgId: toObjectId(orgId), email: membership.email }).toArray();
  const assignedRecordIds = new Set(assignments.map((a) => a.recordId.toString()));
  const visible = cases.filter((c) => !c.citizenRecordId || assignedRecordIds.has(c.citizenRecordId.toString()));
  return { cases: visible };
}
