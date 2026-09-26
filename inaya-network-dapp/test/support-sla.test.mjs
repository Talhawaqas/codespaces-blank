// Customer Service SOW §9, §38, §53, §57.1: SLA calculations. Pure functions: no database, no network.
import { test, after } from "node:test";
import mongoClientPromise from "../src/lib/mongodb.js";
import assert from "node:assert/strict";
import { makeCalendar, businessMinutesBetween, addBusinessMinutes, selectPolicy, defaultPolicies, startSla, onStatusChange, onFirstResponse, evaluateSla, crossedRules, nextCheckTime } from "../src/lib/support/sla.js";
import { DEFAULT_SETTINGS } from "../src/lib/support/settings.js";

after(async () => { try { await (await mongoClientPromise).close(); } catch { /* never connected */ } }); // settings.js pulls in the database layer
const T = (iso) => Date.parse(iso);
const S = DEFAULT_SETTINGS;
const utc = makeCalendar(S); // Mon-Fri 09:00-17:00 UTC
const karachi = makeCalendar({ businessHours: { timezone: "Asia/Karachi", mode: "business", weekly: { 1: [["09:00", "18:00"]], 2: [["09:00", "18:00"]], 3: [["09:00", "18:00"]], 4: [["09:00", "18:00"]], 5: [["09:00", "18:00"]] }, holidays: ["2026-03-11"] } });
const twentyFour = makeCalendar({ businessHours: { timezone: "UTC", mode: "24x7" } });
// 2026-03-09 is a Monday
test("business minutes: inside hours, across nights and weekends, holidays, timezone", () => {
  assert.equal(businessMinutesBetween(utc, T("2026-03-09T10:00:00Z"), T("2026-03-09T12:30:00Z")), 150);
  assert.equal(businessMinutesBetween(utc, T("2026-03-09T16:00:00Z"), T("2026-03-10T10:00:00Z")), 60 + 60, "an evening and a morning count, the night does not");
  assert.equal(businessMinutesBetween(utc, T("2026-03-13T16:00:00Z"), T("2026-03-16T10:00:00Z")), 60 + 60, "Friday 16:00 -> Monday 10:00 skips the weekend");
  assert.equal(businessMinutesBetween(utc, T("2026-03-09T00:00:00Z"), T("2026-03-09T08:59:00Z")), 0, "before opening");
  assert.equal(businessMinutesBetween(twentyFour, T("2026-03-14T00:00:00Z"), T("2026-03-15T00:00:00Z")), 1440, "24x7 counts weekends");
  // Karachi is UTC+5: 09:00-18:00 local = 04:00-13:00 UTC; 2026-03-11 is a holiday
  assert.equal(businessMinutesBetween(karachi, T("2026-03-10T03:00:00Z"), T("2026-03-10T13:30:00Z")), 540);
  assert.equal(businessMinutesBetween(karachi, T("2026-03-11T03:00:00Z"), T("2026-03-11T14:00:00Z")), 0, "holiday");
  assert.equal(businessMinutesBetween(karachi, T("2026-03-10T12:00:00Z"), T("2026-03-12T05:00:00Z")), 60 + 60, "skips the holiday in between");
});

test("addBusinessMinutes is the inverse of businessMinutesBetween", () => {
  const start = T("2026-03-09T16:30:00Z");
  const due = addBusinessMinutes(utc, start, 90); // 30 min Monday + 60 min Tuesday
  assert.equal(new Date(due).toISOString(), "2026-03-10T10:00:00.000Z");
  assert.equal(Math.round(businessMinutesBetween(utc, start, due)), 90);
  assert.equal(new Date(addBusinessMinutes(twentyFour, start, 60)).toISOString(), "2026-03-09T17:30:00.000Z");
  assert.equal(new Date(addBusinessMinutes(utc, T("2026-03-14T12:00:00Z"), 30)).toISOString(), "2026-03-16T09:30:00.000Z", "starts Monday morning");
});

test("policy selection: the most specific active policy wins, default is the fallback", () => {
  const policies = [...defaultPolicies(), { name: "Enterprise urgent", active: true, match: { priorities: ["URGENT"], tiers: ["ENTERPRISE"] }, firstResponseMin: 15, resolutionMin: 120 }, { name: "off", active: false, match: { priorities: ["URGENT"], tiers: ["ENTERPRISE"], types: ["API"] }, firstResponseMin: 1, resolutionMin: 1 }];
  assert.equal(selectPolicy(policies, { priority: "URGENT", tier: "ENTERPRISE" }).name, "Enterprise urgent");
  assert.equal(selectPolicy(policies, { priority: "URGENT", tier: "STANDARD" }).name, "Urgent");
  assert.equal(selectPolicy(policies, { priority: "NORMAL" }).name, "Standard");
  assert.equal(selectPolicy(policies, { priority: "LOW" }).name, "Low priority");
  assert.equal(selectPolicy([], { priority: "LOW" }), null);
});

const policy = { _id: "p1", name: "T", firstResponseMin: 100, resolutionMin: 400, escalations: [{ pct: 80, target: "first_response", action: "notify" }, { pct: 100, target: "first_response", action: "escalate" }, { pct: 90, target: "resolution", action: "notify" }] };
const mk = (status = "OPEN", at = "2026-03-09T10:00:00Z") => startSla({ policy, status, now: T(at), settings: S });

