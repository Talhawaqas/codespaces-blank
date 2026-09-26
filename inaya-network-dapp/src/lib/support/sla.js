// src/lib/support/sla.js
//
// SOW §9, §38, §53: the SLA model. PURE functions only (no database), so every rule is unit-testable and
// deterministic:
//
//   - a business calendar (weekly hours in a named timezone, holidays, or 24x7) that converts between wall
//     time and "active minutes";
//   - stored timer segments: the clock's accumulated active minutes plus, if running, `activeSince`. State is
//     ALWAYS recomputed from those stored values and the calendar, never from an in-memory timer, so a worker
//     outage cannot change an answer (SOW §53);
//   - pause/resume by status, and reassignment never touches the clock (SOW §9.3);
//   - policy selection by type / priority / tier / queue;
//   - the SLA-facing state (ON_TRACK, AT_RISK, BREACHED, PAUSED, COMPLETED).
//
// Escalation side effects (notify, escalate) are applied by slaTick.js through a unique ledger so each
// threshold fires exactly once.

import { zonedToUtc } from "../workflows/schedule.js";

const MIN = 60000;
const MAX_DAYS = 800;
const isSpan = (s) => Array.isArray(s) && s.length === 2;

function localDate(ms, tz) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== "literal") o[p.type] = Number(p.value);
  return { y: o.year, m: o.month, d: o.day };
}
const nextDay = ({ y, m, d }) => { const n = new Date(Date.UTC(y, m - 1, d + 1)); return { y: n.getUTCFullYear(), m: n.getUTCMonth() + 1, d: n.getUTCDate() }; };
const key = ({ y, m, d }) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** [startMs, endMs] business spans (UTC) for one local calendar day. */
export function spansForDay(cal, day) {
  if (cal.mode === "24x7") return [[zonedToUtc(day.y, day.m, day.d, 0, 0, cal.timezone), zonedToUtc(day.y, day.m, day.d + 1, 0, 0, cal.timezone)]];
  if ((cal.holidays || []).includes(key(day))) return [];
  const dow = new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay();
  return (cal.weekly?.[dow] || []).filter(isSpan).map(([a, b]) => {
    const [ah, am] = a.split(":").map(Number); const [bh, bm] = b.split(":").map(Number);
    return [zonedToUtc(day.y, day.m, day.d, ah, am, cal.timezone), zonedToUtc(day.y, day.m, day.d, bh, bm, cal.timezone)];
  });
}

export function makeCalendar(settings, override = null) {
  const b = { ...(settings?.businessHours || {}), ...(override || {}) };
  return { timezone: b.timezone || "UTC", mode: b.mode === "24x7" ? "24x7" : "business", weekly: b.weekly || {}, holidays: b.holidays || [] };
}

/** Active (business) minutes between two instants. */
export function businessMinutesBetween(cal, fromMs, toMs) {
  if (!(toMs > fromMs)) return 0;
  if (cal.mode === "24x7") return (toMs - fromMs) / MIN;
  let total = 0; let day = localDate(fromMs, cal.timezone);
  for (let i = 0; i < MAX_DAYS; i++) {
    for (const [s, e] of spansForDay(cal, day)) { const a = Math.max(s, fromMs); const b = Math.min(e, toMs); if (b > a) total += (b - a) / MIN; }
    const first = zonedToUtc(day.y, day.m, day.d + 1, 0, 0, cal.timezone);
    if (first >= toMs) break;
    day = nextDay(day);
  }
  return total;
}

/** The instant at which `minutes` of business time have elapsed from `fromMs` (null if out of range). */
export function addBusinessMinutes(cal, fromMs, minutes) {
  if (minutes <= 0) return fromMs;
  if (cal.mode === "24x7") return fromMs + minutes * MIN;
  let remaining = minutes; let day = localDate(fromMs, cal.timezone);
  for (let i = 0; i < MAX_DAYS; i++) {
    for (const [s, e] of spansForDay(cal, day)) {
      const a = Math.max(s, fromMs);
      if (e <= a) continue;
      const avail = (e - a) / MIN;
      if (remaining <= avail) return a + remaining * MIN;
      remaining -= avail;
    }
    day = nextDay(day);
  }
  return null;
}

