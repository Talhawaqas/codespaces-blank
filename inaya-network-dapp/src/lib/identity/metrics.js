// src/lib/identity/metrics.js
//
// SOW §41 (observability). Every figure is computed from durable rows (runs, events, revocations, remediations, providers); nothing is
// estimated or sampled. `windowDays` bounds the run-based figures.

import { toObjectId } from "../orgs.js";
import { getIdentityCollections } from "./db.js";

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

export async function identityMetrics({ orgId, windowDays = 30 }) {
  const oid = toObjectId(orgId);
  const c = await getIdentityCollections();
  const since = new Date(Date.now() - Math.min(365, Math.max(1, windowDays)) * 86400000).toISOString();
  const [runsByType, runsByState, providers, events, revs, openRem, temp, reviews, openReviews, drift, jobs, lastRuns] = await Promise.all([
    c.identityRuns.aggregate([{ $match: { orgId: oid, createdAt: { $gte: since } } }, { $group: { _id: "$type", n: { $sum: 1 } } }]).toArray(),
    c.identityRuns.aggregate([{ $match: { orgId: oid, createdAt: { $gte: since } } }, { $group: { _id: "$state", n: { $sum: 1 } } }]).toArray(),
    c.identityProviders.find({ orgId: oid }).project({ kind: 1, name: 1, status: 1, lastEventAt: 1, lastEventStatus: 1, stats: 1 }).toArray(),
    c.identityEvents.aggregate([{ $match: { orgId: oid, receivedAt: { $gte: since } } }, { $group: { _id: "$status", n: { $sum: 1 } } }]).toArray(),
    c.identityRevocations.find({ orgId: oid, createdAt: { $gte: since } }).project({ state: 1, createdAt: 1, completedAt: 1, mode: 1 }).limit(5000).toArray(),
    c.identityRemediations.countDocuments({ orgId: oid, status: "OPEN" }),
    c.identityGrants.aggregate([{ $match: { orgId: oid, source: "TEMPORARY", status: "ACTIVE" } }, { $group: { _id: null, n: { $sum: 1 }, soon: { $sum: { $cond: [{ $lte: ["$expiresAt", new Date(Date.now() + 7 * 86400000).toISOString()] }, 1, 0] } } } }]).toArray(),
    c.identityReviews.countDocuments({ orgId: oid }),
    c.identityReviews.countDocuments({ orgId: oid, status: "OPEN" }),
    c.identityDriftReports.find({ orgId: oid }).sort({ generatedAt: -1 }).limit(1).project({ generatedAt: 1, summary: 1 }).toArray(),
    c.identityJobs.aggregate([{ $match: { orgId: oid, createdAt: { $gte: since } } }, { $group: { _id: "$status", n: { $sum: 1 } } }]).toArray(),
    c.identityRuns.find({ orgId: oid, state: { $in: ["FAILED", "PARTIAL"] } }).sort({ createdAt: -1 }).limit(5).project({ type: 1, state: 1, email: 1, createdAt: 1, failure: 1 }).toArray(),
  ]);
  const st = Object.fromEntries(runsByState.map((r) => [r._id, r.n]));
  const total = Object.values(st).reduce((a, b) => a + b, 0);
  const revDone = revs.filter((r) => r.state === "REVOCATION_COMPLETE");
  const times = revDone.filter((r) => r.completedAt).map((r) => Date.parse(r.completedAt) - Date.parse(r.createdAt)).filter((x) => x >= 0).sort((a, b) => a - b);
  const ev = Object.fromEntries(events.map((e) => [e._id, e.n]));
  return {
    windowDays, generatedAt: new Date().toISOString(),
    lifecycle: { byType: Object.fromEntries(runsByType.map((r) => [r._id, r.n])), byState: st, total, failureRate: pct((st.FAILED || 0) + (st.PARTIAL || 0), total) },
    events: { byStatus: ev, rejectedOrStale: (ev.REJECTED || 0) + (ev.STALE || 0), pending: ev.PENDING || 0 },
    revocation: { total: revs.length, complete: revDone.length, partial: revs.filter((r) => r.state === "REVOCATION_PARTIAL").length, failed: revs.filter((r) => r.state === "REVOCATION_FAILED").length, pending: revs.filter((r) => r.state === "REVOCATION_PENDING").length, medianMs: times.length ? times[Math.floor(times.length / 2)] : null, p95Ms: times.length ? times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] : null },
    providers: providers.map((p) => ({ providerId: String(p._id), kind: p.kind, name: p.name, status: p.status, lastEventAt: p.lastEventAt || null, lastEventStatus: p.lastEventStatus || null, stale: p.status !== "disabled" && (!p.lastEventAt || Date.parse(p.lastEventAt) < Date.now() - 7 * 86400000) })),
    drift: drift[0] ? { lastReportAt: drift[0].generatedAt, summary: drift[0].summary } : null,
    orphans: { open: openRem },
    temporaryAccess: { active: temp[0]?.n || 0, expiringWithin7Days: temp[0]?.soon || 0 },
    reviews: { campaigns: reviews, open: openReviews },
    jobs: Object.fromEntries(jobs.map((j) => [j._id, j.n])),
    recentProblems: lastRuns.map((r) => ({ runId: String(r._id), type: r.type, state: r.state, email: r.email, at: r.createdAt, failure: r.failure?.message || r.failure?.class || null })),
    source: "computed from durable rows only",
  };
}
