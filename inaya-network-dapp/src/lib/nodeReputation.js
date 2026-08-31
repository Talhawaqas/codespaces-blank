// src/lib/nodeReputation.js
//
// Phase 5 (Node Telemetry & Reputation) — finally computes `uptimeScoreBps`
// on the `nodes` collection, a field that has existed since node
// registration (api/nodes/register/route.js sets it to 0) but has never
// been written to by anything since: the heartbeat route sets everything
// EXCEPT this field, and the on-chain updateNodeMetrics() that could set
// it has no caller anywhere in the codebase (confirmed by repo-wide
// search). This does NOT touch the chain — it's a real, off-chain,
// server-computed score derived from actual heartbeat regularity, the
// same "compute from real observed data, never fabricate" discipline
// start.js's header comment establishes for usedCapacityGB/shardsStored.
//
// MODEL: the daemon's own loop (start.js) beats every HEARTBEAT_INTERVAL_MS
// (default 5 min). heartbeat/route.js appends each beat's timestamp to a
// capped rolling log (`heartbeatLog`, last HEARTBEAT_LOG_SIZE entries) on
// the node doc. Score = how close the ACTUAL gaps between consecutive
// beats in that log are to the expected interval, penalized further for
// how stale the most recent beat is right now (a node that heartbeat
// perfectly regularly for a week and then went silent shouldn't still
// read as healthy). Both signals are real, derivable purely from data
// this system already has — no guessing.

export const HEARTBEAT_LOG_SIZE = 20;
const EXPECTED_INTERVAL_MS = 5 * 60 * 1000; // matches node-daemon's HEARTBEAT_INTERVAL_MS default
const STALE_GRACE_MULTIPLIER = 3; // a beat up to 3x the expected interval late isn't yet "down"

/** regularityScore in [0,1]: for each consecutive pair of timestamps in
 *  the log, how close the actual gap was to EXPECTED_INTERVAL_MS. A gap
 *  exactly on time scores 1; a gap of 2x expected (one missed beat)
 *  scores 0.5; 3x+ scores 0 — clamped, not extrapolated further, since a
 *  daemon that's been down for hours isn't "extra unhealthy," it's just
 *  down (the staleness penalty below already covers "still down right now"). */
function regularityScore(heartbeatLog) {
  if (!Array.isArray(heartbeatLog) || heartbeatLog.length < 2) return 1; // not enough history to penalize yet
  const sorted = [...heartbeatLog].sort();
  let total = 0;
  let count = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gapMs = new Date(sorted[i]).getTime() - new Date(sorted[i - 1]).getTime();
    if (gapMs <= 0) continue; // clock skew / duplicate beat, skip rather than penalize
    const ratio = gapMs / EXPECTED_INTERVAL_MS;
    total += Math.max(0, 1 - Math.max(0, ratio - 1));
    count += 1;
  }
  return count ? total / count : 1;
}

/** stalenessScore in [0,1]: 1 if the most recent heartbeat is on-time or
 *  early, tapering to 0 by STALE_GRACE_MULTIPLIER * EXPECTED_INTERVAL_MS
 *  late, and staying 0 beyond that (genuinely down right now). */
function stalenessScore(lastHeartbeatAt, now = Date.now()) {
  if (!lastHeartbeatAt) return 0;
  const ageMs = now - new Date(lastHeartbeatAt).getTime();
  if (ageMs <= EXPECTED_INTERVAL_MS) return 1;
  const graceMs = EXPECTED_INTERVAL_MS * STALE_GRACE_MULTIPLIER;
  if (ageMs >= graceMs) return 0;
  return 1 - (ageMs - EXPECTED_INTERVAL_MS) / (graceMs - EXPECTED_INTERVAL_MS);
}

/** Combines both signals into a single 0-10000 bps score, weighted evenly
 *  — regularity captures "has this node been reliable," staleness
 *  captures "is it actually up right now," neither alone is sufficient. */
export function computeUptimeScoreBps({ heartbeatLog, lastHeartbeatAt }, now = Date.now()) {
  if (!lastHeartbeatAt) return 0; // never beat at all — no regularity fallback can rescue this
  const regularity = regularityScore(heartbeatLog);
  const staleness = stalenessScore(lastHeartbeatAt, now);
  const combined = (regularity + staleness) / 2;
  return Math.round(Math.min(1, Math.max(0, combined)) * 10000);
}
