// src/lib/investment-research.js
//
// Financial Services & Regulated Enterprise SOW, Phase 2 (§6) — the
// Research Repository. "financial" vertical only. Research files
// themselves are NOT a new storage system — investment_research holds
// only classification metadata + a documentId pointer into the existing
// org_documents (same encrypt/shard/pin pipeline every other document
// already uses), same storage indirection health/legal records use.
//
// Provenance (§6.3) is captured at creation and never mutated —
// sourceDocumentId/sourcePage/sourceTimestamp/uploaderEmail/hash/version
// let both a human and the AI trace a conclusion back to source material,
// which is exactly what ai-investment-tools.js's citation requirement
// depends on.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canAccessFinancialEntities } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export const RESEARCH_TYPES = [
  "analyst_report", "broker_research", "public_filing", "earnings_material", "investor_presentation",
  "management_interview", "expert_call", "industry_report", "alternative_data", "market_data_export",
  "financial_model", "valuation_model", "internal_note", "investment_thesis_note", "watchlist", "research_memo",
];

export async function createResearch({ orgId, fundId, type, source, analyst, sector, geography, asset, company, strategy, confidence, materiality, sensitivity, confidentiality, usageRestrictions, documentId, sourcePage, sourceTimestamp, hash, relatedPositionIds, relatedThesisIds, actorEmail, membership }) {
  if (!canAccessFinancialEntities(membership)) return { error: "You don't have financial-entities access.", status: 403 };
  if (!RESEARCH_TYPES.includes(type)) return { error: `Unknown research type "${type}".`, status: 400 };

  const { investmentResearch } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId),
    fundId: fundId ? toObjectId(fundId) : null,
    type, source: source || null, analyst: analyst || actorEmail,
    sector: sector || null, geography: geography || null, asset: asset || null, company: company || null,
    strategy: strategy || null, confidence: confidence || null, materiality: materiality || null,
    sensitivity: sensitivity || "internal", confidentiality: confidentiality || "internal",
    usageRestrictions: usageRestrictions || null,
    // Provenance — set once, never mutated by any function in this file.
    documentId: documentId ? toObjectId(documentId) : null,
    sourcePage: sourcePage || null,
    sourceTimestamp: sourceTimestamp || now,
    uploaderEmail: actorEmail,
    hash: hash || null,
    version: 1,
    relatedPositionIds: (relatedPositionIds || []).map((id) => toObjectId(id)),
    relatedThesisIds: (relatedThesisIds || []).map((id) => toObjectId(id)),
    annotations: [],
    createdAt: now, updatedAt: now,
  };
  const result = await investmentResearch.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "INVESTMENT_RESEARCH", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: null, metadata: { type, company: doc.company } });
  return { research: inserted };
}

/** Annotations append-only — never rewrite an analyst's prior note,
 *  matching the "conclusion must be traceable to source material"
 *  provenance requirement (§6.3) even for follow-up commentary. */
export async function addAnnotation({ orgId, researchId, note, actorEmail, membership }) {
  if (!canAccessFinancialEntities(membership)) return { error: "You don't have financial-entities access.", status: 403 };
  const { investmentResearch } = await getOrgCollections();
  const now = new Date().toISOString();
  const updated = await investmentResearch.findOneAndUpdate(
    { _id: toObjectId(researchId), orgId: toObjectId(orgId) },
    { $push: { annotations: { note, actorEmail, at: now } }, $set: { updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Research item not found.", status: 404 };
  return { research: updated };
}

export async function listResearch(orgId, { fundId, type, company } = {}) {
  const { investmentResearch } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (fundId) query.fundId = toObjectId(fundId);
  if (type) query.type = type;
  if (company) query.company = company;
  return investmentResearch.find(query).sort({ createdAt: -1 }).toArray();
}

export async function getResearch(orgId, researchId) {
  const { investmentResearch } = await getOrgCollections();
  return investmentResearch.findOne({ _id: toObjectId(researchId), orgId: toObjectId(orgId) });
}
