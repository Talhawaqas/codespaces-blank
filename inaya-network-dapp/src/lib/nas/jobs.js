// src/lib/nas/jobs.js
//
// Sovereign NAS SOW Section 39: every background operation must be
// IDEMPOTENT, RESUMABLE, RETRYABLE, AUDITABLE and OBSERVABLE, with explicit
// states, and a restart must never duplicate backup data, replication data,
// evidence events, recovery operations or notifications.
//
// One durable job table (nasJobs) serves backup, replication, snapshots,
// scans, tiering and drills:
//   - IDEMPOTENT: enqueueing the same idempotencyKey returns the existing job
//     (unique index on orgId + idempotencyKey), never a second one.
//   - RESUMABLE: a job's `checkpoint` is handed back to its handler on every
//     attempt, so a retry continues instead of starting over.
//   - RETRYABLE: failures back off exponentially up to maxAttempts.
//   - A worker that died mid-run (stale heartbeat) has its job recovered.
//   - Claiming is an atomic findOneAndUpdate, so two workers never run one job.

import { getOrgCollections, toObjectId } from "../orgs.js";

export const JOB_STATES = ["QUEUED", "RUNNING", "PAUSED", "COMPLETED", "FAILED", "CANCELLED", "RETRYING", "DEGRADED", "RECOVERY_REQUIRED"];
export const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "DEGRADED", "RECOVERY_REQUIRED"]);
const STALE_HEARTBEAT_MS = 5 * 60 * 1000;

const HANDLERS = new Map();

/** Modules register the handler for their job kind: (job, ctx) => result. */
export function registerJobHandler(kind, fn) {
  HANDLERS.set(kind, fn);
}

export function hasJobHandler(kind) {
  return HANDLERS.has(kind);
}

function backoffMs(attempts) {
  return Math.min(30 * 60 * 1000, 15000 * 2 ** Math.max(0, attempts - 1));
}

export async function enqueueJob({ orgId, applianceId = null, shareId = null, kind, payload = {}, idempotencyKey, maxAttempts = 3, actorEmail = "system", delaySeconds = 0 }) {
  if (!idempotencyKey) throw new Error("A job needs an idempotencyKey.");
  const { nasJobs } = await getOrgCollections();
  const now = new Date();
  const doc = {
    orgId: toObjectId(orgId), applianceId: applianceId ? toObjectId(applianceId) : null, shareId: shareId ? toObjectId(shareId) : null,
    kind, payload, idempotencyKey, status: "QUEUED", attempts: 0, maxAttempts, checkpoint: null, result: null, lastError: null,
    createdBy: actorEmail, createdAt: now.toISOString(), startedAt: null, finishedAt: null, heartbeatAt: null,
    nextAttemptAt: new Date(now.getTime() + delaySeconds * 1000).toISOString(),
  };
  const existing = await nasJobs.findOne({ orgId: doc.orgId, idempotencyKey });
  if (existing) return { job: existing, created: false };
  try {
    const r = await nasJobs.insertOne(doc);
    return { job: { ...doc, _id: r.insertedId }, created: true };
  } catch (err) {
    if (err?.code === 11000) return { job: await nasJobs.findOne({ orgId: doc.orgId, idempotencyKey }), created: false };
    throw err;
  }
}

export async function getJob({ orgId, jobId }) {
  const { nasJobs } = await getOrgCollections();
  try { return await nasJobs.findOne({ _id: toObjectId(jobId), orgId: toObjectId(orgId) }); } catch { return null; }
}

export async function listJobs({ orgId, applianceId, shareId, kind, status, limit = 50 }) {
  const { nasJobs } = await getOrgCollections();
  const q = { orgId: toObjectId(orgId) };
  if (applianceId) q.applianceId = toObjectId(applianceId);
  if (shareId) q.shareId = toObjectId(shareId);
  if (kind) q.kind = kind;
  if (status) q.status = status;
  return nasJobs.find(q).sort({ createdAt: -1 }).limit(Math.min(limit, 200)).toArray();
}

/** Puts back any RUNNING job whose worker stopped heartbeating. */
export async function recoverStaleJobs({ orgId } = {}) {
  const { nasJobs } = await getOrgCollections();
  const cutoff = new Date(Date.now() - STALE_HEARTBEAT_MS).toISOString();
  const q = { status: "RUNNING", heartbeatAt: { $lt: cutoff } };
  if (orgId) q.orgId = toObjectId(orgId);
  const stale = await nasJobs.find(q).toArray();
  let recovered = 0;
  for (const j of stale) {
    const next = j.attempts >= j.maxAttempts ? "FAILED" : "RETRYING";
    const r = await nasJobs.updateOne({ _id: j._id, status: "RUNNING", heartbeatAt: j.heartbeatAt }, { $set: { status: next, lastError: "The worker running this job stopped responding; it will resume from its checkpoint.", nextAttemptAt: new Date().toISOString(), finishedAt: next === "FAILED" ? new Date().toISOString() : null } });
    if (r.modifiedCount) recovered++;
  }
  return recovered;
}

async function claim(jobId) {
  const { nasJobs } = await getOrgCollections();
  const now = new Date().toISOString();
  const res = await nasJobs.findOneAndUpdate(
    { _id: toObjectId(jobId), status: { $in: ["QUEUED", "RETRYING"] }, nextAttemptAt: { $lte: now } },
    { $set: { status: "RUNNING", startedAt: now, heartbeatAt: now }, $inc: { attempts: 1 } },
    { returnDocument: "after" }
  );
  return res?.value ?? res;
}

