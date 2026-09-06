// src/lib/spv-management.js
//
// Financial Services & Regulated Enterprise SOW, Phase 3 (§42) — SPV
// Management. "private_capital" vertical only.
//
// An SPV is structurally a fund: fund-registry.js's FUND_STRUCTURE_TYPES
// already includes "spv" (from Phase 1). Rather than building a second
// investor/ownership/capital-activity system, createSpv() creates a REAL
// financialFunds document via createFund({structureType:"spv"}) and this
// file only adds the handful of fields a fund doesn't have (underlying
// asset, fee/expense structure, legal document pointers) as a small
// companion record keyed by fundId. Investors, ownership, and capital
// activity are entirely financial-investors.js's existing
// createInvestor()/recordCapitalEvent()/getCapitalAccountSummary()
// against the SPV's own fundId -- zero new code for that part.

import { getOrgCollections, canAccessFinancialEntities, canManageFinancialEntities, toObjectId } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";
import { createFund } from "./fund-registry.js";

export async function createSpv({ orgId, name, underlyingAsset, managementFeeBps, carryBps, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can register an SPV.", status: 403 };
  if (!underlyingAsset?.trim()) return { error: "An underlying asset description is required.", status: 400 };

  const { fund, error, status } = await createFund({ orgId, legalName: name, structureType: "spv", actorEmail, membership });
  if (error) return { error, status };

  const { spvs } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), fundId: fund._id, underlyingAsset: underlyingAsset.trim(),
    managementFeeBps: managementFeeBps ?? null, carryBps: carryBps ?? null,
    expenses: [], legalDocumentIds: [],
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await spvs.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "SPV", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: null, metadata: { fundId: fund._id, underlyingAsset: doc.underlyingAsset } });
  return { spv: inserted, fund };
}

export async function recordExpense({ orgId, spvId, description, amount, actorEmail, membership }) {
  if (!canAccessFinancialEntities(membership)) return { error: "You don't have financial-entities access.", status: 403 };
  if (!description?.trim() || typeof amount !== "number") return { error: "description and a numeric amount are required.", status: 400 };
  const { spvs } = await getOrgCollections();
  const now = new Date().toISOString();
  const expense = { description: description.trim(), amount, recordedByEmail: actorEmail, recordedAt: now };

  const updated = await spvs.findOneAndUpdate(
    { _id: toObjectId(spvId), orgId: toObjectId(orgId) },
    { $push: { expenses: expense }, $set: { updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "SPV not found.", status: 404 };
  return { spv: updated };
}

export async function linkLegalDocument({ orgId, spvId, documentId, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can link a legal document.", status: 403 };
  const { spvs } = await getOrgCollections();
  const updated = await spvs.findOneAndUpdate(
    { _id: toObjectId(spvId), orgId: toObjectId(orgId) },
    { $addToSet: { legalDocumentIds: toObjectId(documentId) }, $set: { updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "SPV not found.", status: 404 };
  return { spv: updated };
}

export async function getSpv(orgId, spvId) {
  const { spvs } = await getOrgCollections();
  return spvs.findOne({ _id: toObjectId(spvId), orgId: toObjectId(orgId) });
}

export async function listSpvs(orgId) {
  const { spvs } = await getOrgCollections();
  return spvs.find({ orgId: toObjectId(orgId) }).sort({ createdAt: -1 }).toArray();
}
