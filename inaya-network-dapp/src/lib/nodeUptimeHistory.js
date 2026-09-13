// src/lib/nodeUptimeHistory.js
//
// Node Operator Dashboard SOW — historical uptime and 90-day qualification
// tracking. The `nodes` collection's heartbeatLog only retains the last 20
// beats (~100 minutes at the 5-min interval) — nowhere near enough to
// answer "what was my uptime over the last 7/30/90 days." That history can
// only start accumulating from whenever the hourly snapshot cron
// (api/cron/nodes-snapshot/route.js) first runs, not be backfilled,
// so every function here is explicit about that: a window that reaches
// further back than the earliest snapshot on record is flagged
// insufficientData rather than silently computed from partial data
// pretending to be complete.

import clientPromise from "./mongodb.js";
import { NODE_OFFLINE_TIMEOUT_MS } from "./nodeReputation.js";

export const QUALIFICATION_UPTIME_THRESHOLD_BPS = 9500; // 95%
export const QUALIFICATION_REQUIRED_DAYS = 90;
const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000; // one row per node per hourly cron tick

export async function getNodeHistoryCollections() {
  const client = await clientPromise;
  const db = client.db("inaya_network");
  return {
    db,
    nodes: db.collection("nodes"),
    snapshots: db.collection("node_uptime_snapshots"),
    events: db.collection("node_events"),
    qualification: db.collection("node_qualification"),
  };
}

let indexesEnsured = false;
export async function ensureNodeHistoryIndexes() {
  if (indexesEnsured) return;
  const { snapshots, events, qualification } = await getNodeHistoryCollections();
  await Promise.all([
    snapshots.createIndex({ walletAddress: 1, takenAt: 1 }),
    events.createIndex({ walletAddress: 1, createdAt: -1 }),
    qualification.createIndex({ walletAddress: 1 }, { unique: true }),
  ]);
  indexesEnsured = true;
}

/** The single definition of "online" for every new piece of code — the
 *  exact point nodeReputation.js's stalenessScore() already bottoms out
 *  at 0. Pre-existing admin surfaces (admin/nodes/page.js's inline
 *  isStale(), admin/dashboard/route.js's separate 10-minute window) are
 *  untouched. */
export function isNodeOnline(lastHeartbeatAt, now = Date.now()) {
  if (!lastHeartbeatAt) return false;
  return now - new Date(lastHeartbeatAt).getTime() <= NODE_OFFLINE_TIMEOUT_MS;
}

// A combined regularity+staleness score (nodeReputation.js) below this
// cutoff, while still technically online, means the beats ARE arriving
// but not reliably enough to call "healthy" — SOW §6's "Degraded" bucket
// ("telemetry delayed," "repeated heartbeat failures"). 70% was chosen as
// the midpoint between a single missed beat (which alone drags the score
// to roughly 75-85%, per computeUptimeScoreBps's own regularity math) and
// a genuinely unreliable node — a single blip does not yet warrant an
// operator-facing warning, a pattern of them does.
const DEGRADED_SCORE_THRESHOLD_BPS = 7000;

/** SOW §6's four-state health classification, derived only from real
 *  telemetry already on the node doc — never "healthy" just because a
 *  database record exists. */
export function classifyNodeHealth(node, now = Date.now()) {
  if (!node?.lastHeartbeatAt) return "unknown";
  if (!isNodeOnline(node.lastHeartbeatAt, now)) return "offline";
  if ((node.uptimeScoreBps ?? 0) < DEGRADED_SCORE_THRESHOLD_BPS) return "degraded";
  return "healthy";
}

const WINDOW_MS = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};

export function windowMsFor(window) {
  return WINDOW_MS[window] ?? null; // null means "lifetime"
}

/** Aggregates node_uptime_snapshots into a window summary. insufficientData
 *  is true when the requested window reaches further back than the
 *  earliest snapshot on record for this node — the returned numbers still
 *  cover whatever portion of the window we DO have data for (with
 *  coverageStart/coverageEnd stating exactly what that portion is), rather
 *  than refusing to answer at all. */
