// AI Security Workflow SOW Phase 11.3 -- anomaly / spike detection over the AI security event log.
//
// The gateway already records one aiSecurityChecks event per decision. This module reads that
// history and flags behaviour that is unusual FOR THIS ORGANIZATION, using plain statistics (no
// model): a recent window is compared to the org's own hourly baseline. detectAnomalies() is a pure
// function over event rows so it is testable without a database; analyzeOrg() fetches the rows.
//
// Five signals:
//   ACTOR_BLOCK_SPIKE   one person is being blocked far more than their own history
//   ORG_BLOCK_SPIKE     org-wide blocked/redacted volume well above its hourly baseline
//   REQUEST_BURST       one actor sending many AI requests inside a minute (automation / scraping)
//   NEW_ATTACK_CATEGORY a category with no history suddenly appears repeatedly
//   COORDINATED_PROBING several different people triggering the same category in the window
//
// Thresholds are deliberately conservative: an alert should mean "a human should look", so a quiet
// org with a handful of events never alerts on noise.

import { getOrgCollections, toObjectId } from "../orgs.js";

export const DEFAULTS = {
  windowMinutes: 60,
  baselineHours: 24 * 7,
  minEventsToAlert: 5,        // never alert on fewer than this many events
  zScore: 3,                  // recent count must exceed baseline mean by this many std-devs
  burstPerMinute: 20,         // requests by one actor within 60 seconds
  newCategoryMin: 3,          // a never-seen category must appear this many times
  minBaselineEvents: 10,      // blocked events of history required before anything can be called 'new'
  coordinatedActors: 3,       // distinct actors on one category
};

const NON_ALLOW = (e) => e.decision && e.decision !== "ALLOW";
const ts = (e) => new Date(e.timestamp || e.createdAt).getTime();

function stats(values) {
  if (!values.length) return { mean: 0, std: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, std: Math.sqrt(variance) };
}

/** Counts per whole-hour bucket going back `hours` from `now`, EXCLUDING the recent window so the
 *  baseline never contains the spike being tested. Missing hours count as zero (quiet hours matter). */
function hourlyBaseline(events, now, windowMs, hours) {
  const buckets = new Array(Math.max(1, hours)).fill(0);
  const cutoff = now - windowMs;
  for (const e of events) {
    const t = ts(e);
    if (t >= cutoff) continue;
    const idx = Math.floor((cutoff - t) / 3_600_000);
    if (idx < buckets.length) buckets[idx] += 1;
  }
  return buckets;
}

/** Counts are Poisson-like, so the spread is never smaller than sqrt(mean): a perfectly regular
 *  history (std 0) must not make every slightly busier hour look like a spike. */
function spread(base) {
  return Math.max(base.std, Math.sqrt(base.mean), 1);
}

function severityFor(count, threshold) {
  if (count >= threshold * 3) return "HIGH";
  if (count >= threshold * 1.5) return "MEDIUM";
  return "LOW";
}

