// src/lib/compliance-controls.js
//
// Financial Services & Regulated Enterprise SOW, Phase 4 (§46) — the
// Compliance Control Library. A control is org-authored (unlike the
// static framework/requirement catalog in compliance-frameworks.js) and
// links to zero or more framework requirements — a single control may
// satisfy multiple requirements, and a single requirement may be
// addressed by multiple controls (§50's Risk & Control Matrix), so
// linkedRequirements is a plain array on the control doc rather than a
// join collection, matching health_care_team_assignments-style
// simplicity over premature normalization for what's expected to be a
// small per-org list.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canManageCompliance } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export const CONTROL_STATUSES = ["draft", "active", "retired"];
export const CONTROL_EFFECTIVENESS = ["effective", "partially_effective", "ineffective", "not_tested"];

export async function createControl({ orgId, name, description, objective, ownerEmail, reviewer, frequency, evidenceType, automationLevel, actorEmail, membership }) {
  if (!canManageCompliance(membership)) return { error: "Only a compliance manager or org owner/admin can create a control.", status: 403 };
  if (!name?.trim()) return { error: "A control name is required.", status: 400 };

  const { complianceControls } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId),
    name: name.trim(),
    description: description || "",
    objective: objective || "",
    ownerEmail: ownerEmail || actorEmail,
    reviewer: reviewer || null,
    frequency: frequency || null,
    evidenceType: evidenceType || null,
    automationLevel: automationLevel || "manual",
    status: "draft",
    effectiveness: "not_tested",
    linkedRequirements: [], // [{frameworkId, requirementId}]
    exceptions: [],
    lastTestedAt: null,
    nextTestDueAt: null,
    createdByEmail: actorEmail,
    createdAt: now, updatedAt: now,
  };
  const result = await complianceControls.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "COMPLIANCE_CONTROL", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: "draft", metadata: { name: doc.name } });
  return { control: inserted };
}

export async function updateControl({ orgId, controlId, updates, actorEmail, membership }) {
  if (!canManageCompliance(membership)) return { error: "Only a compliance manager or org owner/admin can update a control.", status: 403 };
  if (updates.status && !CONTROL_STATUSES.includes(updates.status)) return { error: `Unknown control status "${updates.status}".`, status: 400 };
  if (updates.effectiveness && !CONTROL_EFFECTIVENESS.includes(updates.effectiveness)) return { error: `Unknown effectiveness "${updates.effectiveness}".`, status: 400 };

  const { complianceControls } = await getOrgCollections();
  const allowed = ["name", "description", "objective", "ownerEmail", "reviewer", "frequency", "evidenceType", "automationLevel", "status", "effectiveness", "nextTestDueAt"];
  const setDoc = { updatedAt: new Date().toISOString() };
  for (const key of allowed) if (updates[key] !== undefined) setDoc[key] = updates[key];

  const updated = await complianceControls.findOneAndUpdate(
    { _id: toObjectId(controlId), orgId: toObjectId(orgId) },
    { $set: setDoc },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Control not found.", status: 404 };

  await logOrgActivity({ orgId, recordType: "COMPLIANCE_CONTROL", recordId: updated._id, actorEmail, action: "UPDATED", previousState: null, newState: updated.status, metadata: { fields: Object.keys(setDoc) } });
  return { control: updated };
}

export async function linkControlToRequirement({ orgId, controlId, frameworkId, requirementId, actorEmail, membership }) {
  if (!canManageCompliance(membership)) return { error: "Only a compliance manager or org owner/admin can link a control.", status: 403 };
  const { complianceControls } = await getOrgCollections();
  const updated = await complianceControls.findOneAndUpdate(
    { _id: toObjectId(controlId), orgId: toObjectId(orgId), "linkedRequirements.frameworkId": { $ne: frameworkId }, "linkedRequirements.requirementId": { $ne: requirementId } },
    { $push: { linkedRequirements: { frameworkId, requirementId } }, $set: { updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) {
    const existing = await complianceControls.findOne({ _id: toObjectId(controlId), orgId: toObjectId(orgId) });
    if (!existing) return { error: "Control not found.", status: 404 };
    return { control: existing }; // already linked — idempotent no-op, not an error
  }
  await logOrgActivity({ orgId, recordType: "COMPLIANCE_CONTROL", recordId: updated._id, actorEmail, action: "REQUIREMENT_LINKED", previousState: null, newState: null, metadata: { frameworkId, requirementId } });
  return { control: updated };
}

export async function listControls(orgId, { status, framework } = {}) {
  const { complianceControls } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (status) query.status = status;
  if (framework) query["linkedRequirements.frameworkId"] = framework;
  return complianceControls.find(query).sort({ createdAt: -1 }).toArray();
}

export async function getControl(orgId, controlId) {
  const { complianceControls } = await getOrgCollections();
  return complianceControls.findOne({ _id: toObjectId(controlId), orgId: toObjectId(orgId) });
}