export async function getUptimeForWindow(walletAddress, window) {
  await ensureNodeHistoryIndexes();
  const { snapshots } = await getNodeHistoryCollections();
  const wallet = walletAddress.toLowerCase();

  const earliestRows = await snapshots.find({ walletAddress: wallet }).sort({ takenAt: 1 }).limit(1).toArray();
  if (earliestRows.length === 0) {
    return { window, insufficientData: true, reason: "No telemetry snapshots recorded yet." };
  }
  const earliestAt = new Date(earliestRows[0].takenAt).getTime();

  const now = Date.now();
  const ms = windowMsFor(window);
  const requestedStart = ms == null ? earliestAt : now - ms;
  const rangeStart = Math.max(earliestAt, requestedStart);

  const rows = await snapshots.find({ walletAddress: wallet, takenAt: { $gte: new Date(rangeStart) } }).sort({ takenAt: 1 }).toArray();
  if (rows.length === 0) {
    return { window, insufficientData: true, reason: "No telemetry snapshots recorded yet for this period." };
  }

  let onlineCount = 0;
  let outageCount = 0;
  let longestOutageMs = 0;
  let currentOutageStart = null;
  let mostRecentOutage = null;
  let prevOnline = null;

  for (const row of rows) {
    if (row.online) {
      if (prevOnline === false && currentOutageStart != null) {
        const dur = new Date(row.takenAt).getTime() - currentOutageStart;
        longestOutageMs = Math.max(longestOutageMs, dur);
        mostRecentOutage = { start: new Date(currentOutageStart).toISOString(), end: row.takenAt };
        currentOutageStart = null;
      }
      onlineCount += 1;
    } else {
      if (prevOnline !== false) {
        outageCount += 1;
        currentOutageStart = new Date(row.takenAt).getTime();
      }
    }
    prevOnline = row.online;
  }
  if (currentOutageStart != null) {
    longestOutageMs = Math.max(longestOutageMs, now - currentOutageStart);
    mostRecentOutage = { start: new Date(currentOutageStart).toISOString(), end: null };
  }

  const totalObservedMs = rows.length * SNAPSHOT_INTERVAL_MS;
  const onlineMs = onlineCount * SNAPSHOT_INTERVAL_MS;

  return {
    window,
    insufficientData: requestedStart < earliestAt,
    percentUptime: Math.round((onlineCount / rows.length) * 1000) / 10,
    totalObservedMs,
    onlineMs,
    offlineMs: totalObservedMs - onlineMs,
    outageCount,
    longestOutageMs,
    mostRecentOutage,
    coverageStart: rows[0].takenAt,
    coverageEnd: rows[rows.length - 1].takenAt,
  };
}

/** Takes one hourly snapshot for a single node and writes node_events for
 *  any online<->offline transition or daemon version change detected by
 *  diffing against the immediately preceding snapshot (not the node doc's
 *  live state, since that's what's being snapshotted right now). */
export async function takeSnapshotForNode(node, now = new Date()) {
  const { snapshots, events } = await getNodeHistoryCollections();
  const wallet = node.nodeId;
  const online = isNodeOnline(node.lastHeartbeatAt, now.getTime());

  const previousRows = await snapshots.find({ walletAddress: wallet }).sort({ takenAt: -1 }).limit(1).toArray();
  const prev = previousRows[0] || null;

  await snapshots.insertOne({
    walletAddress: wallet,
    takenAt: now,
    uptimeScoreBps: node.uptimeScoreBps || 0,
    online,
    daemonVersion: node.daemonVersion || null,
  });

  if (prev) {
    if (prev.online !== online) {
      await events.insertOne({
        walletAddress: wallet,
        type: online ? "NODE_RECOVERED" : "NODE_OFFLINE",
        severity: online ? "info" : "warning",
        message: online ? "Node came back online." : "Node stopped reporting heartbeats.",
        meta: {},
        createdAt: now,
      });
    }
    if (prev.daemonVersion && node.daemonVersion && prev.daemonVersion !== node.daemonVersion) {
      await events.insertOne({
        walletAddress: wallet,
        type: "VERSION_CHANGED",
        severity: "info",
        message: `Daemon version changed from ${prev.daemonVersion} to ${node.daemonVersion}.`,
        meta: { from: prev.daemonVersion, to: node.daemonVersion },
        createdAt: now,
      });
    }
  } else {
    await events.insertOne({
      walletAddress: wallet,
      type: "TELEMETRY_STARTED",
      severity: "info",
      message: "Started recording historical telemetry for this node.",
      meta: {},
      createdAt: now,
    });
  }

  return { walletAddress: wallet, online };
}

/** Rolls up one UTC calendar day's snapshots into a pass/fail against the
 *  95% threshold and advances/resets the consecutive-day streak. A day
 *  with zero recorded snapshots moves nothing — no evidence either way, so
 *  no streak movement, rather than guessing. Idempotent per day via
 *  lastCheckedDate. */