// -------------------------------------------------------------------- policy match
/** The most specific active policy for this ticket; the default (no criteria) policy is the fallback. */
export function selectPolicy(policies, { type, priority, tier, queueId }) {
  let best = null; let bestScore = -1;
  for (const p of policies || []) {
    if (p.active === false) continue;
    const m = p.match || {};
    let score = 0; let ok = true;
    const check = (list, val) => { if (Array.isArray(list) && list.length) { if (list.includes(val)) score++; else ok = false; } };
    check(m.types, type); check(m.priorities, priority); check(m.tiers, tier); check(m.queueIds, queueId ? String(queueId) : null);
    if (!ok) continue;
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return best;
}

export const DEFAULT_ESCALATIONS = [
  { pct: 80, target: "first_response", notify: ["assignee"], action: "notify" }, { pct: 90, target: "first_response", notify: ["team_lead"], action: "notify" }, { pct: 100, target: "first_response", notify: ["team_lead", "managers"], action: "escalate" },
  { pct: 80, target: "resolution", notify: ["assignee"], action: "notify" }, { pct: 90, target: "resolution", notify: ["team_lead"], action: "notify" }, { pct: 100, target: "resolution", notify: ["team_lead", "managers"], action: "escalate" },
];

export function defaultPolicies() {
  const mk = (name, priorities, fr, res, isDefault = false) => ({ name, active: true, isDefault, match: isDefault ? {} : { priorities }, firstResponseMin: fr, resolutionMin: res, escalations: DEFAULT_ESCALATIONS, breachAction: "escalate" });
  return [mk("Urgent", ["URGENT"], 60, 480), mk("High", ["HIGH"], 120, 960), mk("Standard", null, 240, 1440, true), mk("Low priority", ["LOW"], 480, 2400)];
}

// ------------------------------------------------------------------------- timers
const WAIT_KEY = { WAITING_FOR_CUSTOMER: "customer", WAITING_FOR_INTERNAL: "internal", WAITING_FOR_THIRD_PARTY: "thirdParty" };
const TERMINAL = new Set(["SOLVED", "CLOSED", "CANCELLED"]);

export function pauseStatusesFor(policy, settings) { return policy?.pauseStatuses || settings?.lifecycle?.pauseStatuses || ["WAITING_FOR_CUSTOMER", "WAITING_FOR_THIRD_PARTY"]; }

/** Builds the initial SLA record for a new ticket. */
export function startSla({ policy, status, now = Date.now(), settings }) {
  if (!policy) return null;
  const paused = pauseStatusesFor(policy, settings).includes(status);
  return {
    policyId: String(policy._id || ""), policyName: policy.name, pauseStatuses: policy.pauseStatuses || null, escalations: policy.escalations || DEFAULT_ESCALATIONS, breachAction: policy.breachAction || "escalate", escalationQueueId: policy.escalationQueueId ? String(policy.escalationQueueId) : null,
    targets: { firstResponseMin: policy.firstResponseMin, resolutionMin: policy.resolutionMin },
    accum: { firstMin: 0, resolutionMin: 0 }, activeSince: paused ? null : new Date(now).toISOString(),
    firstResponseAt: null, resolvedAt: null, paused, pausedAt: paused ? new Date(now).toISOString() : null,
    waitingMs: { customer: 0, internal: 0, thirdParty: 0 }, waitingSince: WAIT_KEY[status] ? { key: WAIT_KEY[status], at: new Date(now).toISOString() } : null,
    breached: { first_response: false, resolution: false }, startedAt: new Date(now).toISOString(), reopened: 0,
  };
}

function closeSegment(sla, cal, now) {
  if (!sla.activeSince) return sla;
  const mins = businessMinutesBetween(cal, Date.parse(sla.activeSince), now);
  if (!sla.firstResponseAt) sla.accum.firstMin += mins;
  if (!sla.resolvedAt) sla.accum.resolutionMin += mins;
  sla.activeSince = null;
  return sla;
}

/** Applies a status change to the clock. Reassignment / priority changes never call this (SOW §9.3). */
export function onStatusChange(slaIn, { from, to, cal, policy, settings, now = Date.now() }) {
  if (!slaIn) return slaIn;
  const sla = JSON.parse(JSON.stringify(slaIn));
  const nowIso = new Date(now).toISOString();
  // waiting-time bookkeeping (customer / internal / third-party)
  if (sla.waitingSince && WAIT_KEY[from]) { sla.waitingMs[sla.waitingSince.key] += Math.max(0, now - Date.parse(sla.waitingSince.at)); sla.waitingSince = null; }
  if (WAIT_KEY[to]) sla.waitingSince = { key: WAIT_KEY[to], at: nowIso };
  const pauses = pauseStatusesFor({ pauseStatuses: sla.pauseStatuses }, settings);
  if (TERMINAL.has(to)) {
    closeSegment(sla, cal, now);
    if (to === "SOLVED" || to === "CLOSED") { if (!sla.resolvedAt) sla.resolvedAt = nowIso; }
    sla.paused = false; sla.pausedAt = null;
  } else if (TERMINAL.has(from) && from !== "CANCELLED") {
    // reopen: the clock continues from what was already consumed (it is not reset)
    sla.resolvedAt = null; sla.reopened = (sla.reopened || 0) + 1;
    sla.paused = pauses.includes(to); sla.pausedAt = sla.paused ? nowIso : null; sla.activeSince = sla.paused ? null : nowIso;
  } else if (pauses.includes(to) && !pauses.includes(from)) {
    closeSegment(sla, cal, now); sla.paused = true; sla.pausedAt = nowIso;
  } else if (!pauses.includes(to) && pauses.includes(from)) {
    sla.paused = false; sla.pausedAt = null; if (!sla.activeSince && !TERMINAL.has(to)) sla.activeSince = nowIso;
  }
  return sla;
}

/** First public reply by an agent stops the first-response clock (the resolution clock keeps running). */
export function onFirstResponse(slaIn, { cal, now = Date.now() }) {
  if (!slaIn || slaIn.firstResponseAt) return slaIn;
  const sla = JSON.parse(JSON.stringify(slaIn));
  if (sla.activeSince) sla.accum.firstMin += businessMinutesBetween(cal, Date.parse(sla.activeSince), now);
  // the running segment continues for the resolution clock: restart it from now so first-response minutes are not double counted
  if (sla.activeSince) { const carry = businessMinutesBetween(cal, Date.parse(sla.activeSince), now); sla.accum.resolutionMin += carry; sla.activeSince = new Date(now).toISOString(); }
  sla.firstResponseAt = new Date(now).toISOString();
  return sla;
}

/** Recomputes everything a viewer or the scheduler needs, from stored values only. */
export function evaluateSla(sla, { cal, settings, now = Date.now() }) {
  if (!sla) return null;
  const running = sla.activeSince ? businessMinutesBetween(cal, Date.parse(sla.activeSince), now) : 0;
  const t = sla.targets;
  const firstUsed = sla.firstResponseAt ? sla.accum.firstMin : sla.accum.firstMin + running;
  const resUsed = sla.resolvedAt ? sla.accum.resolutionMin : sla.accum.resolutionMin + running;
  const pct = (used, target) => (target > 0 ? (used / target) * 100 : 0);
  const firstPct = pct(firstUsed, t.firstResponseMin); const resPct = pct(resUsed, t.resolutionMin);
  const breached = { first_response: sla.breached?.first_response || firstPct >= 100, resolution: sla.breached?.resolution || resPct >= 100 };
  const complete = !!sla.resolvedAt;
  const anyBreach = breached.first_response || breached.resolution;
  const atRiskPct = settings?.sla?.atRiskPct ?? 80;
  const openPct = Math.max(sla.firstResponseAt ? 0 : firstPct, complete ? 0 : resPct);
  let state;
  if (complete) state = "COMPLETED";
  else if (anyBreach) state = "BREACHED";
  else if (sla.paused) state = "PAUSED";
  else if (openPct >= atRiskPct) state = "AT_RISK";
  else state = "ON_TRACK";
  const due = (used, target, done) => (done || !sla.activeSince ? null : addBusinessMinutes(cal, Date.parse(sla.activeSince), Math.max(0, target - (used - running))));
  const fDue = due(firstUsed, t.firstResponseMin, !!sla.firstResponseAt); const rDue = due(resUsed, t.resolutionMin, complete);
  return {
    state, firstPct: Math.round(firstPct * 10) / 10, resolutionPct: Math.round(resPct * 10) / 10, breached,
    firstResponseDueAt: fDue ? new Date(fDue).toISOString() : null, resolutionDueAt: rDue ? new Date(rDue).toISOString() : null,
    timers: { firstResponseMin: Math.round(firstUsed), resolutionMin: Math.round(resUsed), customerWaitingMin: Math.round(waitMs(sla, "customer", now) / MIN), internalWaitingMin: Math.round(waitMs(sla, "internal", now) / MIN), thirdPartyWaitingMin: Math.round(waitMs(sla, "thirdParty", now) / MIN), totalActiveMin: Math.round(sla.accum.resolutionMin + (sla.resolvedAt ? 0 : running)) },
  };
}
function waitMs(sla, key, now) { return (sla.waitingMs?.[key] || 0) + (sla.waitingSince?.key === key ? Math.max(0, now - Date.parse(sla.waitingSince.at)) : 0); }

/** Which escalation rules have been crossed as of `now` (not yet applied: the ledger decides). */
export function crossedRules(sla, policy, evaluation) {
  const out = [];
  for (const r of policy?.escalations || []) {
    const done = r.target === "first_response" ? !!sla.firstResponseAt : !!sla.resolvedAt;
    const pct = r.target === "first_response" ? evaluation.firstPct : evaluation.resolutionPct;
    if (!done && pct >= r.pct) out.push(r);
  }
  return out;
}

/** The earliest instant at which some not-yet-crossed rule will be crossed (drives the scheduler's next look). */
export function nextCheckTime(sla, policy, cal, now = Date.now()) {
  if (!sla || sla.resolvedAt) return null;
  let best = null;
  for (const r of policy?.escalations || []) {
    const done = r.target === "first_response" ? !!sla.firstResponseAt : !!sla.resolvedAt;
    if (done) continue;
    const target = r.target === "first_response" ? sla.targets.firstResponseMin : sla.targets.resolutionMin;
    const used = (r.target === "first_response" ? sla.accum.firstMin : sla.accum.resolutionMin);
    const need = (target * r.pct) / 100 - used;
    if (need <= 0) { best = now; continue; }
    if (!sla.activeSince) continue; // paused: nothing will be crossed until it resumes
    const t = addBusinessMinutes(cal, Date.parse(sla.activeSince), need);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}
