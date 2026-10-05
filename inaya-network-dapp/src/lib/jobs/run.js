// src/lib/jobs/run.js
//
// Reliability wrapper for the background jobs added by the Competitive Expansion SOW (RELIAB-001, SOW section 42). A job run:
//   * is tenant-scoped: a run belongs to one organization or is explicitly platform-wide (`orgId: null`);
//   * cannot overlap itself: a second run of the same job and scope while one holds the lease is SKIPPED, never run twice (no duplicate destructive execution);
//   * records start, heartbeat, finish, attempts and a redacted failure, so a job's history can be read and trusted;
//   * retries with bounded exponential backoff (and gives up, recording the failure);
//   * detects STALE runs: a run whose heartbeat stopped is marked stale and replaced, so a crashed worker never blocks the job forever;
//   * can enforce a minimum interval (a job that already succeeded recently is not run again), which keeps repeated cron invocations idempotent.
// The job function itself must be safe to re-enter; the wrapper guarantees at most one live run and a clear record, not exactly-once semantics.

import { ObjectId } from "mongodb";
import { getOrgCollections, toObjectId } from "../orgs.js";

export const DEFAULTS = { staleSeconds: 900, retries: 2, backoffMs: [500, 2000, 8000], minIntervalSeconds: 0 };
const nowMs = () => Date.now(); const iso = (ms) => new Date(ms).toISOString();
export const redact = (e) => String((e && (e.message || e)) || "error").replace(/(bearer\s+)[a-z0-9._-]+/gi, "$1[redacted]").replace(/(secret|token|password|key)=\S+/gi, "$1=[redacted]").replace(/mongodb(\+srv)?:\/\/\S+/gi, "[db-url]").slice(0, 240);

async function runs() { const { db } = await getOrgCollections(); const c = db.collection("job_runs"); if (!runs.done) { await Promise.all([c.createIndex({ name: 1, orgId: 1, startedAt: -1 }), c.createIndex({ status: 1, heartbeatAt: 1 }), c.createIndex({ leaseKey: 1 }, { unique: true, partialFilterExpression: { status: "running" } }), c.createIndex({ startedAt: 1 }, { expireAfterSeconds: 90 * 86400 })]); runs.done = true; } return c; }
const scopeOf = (orgId) => (orgId ? toObjectId(orgId) : null);

/**
 * withJobRun({ name, orgId, fn, ...options }) -> { status: "succeeded" | "failed" | "skipped", reason?, result?, attempts, runId }
 * fn receives { heartbeat() } and should call it during long work so the lease stays alive.
 */
export async function withJobRun({ name, orgId = null, fn, staleSeconds = DEFAULTS.staleSeconds, retries = DEFAULTS.retries, backoffMs = DEFAULTS.backoffMs, minIntervalSeconds = DEFAULTS.minIntervalSeconds, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = nowMs }) {
  const c = await runs(); const scope = scopeOf(orgId); const t0 = now();
  // stale takeover: a "running" run whose heartbeat stopped is not running
  await c.updateMany({ name, orgId: scope, status: "running", heartbeatAt: { $lt: iso(t0 - staleSeconds * 1000) } }, { $set: { status: "stale", finishedAt: iso(t0), error: "No heartbeat; replaced by a newer run." } });
  if (minIntervalSeconds > 0) { const last = await c.findOne({ name, orgId: scope, status: "succeeded", finishedAt: { $gt: iso(t0 - minIntervalSeconds * 1000) } }); if (last) return { status: "skipped", reason: "ran recently", runId: String(last._id), attempts: 0 }; }
  const run = { _id: new ObjectId(), name, orgId: scope, status: "running", startedAt: iso(t0), heartbeatAt: iso(t0), attempts: 0, error: null };
  // only one live run per (name, scope): a unique index over running runs makes the claim atomic across processes
  const key = `${name}:${scope ? String(scope) : "platform"}`; try { await c.insertOne({ ...run, leaseKey: key }); } catch (e) { if (e?.code === 11000) return { status: "skipped", reason: "already running", attempts: 0 }; throw e; }
  const heartbeat = async () => { await c.updateOne({ _id: run._id }, { $set: { heartbeatAt: iso(now()) } }); };
  let attempt = 0, lastError = null;
  for (;;) {
    attempt++; await c.updateOne({ _id: run._id }, { $set: { attempts: attempt } });
    try { const result = await fn({ heartbeat, attempt }); await c.updateOne({ _id: run._id }, { $set: { status: "succeeded", finishedAt: iso(now()), result: safeResult(result), error: null }, $unset: { leaseKey: "" } }); return { status: "succeeded", result, attempts: attempt, runId: String(run._id) }; }
    catch (e) { lastError = redact(e); if (attempt > retries) break; await c.updateOne({ _id: run._id }, { $set: { error: `attempt ${attempt} failed: ${lastError}` } }); await sleep(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 1000); }
  }
  await c.updateOne({ _id: run._id }, { $set: { status: "failed", finishedAt: iso(now()), error: lastError }, $unset: { leaseKey: "" } });
  return { status: "failed", error: lastError, attempts: attempt, runId: String(run._id) };
}
const safeResult = (r) => { try { const s = JSON.stringify(r ?? null); return s.length > 2000 ? { truncated: true } : JSON.parse(s); } catch { return null; } };

export async function listRuns({ name = null, orgId = undefined, status = null, limit = 50 } = {}) {
  const c = await runs(); const q = {}; if (name) q.name = name; if (orgId !== undefined) q.orgId = scopeOf(orgId); if (status) q.status = status;
  return (await c.find(q).sort({ startedAt: -1 }).limit(Math.min(limit, 200)).toArray()).map((r) => ({ runId: String(r._id), name: r.name, orgId: r.orgId ? String(r.orgId) : null, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt || null, attempts: r.attempts, error: r.error || null }));
}
/** Runs that say "running" but have not reported in: what an operator should look at. */
export async function staleRuns({ staleSeconds = DEFAULTS.staleSeconds, now = nowMs } = {}) { const c = await runs(); return (await c.find({ status: "running", heartbeatAt: { $lt: iso(now() - staleSeconds * 1000) } }).limit(100).toArray()).map((r) => ({ runId: String(r._id), name: r.name, orgId: r.orgId ? String(r.orgId) : null, startedAt: r.startedAt, heartbeatAt: r.heartbeatAt })); }
