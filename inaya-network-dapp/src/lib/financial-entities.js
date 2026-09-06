// src/lib/financial-entities.js
//
// Financial Services & Regulated Enterprise SOW, Phase 1 (§4) — the
// Asset Manager Organizational Model. SOW §4 lists ~20 near-identical
// entity kinds (parent management company, adviser, office, investment/
// risk/compliance committee, board, external administrator, prime
// broker, custodian, auditor, legal counsel, fund administrator,
// valuation agent, data provider, technology vendor). Modeling each as
// its own collection would be premature duplication — a single
// `financial_entities` table with a `type` discriminator + optional
// `parentEntityId` covers the whole hierarchy (§4's "every entity must
// have independent scope and permissions" is satisfied by
// canAccessFinancialEntities' role gate, same as every other domain
// object in this app). The Fund itself is deliberately NOT modeled here
// — it's the one entity complex enough to need its own richer schema
// and lifecycle, see fund-registry.js.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canManageFinancialEntities } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export const ENTITY_TYPES = [
  "management_company", "adviser", "office", "team",
  "investment_committee", "risk_committee", "compliance_committee", "board",
  "external_administrator", "prime_broker", "custodian", "auditor",
  "legal_counsel", "fund_administrator", "valuation_agent", "data_provider", "technology_vendor",
];

export async function createEntity({ orgId, type, name, parentEntityId, details, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can create an entity.", status: 403 };
  if (!ENTITY_TYPES.includes(type)) return { error: `Unknown entity type "${type}".`, status: 400 };
  if (!name?.trim()) return { error: "An entity name is required.", status: 400 };

  const { financialEntities } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId),
    type, name: name.trim(),
    parentEntityId: parentEntityId ? toObjectId(parentEntityId) : null,
    details: details || {},
    status: "active",
    createdByEmail: actorEmail,
    createdAt: now, updatedAt: now,
  };
  const result = await financialEntities.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "FINANCIAL_ENTITY", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: "active", metadata: { type, name: doc.name } });
  return { entity: inserted };
}

export async function updateEntity({ orgId, entityId, updates, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can update an entity.", status: 403 };
  const { financialEntities } = await getOrgCollections();
  const allowed = ["name", "details", "status", "parentEntityId"];
  const setDoc = { updatedAt: new Date().toISOString() };
  for (const key of allowed) {
    if (updates[key] !== undefined) setDoc[key] = key === "parentEntityId" && updates[key] ? toObjectId(updates[key]) : updates[key];
  }

  const updated = await financialEntities.findOneAndUpdate(
    { _id: toObjectId(entityId), orgId: toObjectId(orgId) },
    { $set: setDoc },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Entity not found.", status: 404 };
  return { entity: updated };
}

export async function listEntities(orgId, { type } = {}) {
  const { financialEntities } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (type) query.type = type;
  return financialEntities.find(query).sort({ type: 1, name: 1 }).toArray();
}