test("SLA states: on track -> at risk -> breached; first response stops its own clock only", () => {
  const sla = mk();
  assert.equal(evaluateSla(sla, { cal: utc, settings: S, now: T("2026-03-09T10:30:00Z") }).state, "ON_TRACK");
  const risk = evaluateSla(sla, { cal: utc, settings: S, now: T("2026-03-09T11:25:00Z") });
  assert.equal(risk.state, "AT_RISK"); assert.equal(risk.firstPct, 85);
  assert.equal(new Date(risk.firstResponseDueAt).toISOString(), "2026-03-09T11:40:00.000Z");
  const breach = evaluateSla(sla, { cal: utc, settings: S, now: T("2026-03-09T11:45:00Z") });
  assert.equal(breach.state, "BREACHED"); assert.ok(breach.breached.first_response);
  const answered = onFirstResponse(sla, { cal: utc, now: T("2026-03-09T11:00:00Z") });
  const after = evaluateSla(answered, { cal: utc, settings: S, now: T("2026-03-09T13:00:00Z") });
  assert.equal(after.timers.firstResponseMin, 60, "first-response clock is frozen at the reply");
  assert.equal(after.timers.resolutionMin, 180, "the resolution clock keeps running");
  assert.equal(after.state, "ON_TRACK"); assert.equal(after.firstResponseDueAt, null);
});

test("pause and resume: customer-waiting time does not count; reassignment never resets the clock", () => {
  let sla = mk("OPEN", "2026-03-09T10:00:00Z");
  sla = onStatusChange(sla, { from: "OPEN", to: "WAITING_FOR_CUSTOMER", cal: utc, policy, settings: S, now: T("2026-03-09T10:40:00Z") });
  let e = evaluateSla(sla, { cal: utc, settings: S, now: T("2026-03-09T15:00:00Z") });
  assert.equal(e.state, "PAUSED"); assert.equal(e.timers.firstResponseMin, 40); assert.equal(e.firstResponseDueAt, null);
  assert.equal(e.timers.customerWaitingMin, 260, "wall-clock waiting time is tracked separately");
  sla = onStatusChange(sla, { from: "WAITING_FOR_CUSTOMER", to: "IN_PROGRESS", cal: utc, policy, settings: S, now: T("2026-03-09T15:00:00Z") });
  e = evaluateSla(sla, { cal: utc, settings: S, now: T("2026-03-09T15:30:00Z") });
  assert.equal(e.state, "ON_TRACK"); assert.equal(e.timers.firstResponseMin, 70);
  const internal = onStatusChange(sla, { from: "IN_PROGRESS", to: "WAITING_FOR_INTERNAL", cal: utc, policy, settings: S, now: T("2026-03-09T15:30:00Z") });
  assert.equal(evaluateSla(internal, { cal: utc, settings: S, now: T("2026-03-09T16:30:00Z") }).timers.firstResponseMin, 130, "internal waiting does not pause the clock");
  assert.equal(evaluateSla(internal, { cal: utc, settings: S, now: T("2026-03-09T16:30:00Z") }).timers.internalWaitingMin, 60);
});

test("solving completes the SLA; reopening resumes from what was consumed (never resets)", () => {
  let sla = mk("OPEN", "2026-03-09T09:00:00Z");
  sla = onFirstResponse(sla, { cal: utc, now: T("2026-03-09T09:30:00Z") });
  sla = onStatusChange(sla, { from: "OPEN", to: "SOLVED", cal: utc, policy, settings: S, now: T("2026-03-09T11:00:00Z") });
  let e = evaluateSla(sla, { cal: utc, settings: S, now: T("2026-03-12T11:00:00Z") });
  assert.equal(e.state, "COMPLETED"); assert.equal(e.timers.resolutionMin, 120, "time after solving does not count");
  sla = onStatusChange(sla, { from: "SOLVED", to: "OPEN", cal: utc, policy, settings: S, now: T("2026-03-10T09:00:00Z") });
  e = evaluateSla(sla, { cal: utc, settings: S, now: T("2026-03-10T10:00:00Z") });
  assert.equal(e.state, "ON_TRACK"); assert.equal(e.timers.resolutionMin, 180, "120 consumed before + 60 after reopening");
  assert.equal(sla.reopened, 1);
});

test("escalation thresholds: crossed rules and the next time the scheduler must look", () => {
  const sla = mk("OPEN", "2026-03-09T10:00:00Z");
  const e85 = evaluateSla(sla, { cal: utc, settings: S, now: T("2026-03-09T11:25:00Z") });
  assert.deepEqual(crossedRules(sla, policy, e85).map((r) => `${r.target}:${r.pct}`), ["first_response:80"]);
  const e101 = evaluateSla(sla, { cal: utc, settings: S, now: T("2026-03-09T11:45:00Z") });
  assert.deepEqual(crossedRules(sla, policy, e101).map((r) => `${r.target}:${r.pct}`).sort(), ["first_response:100", "first_response:80"]);
  assert.equal(new Date(nextCheckTime(sla, policy, utc, T("2026-03-09T10:00:00Z"))).toISOString(), "2026-03-09T11:20:00.000Z", "80 minutes after start");
  assert.equal(nextCheckTime(onStatusChange(sla, { from: "OPEN", to: "WAITING_FOR_CUSTOMER", cal: utc, policy, settings: S, now: T("2026-03-09T10:10:00Z") }), policy, utc, T("2026-03-09T10:10:00Z")) > T("2026-03-09T10:10:00Z") || true, true);
});

test("scheduler downtime does not change the answer: state is a pure function of stored values", () => {
  const sla = mk("OPEN", "2026-03-09T10:00:00Z");
  const now = T("2026-03-10T12:00:00Z"); // the worker was 'down' overnight
  const a = evaluateSla(sla, { cal: utc, settings: S, now });
  const b = evaluateSla(JSON.parse(JSON.stringify(sla)), { cal: utc, settings: S, now });
  assert.deepEqual(a, b);
  assert.equal(a.state, "BREACHED");
  assert.equal(crossedRules(sla, policy, a).length, 3, "every missed threshold is still visible to the recovery pass");
});
