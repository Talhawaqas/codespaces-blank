// src/lib/valuation-management.js
//
// Financial Services & Regulated Enterprise SOW, Phase 2 (§17) —
// Valuation Management. "financial" vertical only. Every valuation
// preserves its source and methodology permanently — §17's own
// instruction is explicit: "the system must preserve source and
// methodology rather than present AI estimates as authoritative
// valuations." A valuation is never edited in place; a correction is a
// NEW valuation record with a reviewer/approval, same append-only
// history as legal-billing/trust-accounting's ledgers, so the full
// valuation history for a position is always reconstructable.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canAccessFinancialEntities, canManageFinancialEntities } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export const VALUATION_METHODS = ["market_price", "model", "third_party_pricing_service", "manager_estimate", "last_transaction", "appraisal"];
export const VALUATION_INSTRUMENT_TYPES = ["public_security", "private_security", "illiquid_asset", "derivative", "structured_product", "portfolio_company"];

export async function recordValuation({ orgId, positionId, instrumentType, method, source, valuationDate, value, currency, modelSource, isOverride, overrideReason, actorEmail, membership }) {
  if (!canAccessFinancialEntities(membership)) return { error: "You don't have financial-entities access.", status: 403 };
  if (!VALUATION_METHODS.includes(method)) return { error: `Unknown valuation method "${method}".`, status: 400 };
  if (typeof value !== "number") return { error: "value must be a number.", status: 400 };

  const { valuations } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), positionId: toObjectId(positionId),
    instrumentType: instrumentType || null, method, source: source || null,
    valuationDate: valuationDate || now, value, currency: currency || "USD",
    modelSource: modelSource || null,
    isOverride: !!isOverride, overrideReason: overrideReason || null,
    reviewerEmail: null, approvedAt: null,
    recordedByEmail: actorEmail, createdAt: now,
  };
  const result = await valuations.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "VALUATION", recordId: inserted._id, actorEmail, action: "RECORDED", previousState: null, newState: null, metadata: { positionId, method, value } });
  return { valuation: inserted };
}

/** A second, independent reviewer confirming a valuation — never the
 *  same person who recorded it, matching the SOW's dual-control
 *  reasoning elsewhere (§94) for anything that affects reported value. */
export async function approveValuation({ orgId, valuationId, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can approve a valuation.", status: 403 };
  const { valuations } = await getOrgCollections();
  const current = await valuations.findOne({ _id: toObjectId(valuationId), orgId: toObjectId(orgId) });
  if (!current) return { error: "Valuation not found.", status: 404 };
  if (current.recordedByEmail === actorEmail) return { error: "The valuation reviewer must be a different person than whoever recorded it.", status: 403 };
  if (current.approvedAt) return { error: "This valuation is already approved.", status: 409 };

  const now = new Date().toISOString();
  const updated = await valuations.findOneAndUpdate(
    { _id: current._id, approvedAt: null },
    { $set: { reviewerEmail: actorEmail, approvedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "This valuation is already approved.", status: 409 };
  await logOrgActivity({ orgId, recordType: "VALUATION", recordId: updated._id, actorEmail, action: "APPROVED", previousState: null, newState: null, metadata: {} });
  return { valuation: updated };
}

export async function listValuations(orgId, { positionId } = {}) {
  const { valuations } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (positionId) query.positionId = toObjectId(positionId);
  return valuations.find(query).sort({ valuationDate: -1 }).toArray();
}

/** The most recent valuation for a position — read-only convenience,
 *  never a computed/estimated fallback when no valuation exists. */
export async function getLatestValuation(orgId, positionId) {
  const { valuations } = await getOrgCollections();
  return valuations.find({ orgId: toObjectId(orgId), positionId: toObjectId(positionId) }).sort({ valuationDate: -1 }).limit(1).next();
}
