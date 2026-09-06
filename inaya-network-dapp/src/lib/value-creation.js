// src/lib/value-creation.js
//
// Financial Services & Regulated Enterprise SOW, Phase 3 (§37) — Value
// Creation Plans. "private_capital" vertical only. A plan tracks
// owner/target/baseline/expected-result/actual-result/deadline/status/
// evidence (§37) -- simple CRUD plus a status field and an append-only
// evidence log, no state-machine transitions needed since the SOW doesn't
// define an approval workflow for these, just progress tracking.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canAccessFinancialEntities, canManageFinancialEntities } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export const VALUE_CREATION_CATEGORIES = [
  "30_60_90_day", "strategic_initiative", "hiring", "revenue", "cost",
  "product", "security", "compliance", "ma", "financing",
];
export const VALUE_CREATION_STATUSES = ["not_started", "in_progress", "complete", "blocked"];

export async function createValueCreationPlan({ orgId, portfolioCompanyId, category, title, ownerEmail, target, baseline, expectedResult, deadline, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can create a value creation plan.", status: 403 };
  if (!VALUE_CREATION_CATEGORIES.includes(category)) return { error: `Unknown category "${category}".`, status: 400 };
  if (!title?.trim()) return { error: "A title is required.", status: 400 };

  const { valueCreationPlans } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), portfolioCompanyId: toObjectId(portfolioCompanyId), category, title: title.trim(),
    ownerEmail: ownerEmail || actorEmail, target: target || null, baseline: baseline || null,
    expectedResult: expectedResult || null, actualResult: null, deadline: deadline || null,
    evidence: [], status: "not_started",
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await valueCreationPlans.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "VALUE_CREATION_PLAN", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: "not_started", metadata: { title: doc.title } });
  return { plan: inserted };
}

export async function updatePlanStatus({ orgId, planId, status, actualResult, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can update a value creation plan.", status: 403 };
  if (!VALUE_CREATION_STATUSES.includes(status)) return { error: `Unknown status "${status}".`, status: 400 };
  const { valueCreationPlans } = await getOrgCollections();
  const current = await valueCreationPlans.findOne({ _id: toObjectId(planId), orgId: toObjectId(orgId) });
  if (!current) return { error: "Value creation plan not found.", status: 404 };

  const now = new Date().toISOString();
  const setDoc = { status, updatedAt: now };
  if (actualResult !== undefined) setDoc.actualResult = actualResult;

  const updated = await valueCreationPlans.findOneAndUpdate({ _id: current._id }, { $set: setDoc }, { returnDocument: "after" });
  await logOrgActivity({ orgId, recordType: "VALUE_CREATION_PLAN", recordId: current._id, actorEmail, action: "STATUS_CHANGED", previousState: current.status, newState: status, metadata: {} });
  return { plan: updated };
}

export async function addPlanEvidence({ orgId, planId, note, documentId, actorEmail, membership }) {
  if (!canAccessFinancialEntities(membership)) return { error: "You don't have financial-entities access.", status: 403 };
  const { valueCreationPlans } = await getOrgCollections();
  const now = new Date().toISOString();
  const entry = { note: note || null, documentId: documentId ? toObjectId(documentId) : null, actorEmail, at: now };

  const updated = await valueCreationPlans.findOneAndUpdate(
    { _id: toObjectId(planId), orgId: toObjectId(orgId) },
    { $push: { evidence: entry }, $set: { updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Value creation plan not found.", status: 404 };
  return { plan: updated };
}

export async function listValueCreationPlans(orgId, portfolioCompanyId, { status } = {}) {
  const { valueCreationPlans } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId), portfolioCompanyId: toObjectId(portfolioCompanyId) };
  if (status) query.status = status;
  return valueCreationPlans.find(query).sort({ deadline: 1, createdAt: -1 }).toArray();
}
