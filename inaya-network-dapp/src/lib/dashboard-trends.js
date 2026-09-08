// src/lib/dashboard-trends.js
//
// UI Enhancement Specs v2, §1 (Elevated Metric Cards — micro-charts). The
// spec asks for a sparkline on "metrics involving time or progress" — of
// OsHomeView.js's four tiles (Departments, Projects, Documents, Pending
// Approvals), only Pending Approvals has a genuine, cheaply-derivable
// day-by-day history today: aiActionRequests.requestedAt. Departments/
// Projects/Documents are point-in-time counts with no creation-timestamp
// trend logged anywhere (org_activity doesn't record department/project
// creation) — inventing a chart for those would mean drawing a line from
// numbers nobody computed, which this codebase never does (see
// compliance-health.js's "unknown is never fabricated as passing" for the
// same discipline applied elsewhere). So this file deliberately covers
// ONE real trend, not four decorative ones.

import { getOrgCollections, toObjectId } from "./orgs.js";

const TREND_DAYS = 7;

/** Real counts only — a day with zero requests is a real 0, not a gap
 *  papered over. Returns null (never an empty/fake array) if the org has
 *  no aiActionRequests collection activity at all yet, so the caller can
 *  render no sparkline rather than a flat fabricated line. */
export async function getPendingApprovalsTrend(orgId) {
  const { aiActionRequests } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const since = new Date(Date.now() - TREND_DAYS * 24 * 60 * 60 * 1000);

  const totalEver = await aiActionRequests.countDocuments({ orgId: orgObjectId });
  if (totalEver === 0) return null;

  const rows = await aiActionRequests
    .aggregate([
      { $match: { orgId: orgObjectId, requestedAt: { $gte: since.toISOString() } } },
      { $group: { _id: { $substrCP: ["$requestedAt", 0, 10] }, count: { $sum: 1 } } },
    ])
    .toArray();
  const countByDay = new Map(rows.map((r) => [r._id, r.count]));

  const points = [];
  for (let i = TREND_DAYS - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    points.push({ day, count: countByDay.get(day) || 0 });
  }
  return points;
}
