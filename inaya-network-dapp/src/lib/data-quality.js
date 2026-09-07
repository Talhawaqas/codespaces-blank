// src/lib/data-quality.js
//
// Financial Services & Regulated Enterprise SOW, Phase 7 (§237-238) — Data
// Quality scoring for configured integrations. The load-bearing rule,
// verbatim from §237: "Unknown must remain unknown." A provider that has
// never completed a real sync has NO basis for any of the six scores —
// this returns null/"unknown" for every dimension rather than fabricating
// a default (the exact same discipline as compliance-health.js's
// unknown-vs-passing distinction).
//
// Scores are computed only from integrationSyncRuns' own real numbers —
// nothing here re-inspects the actual synced business records (that would
// require a real adapter's data model per provider, which doesn't exist
// yet). This is a genuine, if modest, first read on data quality: are
// syncs fresh, are they failing, are they conflicting.

import { listSyncRuns } from "./integrations.js";
import { getOrgCollections, toObjectId } from "./orgs.js";

export const DATA_QUALITY_ALERT_TYPES = [
  "stale_market_data", "missing_investor_records", "duplicate_portfolio_company",
  "missing_valuation_source", "failed_control_evidence", "broken_vendor_integration",
];

function unknownScore() {
  return { completeness: null, freshness: null, consistency: null, validity: null, uniqueness: null, lineage: null };
}

/** One provider's data quality — every field null ("unknown") if it has
 *  never run a real sync. */
export async function getDataQualityScore(orgId, providerId) {
  const { integrationConnections } = await getOrgCollections();
  const connection = await integrationConnections.findOne({ orgId: toObjectId(orgId), providerId });
  if (!connection || connection.status === "NOT_CONFIGURED" || !connection.lastSyncAt) {
    return { providerId, ...unknownScore(), reason: "No sync has ever completed for this provider — nothing to score yet." };
  }

  const runs = await listSyncRuns(orgId, { providerId, limit: 10 });
  const latest = runs[0];
  if (!latest) return { providerId, ...unknownScore(), reason: "No sync run history found despite a lastSyncAt on the connection — treated as unknown, not fabricated." };

  // Freshness: only meaningful if the provider has a real sync cadence.
  let freshness = null;
  if (connection.syncFrequencyHours) {
    const hoursSinceLastSync = (Date.now() - new Date(connection.lastSyncAt).getTime()) / (60 * 60 * 1000);
    freshness = hoursSinceLastSync <= connection.syncFrequencyHours * 2 ? "fresh" : "stale";
  }

  const completeness = latest.sourceCount > 0 ? Math.max(0, 1 - latest.failedCount / latest.sourceCount) : null;
  const consistency = latest.targetCount > 0 ? Math.max(0, 1 - latest.conflicts / latest.targetCount) : null;
  const validity = latest.result === "success" ? "valid" : "invalid";
  // Uniqueness/lineage require real record-level inspection this pass has
  // no adapter to perform — honestly unknown rather than guessed.
  const uniqueness = null;
  const lineage = null;

  return { providerId, completeness, freshness, consistency, validity, uniqueness, lineage, basedOnRunAt: latest.startedAt };
}

export async function computeOrgDataQualityScores(orgId) {
  const { integrationConnections } = await getOrgCollections();
  const connections = await integrationConnections.find({ orgId: toObjectId(orgId) }).toArray();
  const scores = await Promise.all(connections.map((c) => getDataQualityScore(orgId, c.providerId)));
  return { scores, unscored: connections.length === 0 ? "No integrations configured yet — no data quality basis exists." : null };
}

/** Alerts are only ever raised from a REAL signal already recorded
 *  elsewhere (a stale/erroring connection, a failed control test, a broken
 *  vendor) — never invented from the alert-type list itself. */
export async function listDataQualityAlerts(orgId) {
  const { integrationConnections, vendorRecords, complianceEvidence } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const alerts = [];

  const connections = await integrationConnections.find({ orgId: orgObjectId }).toArray();
  for (const c of connections) {
    if (c.status === "ERROR") alerts.push({ type: "broken_vendor_integration", providerId: c.providerId, detail: `${c.providerId} is in an error state.` });
    if (c.status === "ACTIVE" && c.syncFrequencyHours && c.lastSyncAt) {
      const hoursSinceLastSync = (Date.now() - new Date(c.lastSyncAt).getTime()) / (60 * 60 * 1000);
      if (hoursSinceLastSync > c.syncFrequencyHours * 3) {
        alerts.push({ type: c.providerId === "market_data_provider" ? "stale_market_data" : "broken_vendor_integration", providerId: c.providerId, detail: `${c.providerId} hasn't synced in over ${Math.round(hoursSinceLastSync)}h (expected every ${c.syncFrequencyHours}h).` });
      }
    }
  }

  const expiredEvidenceCount = await complianceEvidence.countDocuments({ orgId: orgObjectId, reviewStatus: "rejected" });
  if (expiredEvidenceCount > 0) alerts.push({ type: "failed_control_evidence", detail: `${expiredEvidenceCount} rejected evidence record(s) on file.` });

  return { alerts };
}