export function detectAnomalies(events, { now = Date.now(), ...options } = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const windowMs = cfg.windowMinutes * 60_000;
  const recent = events.filter((e) => ts(e) >= now - windowMs && ts(e) <= now);
  const history = events.filter((e) => ts(e) < now - windowMs);
  const anomalies = [];
  const ids = (list) => list.slice(0, 20).map((e) => String(e._id ?? e.requestId));

  // --- ORG_BLOCK_SPIKE ---------------------------------------------------------------------
  const recentBlocked = recent.filter(NON_ALLOW);
  const orgBase = stats(hourlyBaseline(history.filter(NON_ALLOW), now, windowMs, Math.ceil(cfg.baselineHours)));
  const orgThreshold = orgBase.mean + cfg.zScore * spread(orgBase);
  const perWindow = cfg.windowMinutes / 60;
  if (recentBlocked.length >= cfg.minEventsToAlert && recentBlocked.length / perWindow > orgThreshold) {
    anomalies.push({
      type: "ORG_BLOCK_SPIKE", severity: severityFor(recentBlocked.length, Math.max(cfg.minEventsToAlert, orgThreshold)),
      count: recentBlocked.length, baselinePerHour: Number(orgBase.mean.toFixed(2)),
      message: `${recentBlocked.length} blocked/redacted AI requests in the last ${cfg.windowMinutes} minutes versus an hourly average of ${orgBase.mean.toFixed(1)}.`,
      evidence: ids(recentBlocked),
    });
  }

  // --- ACTOR_BLOCK_SPIKE + REQUEST_BURST ---------------------------------------------------
  const byActor = new Map();
  for (const e of recent) {
    const a = e.actorEmail || "(anonymous)";
    if (!byActor.has(a)) byActor.set(a, []);
    byActor.get(a).push(e);
  }
  for (const [actor, list] of byActor) {
    const blocked = list.filter(NON_ALLOW);
    if (blocked.length >= cfg.minEventsToAlert) {
      const mine = history.filter((e) => (e.actorEmail || "(anonymous)") === actor && NON_ALLOW(e));
      const base = stats(hourlyBaseline(mine, now, windowMs, Math.ceil(cfg.baselineHours)));
      const threshold = base.mean + cfg.zScore * spread(base);
      if (blocked.length / perWindow > threshold) {
        anomalies.push({
          type: "ACTOR_BLOCK_SPIKE", severity: severityFor(blocked.length, Math.max(cfg.minEventsToAlert, threshold)), actor,
          count: blocked.length, baselinePerHour: Number(base.mean.toFixed(2)),
          message: `${actor} was blocked or redacted ${blocked.length} times in the last ${cfg.windowMinutes} minutes (their usual rate is ${base.mean.toFixed(1)} per hour).`,
          evidence: ids(blocked),
        });
      }
    }
    // Rolling 60-second window over this actor's timestamps.
    const times = list.map(ts).sort((a, b) => a - b);
    let maxInMinute = 0;
    for (let i = 0, j = 0; i < times.length; i++) {
      while (times[i] - times[j] > 60_000) j++;
      maxInMinute = Math.max(maxInMinute, i - j + 1);
    }
    if (maxInMinute >= cfg.burstPerMinute) {
      anomalies.push({
        type: "REQUEST_BURST", severity: severityFor(maxInMinute, cfg.burstPerMinute), actor, count: maxInMinute,
        message: `${actor} sent ${maxInMinute} AI requests within one minute, which looks automated.`,
        evidence: ids(list),
      });
    }
  }

  // --- NEW_ATTACK_CATEGORY + COORDINATED_PROBING -------------------------------------------
  const historyBlocked = history.filter(NON_ALLOW);
  const knownCategories = new Set(historyBlocked.map((e) => e.category));
  const hasBaseline = historyBlocked.length >= cfg.minBaselineEvents;
  const byCategory = new Map();
  for (const e of recentBlocked) {
    if (!byCategory.has(e.category)) byCategory.set(e.category, []);
    byCategory.get(e.category).push(e);
  }
  for (const [category, list] of byCategory) {
    if (hasBaseline && !knownCategories.has(category) && list.length >= cfg.newCategoryMin) {
      anomalies.push({
        type: "NEW_ATTACK_CATEGORY", severity: severityFor(list.length, cfg.newCategoryMin), category, count: list.length,
        message: `${list.length} "${category}" events appeared in the last ${cfg.windowMinutes} minutes and this organization had none before.`,
        evidence: ids(list),
      });
    }
    const actors = new Set(list.map((e) => e.actorEmail || "(anonymous)"));
    if (actors.size >= cfg.coordinatedActors && list.length >= cfg.minEventsToAlert) {
      anomalies.push({
        type: "COORDINATED_PROBING", severity: "HIGH", category, count: list.length, actors: actors.size,
        message: `${actors.size} different people triggered "${category}" ${list.length} times in the last ${cfg.windowMinutes} minutes.`,
        evidence: ids(list),
      });
    }
  }

  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  anomalies.sort((a, b) => rank[a.severity] - rank[b.severity] || b.count - a.count);
  return {
    windowMinutes: cfg.windowMinutes,
    generatedAt: new Date(now).toISOString(),
    summary: { eventsInWindow: recent.length, blockedInWindow: recentBlocked.length, baselineEvents: history.length },
    anomalies,
  };
}

export async function analyzeOrg({ orgId, now = Date.now(), ...options }) {
  const cfg = { ...DEFAULTS, ...options };
  const { aiSecurityChecks } = await getOrgCollections();
  const since = new Date(now - cfg.baselineHours * 3_600_000).toISOString();
  const events = await aiSecurityChecks
    .find({ orgId: toObjectId(orgId), deletedAt: null, timestamp: { $gte: since } })
    .project({ actorEmail: 1, category: 1, decision: 1, timestamp: 1, createdAt: 1, requestId: 1 })
    .limit(20_000)
    .toArray();
  return detectAnomalies(events, { now, ...options });
}
