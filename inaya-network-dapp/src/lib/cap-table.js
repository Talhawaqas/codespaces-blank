// src/lib/cap-table.js
//
// Financial Services & Regulated Enterprise SOW, Phase 3 (§34) — Cap
// Table. "private_capital" vertical only.
//
// Deliberately an ingest/evidence layer, NOT a transactional share-
// issuance engine: "If an external cap-table system remains authoritative,
// Inaya should ingest and preserve synchronized evidence rather than
// creating a conflicting source of truth" (§34). There is no
// issueShares()/transferShares() here -- only recordCapTableSnapshot(),
// which stores a full point-in-time cap table (shareholders, share
// classes, options, warrants, SAFEs, convertible notes, preferred/common
// shares) exactly as reported or ingested, never computed from Inaya's
// own transaction log. "Every cap-table change must be versioned and
// approved" (§34) is enforced with the same dual-reviewer gate
// valuation-management.js uses: approveCapTableSnapshot() requires a
// different person than whoever recorded it.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canAccessFinancialEntities, canManageFinancialEntities } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export const CAP_TABLE_INSTRUMENT_TYPES = ["common", "preferred", "option", "warrant", "safe", "convertible_note"];

/** Never edited in place -- every recording is a new immutable version. */
export async function recordCapTableSnapshot({ orgId, portfolioCompanyId, asOfDate, source, rows, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can record a cap-table snapshot.", status: 403 };
  if (!Array.isArray(rows) || rows.length === 0) return { error: "At least one cap-table row is required.", status: 400 };
  for (const row of rows) {
    if (!CAP_TABLE_INSTRUMENT_TYPES.includes(row.instrumentType)) return { error: `Unknown instrument type "${row.instrumentType}".`, status: 400 };
  }

  const { capTableSnapshots } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const companyObjectId = toObjectId(portfolioCompanyId);
  const priorVersions = await capTableSnapshots.find({ orgId: orgObjectId, portfolioCompanyId: companyObjectId }).sort({ version: -1 }).limit(1).toArray();
  const version = (priorVersions[0]?.version || 0) + 1;

  const totalFullyDiluted = rows.reduce((sum, r) => sum + (r.fullyDilutedShares || 0), 0);
  const rowsWithOwnership = rows.map((r) => ({ ...r, fullyDilutedPercent: totalFullyDiluted > 0 ? (r.fullyDilutedShares || 0) / totalFullyDiluted : null }));

  const now = new Date().toISOString();
  const doc = {
    orgId: orgObjectId, portfolioCompanyId: companyObjectId, version,
    asOfDate: asOfDate || now, source: source || "manual_entry",
    rows: rowsWithOwnership, totalFullyDilutedShares: totalFullyDiluted,
    recordedByEmail: actorEmail, recordedAt: now,
    approvedByEmail: null, approvedAt: null,
  };
  const result = await capTableSnapshots.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "CAP_TABLE_SNAPSHOT", recordId: inserted._id, actorEmail, action: "RECORDED", previousState: null, newState: null, metadata: { portfolioCompanyId, version } });
  return { snapshot: inserted };
}

/** Requires a different person than whoever recorded it -- same
 *  discipline as valuation-management.js's approveValuation(). */
export async function approveCapTableSnapshot({ orgId, snapshotId, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can approve a cap-table snapshot.", status: 403 };
  const { capTableSnapshots } = await getOrgCollections();
  const current = await capTableSnapshots.findOne({ _id: toObjectId(snapshotId), orgId: toObjectId(orgId) });
  if (!current) return { error: "Cap-table snapshot not found.", status: 404 };
  if (current.approvedAt) return { error: "This snapshot is already approved.", status: 409 };
  if (current.recordedByEmail === actorEmail) return { error: "The approver must be a different person than whoever recorded it.", status: 403 };

  const now = new Date().toISOString();
  const updated = await capTableSnapshots.findOneAndUpdate(
    { _id: current._id },
    { $set: { approvedByEmail: actorEmail, approvedAt: now } },
    { returnDocument: "after" }
  );
  await logOrgActivity({ orgId, recordType: "CAP_TABLE_SNAPSHOT", recordId: current._id, actorEmail, action: "APPROVED", previousState: null, newState: null, metadata: {} });
  return { snapshot: updated };
}

export async function getLatestCapTableSnapshot(orgId, portfolioCompanyId) {
  const { capTableSnapshots } = await getOrgCollections();
  const latest = await capTableSnapshots.find({ orgId: toObjectId(orgId), portfolioCompanyId: toObjectId(portfolioCompanyId) }).sort({ version: -1 }).limit(1).toArray();
  return latest[0] || null;
}

export async function listCapTableSnapshots(orgId, portfolioCompanyId) {
  const { capTableSnapshots } = await getOrgCollections();
  return capTableSnapshots.find({ orgId: toObjectId(orgId), portfolioCompanyId: toObjectId(portfolioCompanyId) }).sort({ version: -1 }).toArray();
}