/** Runs one job through its registered handler. Safe to call concurrently. */
export async function runJob({ jobId }) {
  const { nasJobs } = await getOrgCollections();
  const job = await claim(jobId);
  if (!job) return { ran: false, reason: "Not runnable (already running, finished, paused, or not due)." };
  const handler = HANDLERS.get(job.kind);
  if (!handler) {
    await nasJobs.updateOne({ _id: job._id }, { $set: { status: "FAILED", lastError: `No handler for job kind ${job.kind}`, finishedAt: new Date().toISOString() } });
    return { ran: true, status: "FAILED" };
  }
  const beat = async (checkpoint) => {
    await nasJobs.updateOne({ _id: job._id, status: "RUNNING" }, { $set: { heartbeatAt: new Date().toISOString(), ...(checkpoint !== undefined ? { checkpoint } : {}) } });
  };
  try {
    const out = await handler(job, { beat, checkpoint: job.checkpoint });
    const status = out?.status && JOB_STATES.includes(out.status) ? out.status : "COMPLETED";
    await nasJobs.updateOne({ _id: job._id }, { $set: { status, result: out?.result ?? out ?? null, lastError: out?.warning || null, finishedAt: new Date().toISOString() } });
    return { ran: true, status, result: out?.result ?? out };
  } catch (err) {
    const recovery = err.code === "RECOVERY_REQUIRED";
    const exhausted = job.attempts >= job.maxAttempts;
    const status = recovery ? "RECOVERY_REQUIRED" : exhausted ? "FAILED" : "RETRYING";
    await nasJobs.updateOne({ _id: job._id }, { $set: { status, lastError: String(err.message).slice(0, 500), nextAttemptAt: new Date(Date.now() + backoffMs(job.attempts)).toISOString(), finishedAt: status === "RETRYING" ? null : new Date().toISOString() } });
    return { ran: true, status, error: err.message };
  }
}

export async function pauseJob({ orgId, jobId }) {
  const { nasJobs } = await getOrgCollections();
  const r = await nasJobs.updateOne({ _id: toObjectId(jobId), orgId: toObjectId(orgId), status: { $in: ["QUEUED", "RETRYING"] } }, { $set: { status: "PAUSED" } });
  return r.modifiedCount ? { paused: true } : { error: "Only a queued or retrying job can be paused.", status: 409 };
}

export async function resumeJob({ orgId, jobId }) {
  const { nasJobs } = await getOrgCollections();
  const r = await nasJobs.updateOne({ _id: toObjectId(jobId), orgId: toObjectId(orgId), status: { $in: ["PAUSED", "FAILED", "RECOVERY_REQUIRED", "DEGRADED"] } }, { $set: { status: "QUEUED", nextAttemptAt: new Date().toISOString(), attempts: 0, finishedAt: null, lastError: null } });
  return r.modifiedCount ? { resumed: true } : { error: "That job cannot be resumed.", status: 409 };
}

export async function cancelJob({ orgId, jobId }) {
  const { nasJobs } = await getOrgCollections();
  const r = await nasJobs.updateOne({ _id: toObjectId(jobId), orgId: toObjectId(orgId), status: { $in: ["QUEUED", "RETRYING", "PAUSED"] } }, { $set: { status: "CANCELLED", finishedAt: new Date().toISOString() } });
  return r.modifiedCount ? { cancelled: true } : { error: "Only a queued, retrying or paused job can be cancelled.", status: 409 };
}

/** Runs every due job (bounded). Used by the cron/worker entry point. */
export async function processDueJobs({ orgId, limit = 10, budgetMs = 240000 } = {}) {
  const { nasJobs } = await getOrgCollections();
  const started = Date.now();
  await recoverStaleJobs({ orgId });
  const q = { status: { $in: ["QUEUED", "RETRYING"] }, nextAttemptAt: { $lte: new Date().toISOString() } };
  if (orgId) q.orgId = toObjectId(orgId);
  const due = await nasJobs.find(q).sort({ nextAttemptAt: 1 }).limit(limit).toArray();
  const results = [];
  for (const j of due) {
    if (Date.now() - started > budgetMs) break;
    results.push({ jobId: String(j._id), kind: j.kind, ...(await runJob({ jobId: j._id })) });
  }
  return { processed: results.length, results };
}

/** Observability (SOW 40): counts by state/kind and the oldest queued job. */
export async function summarizeJobs({ orgId, applianceId }) {
  const { nasJobs } = await getOrgCollections();
  const q = { orgId: toObjectId(orgId) };
  if (applianceId) q.applianceId = toObjectId(applianceId);
  const rows = await nasJobs.aggregate([{ $match: q }, { $group: { _id: { status: "$status", kind: "$kind" }, count: { $sum: 1 } } }]).toArray();
  const oldest = await nasJobs.find({ ...q, status: { $in: ["QUEUED", "RETRYING"] } }).sort({ createdAt: 1 }).limit(1).toArray();
  const byStatus = {};
  for (const r of rows) byStatus[r._id.status] = (byStatus[r._id.status] || 0) + r.count;
  return { byStatus, byKind: rows.map((r) => ({ status: r._id.status, kind: r._id.kind, count: r.count })), oldestQueuedAt: oldest[0]?.createdAt || null };
}