export async function advanceQualificationForNode(walletAddress, dateUTC) {
  const { snapshots, qualification, events } = await getNodeHistoryCollections();
  const wallet = walletAddress.toLowerCase();

  const existing = await qualification.findOne({ walletAddress: wallet });
  if (existing?.lastCheckedDate === dateUTC) return existing;

  const dayStart = new Date(`${dateUTC}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const dayRows = await snapshots.find({ walletAddress: wallet, takenAt: { $gte: dayStart, $lt: dayEnd } }).toArray();

  if (dayRows.length === 0) {
    await qualification.updateOne(
      { walletAddress: wallet },
      {
        $set: { lastCheckedDate: dateUTC, status: existing?.status || "insufficient_data" },
        $setOnInsert: { walletAddress: wallet, periodStart: dateUTC, consecutiveQualifyingDays: 0 },
      },
      { upsert: true }
    );
    return qualification.findOne({ walletAddress: wallet });
  }

  const avgBps = dayRows.reduce((sum, r) => sum + (r.uptimeScoreBps || 0), 0) / dayRows.length;
  const passed = avgBps >= QUALIFICATION_UPTIME_THRESHOLD_BPS;
  const now = new Date();

  if (passed) {
    const newStreak = (existing?.consecutiveQualifyingDays || 0) + 1;
    const status = newStreak >= QUALIFICATION_REQUIRED_DAYS ? "qualified" : "on_track";
    await qualification.updateOne(
      { walletAddress: wallet },
      {
        $set: { consecutiveQualifyingDays: newStreak, lastCheckedDate: dateUTC, status },
        $setOnInsert: { walletAddress: wallet, periodStart: existing?.periodStart || dateUTC },
      },
      { upsert: true }
    );
    if (status === "qualified" && existing?.status !== "qualified") {
      await events.insertOne({
        walletAddress: wallet,
        type: "QUALIFICATION_ACHIEVED",
        severity: "info",
        message: `Reached ${QUALIFICATION_REQUIRED_DAYS} consecutive days at ${(QUALIFICATION_UPTIME_THRESHOLD_BPS / 100).toFixed(0)}%+ uptime.`,
        meta: { consecutiveQualifyingDays: newStreak },
        createdAt: now,
      });
    }
  } else {
    const hadStreak = (existing?.consecutiveQualifyingDays || 0) > 0;
    const reason = `Daily average uptime ${(avgBps / 100).toFixed(1)}% fell below the ${(QUALIFICATION_UPTIME_THRESHOLD_BPS / 100).toFixed(0)}% threshold.`;
    await qualification.updateOne(
      { walletAddress: wallet },
      {
        $set: { consecutiveQualifyingDays: 0, lastCheckedDate: dateUTC, status: "at_risk", lastResetAt: now, lastResetReason: reason },
        $setOnInsert: { walletAddress: wallet, periodStart: dateUTC },
      },
      { upsert: true }
    );
    if (hadStreak) {
      await events.insertOne({
        walletAddress: wallet,
        type: "QUALIFICATION_RESET",
        severity: "warning",
        message: `Qualification streak reset — ${reason}`,
        meta: { avgBps },
        createdAt: now,
      });
    }
  }

  return qualification.findOne({ walletAddress: wallet });
}

export async function getQualificationStatus(walletAddress) {
  const { qualification } = await getNodeHistoryCollections();
  const doc = await qualification.findOne({ walletAddress: walletAddress.toLowerCase() });
  if (!doc) {
    return {
      status: "insufficient_data",
      consecutiveQualifyingDays: 0,
      requiredDays: QUALIFICATION_REQUIRED_DAYS,
      thresholdBps: QUALIFICATION_UPTIME_THRESHOLD_BPS,
      reason: "Qualification tracking starts from when this dashboard went live — no history yet.",
    };
  }
  return {
    status: doc.status,
    consecutiveQualifyingDays: doc.consecutiveQualifyingDays || 0,
    requiredDays: QUALIFICATION_REQUIRED_DAYS,
    thresholdBps: QUALIFICATION_UPTIME_THRESHOLD_BPS,
    periodStart: doc.periodStart,
    daysRemaining: Math.max(0, QUALIFICATION_REQUIRED_DAYS - (doc.consecutiveQualifyingDays || 0)),
    lastResetAt: doc.lastResetAt || null,
    lastResetReason: doc.lastResetReason || null,
  };
}

/** Entry point the hourly cron calls. Snapshots every currently-registered
 *  node; once per UTC day (only attempted in the first hour after
 *  midnight, so a full day of snapshots exists to average) advances
 *  qualification for each node against the day that just completed. */
export async function runHourlySnapshot(now = new Date()) {
  await ensureNodeHistoryIndexes();
  const { nodes } = await getNodeHistoryCollections();
  const allNodes = await nodes.find({}, { projection: { nodeId: 1, lastHeartbeatAt: 1, uptimeScoreBps: 1, daemonVersion: 1 } }).toArray();

  const snapshotResults = [];
  for (const node of allNodes) {
    snapshotResults.push(await takeSnapshotForNode(node, now));
  }

  let qualificationChecked = 0;
  if (now.getUTCHours() === 0) {
    const yesterdayUTC = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    for (const node of allNodes) {
      await advanceQualificationForNode(node.nodeId, yesterdayUTC);
      qualificationChecked += 1;
    }
  }

  return { nodesSnapshotted: snapshotResults.length, qualificationChecked };
}
