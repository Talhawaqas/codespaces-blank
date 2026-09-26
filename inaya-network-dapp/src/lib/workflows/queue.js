// src/lib/workflows/queue.js
//
// SOW §21, §38, §58, §59: the durable execution queue and the scheduler.
//
// Nothing here needs a third-party queue. Durable state lives in
// `workflowExecutions`; a worker CLAIMS an execution with one atomic
// findOneAndUpdate that sets a lease (owner + expiry) and keeps it alive with a
// heartbeat. That single primitive gives:
//   - no double-execution: two workers cannot both win the same claim;
//   - crash recovery: an execution whose lease expired is claimed again and RESUMED
//     (finished nodes are not re-run; side effects are idempotent);
//   - retry with backoff (a node's retry time is stored as nextAttemptAt);
//   - dead-lettering: an execution claimed too many times is FAILED, not looped forever;
//   - bounded concurrency: per-workflow concurrent/hourly/daily ceilings at enqueue time.
// The scheduler is server-authoritative: it only ever reads the published
// definition, re-checks the owner's live membership, and refuses (with a recorded
// reason) rather than run under an obsolete permission context.

import { getOrgCollections, toObjectId, getMembership } from "../orgs.js";
import { nextRun } from "./schedule.js";
import { normalizeSettings } from "./nodes.js";
import { runExecution, resolveApprovalWaits, orgIsActive, LeaseLost } from "./engine.js";
import { recordWorkflowEvidence } from "./evidence.js";
import { runDataNode } from "./data.js";
import { buildDataContext } from "./data.js";
import { canonicalHash } from "../documentAutomation/manifest.js";
import { fail } from "./common.js";

const LEASE_MS = 60_000;
const MAX_CLAIMS = 8;
const APPROVAL_WAIT_LIMIT_MS = 8 * 86400000;
const MAX_PAYLOAD_BYTES = 64 * 1024;
export const ACTIVE_STATES = ["QUEUED", "RUNNING", "WAITING", "WAITING_APPROVAL", "PAUSED"];

// ------------------------------------------------------------------ enqueue
export async function enqueueExecution({ orgId, workflow, version, definition = null, mode = "production", trigger, runAs, initiatingIdentity, idempotencyKey = null, testData = null, executionDate = null }) {
  const { workflowExecutions } = await getOrgCollections();
  const settings = normalizeSettings((definition || workflow.published?.definition || workflow.draft)?.settings);
  const oid = toObjectId(orgId);
  const wid = workflow._id;
  const payloadBytes = JSON.stringify(trigger?.payload ?? null).length + JSON.stringify(testData ?? null).length;
  if (payloadBytes > MAX_PAYLOAD_BYTES) return fail("The trigger payload or test data is too large.", 413);

  if (mode === "production") {
    const hourAgo = new Date(Date.now() - 3600_000).toISOString(); const dayAgo = new Date(Date.now() - 86400_000).toISOString();
    const [h, d, active] = await Promise.all([
      workflowExecutions.countDocuments({ orgId: oid, workflowId: wid, mode: "production", createdAt: { $gte: hourAgo } }),
      workflowExecutions.countDocuments({ orgId: oid, workflowId: wid, mode: "production", createdAt: { $gte: dayAgo } }),
      workflowExecutions.countDocuments({ orgId: oid, workflowId: wid, status: { $in: ["QUEUED", "RUNNING", "WAITING"] } }),
    ]);
    if (h >= settings.limits.perHour) return fail(`This workflow reached its limit of ${settings.limits.perHour} executions per hour.`, 429, { reasonCode: "RATE_LIMIT_HOUR" });
    if (d >= settings.limits.perDay) return fail(`This workflow reached its limit of ${settings.limits.perDay} executions per day.`, 429, { reasonCode: "RATE_LIMIT_DAY" });
    if (active >= settings.limits.concurrent) return fail(`This workflow already has ${active} executions in progress (limit ${settings.limits.concurrent}).`, 429, { reasonCode: "CONCURRENCY_LIMIT" });
  }

  const now = new Date();
  const doc = {
    orgId: oid, workflowId: wid, workflowName: workflow.name, workflowVersion: version, mode, status: "QUEUED",
    trigger: { type: trigger?.type || "manual", ...(trigger?.scheduledFor ? { scheduledFor: trigger.scheduledFor } : {}), ...(trigger?.payload !== undefined ? { payload: trigger.payload } : {}), source: trigger?.source || null },
    initiatingIdentity, runAs, idempotencyKey: idempotencyKey || null,
    executionDate: (executionDate || trigger?.scheduledFor || now.toISOString()).slice(0, 10),
    createdAt: now.toISOString(), startedAt: null, completedAt: null, durationMs: null, nextAttemptAt: now.toISOString(),
    nodeResults: {}, errors: [], retryState: { manualRetries: 0 }, budgets: {}, claims: 0, lease: { owner: null, expiresAt: null, heartbeatAt: null },
    expiresAt: new Date(now.getTime() + settings.retention.executionDays * 86400000),
    ...(definition ? { definitionSnapshot: definition, definitionHash: canonicalHash(definition) } : {}),
    ...(testData ? { testData } : {}),
  };
  if (!doc.idempotencyKey) delete doc.idempotencyKey;
  try {
    const r = await workflowExecutions.insertOne(doc);
    return { execution: { ...doc, _id: r.insertedId }, created: true };
  } catch (err) {
    if (err?.code === 11000 && doc.idempotencyKey) return { execution: await workflowExecutions.findOne({ orgId: oid, idempotencyKey: doc.idempotencyKey }), created: false, duplicate: true };
    throw err;
  }
}

// ------------------------------------------------------------------- claiming
export async function claimNext({ workerId }) {
  const { workflowExecutions } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = await workflowExecutions.findOneAndUpdate(
    { $or: [{ status: { $in: ["QUEUED", "WAITING"] }, nextAttemptAt: { $lte: now }, "lease.owner": null }, { status: "RUNNING", "lease.expiresAt": { $lt: now } }] },
    { $set: { status: "RUNNING", "lease.owner": workerId, "lease.expiresAt": new Date(Date.now() + LEASE_MS).toISOString(), "lease.heartbeatAt": now }, $inc: { claims: 1 } },
    { sort: { createdAt: 1 }, returnDocument: "after" },
  );
  if (!doc) return null;
  if (doc.claims > MAX_CLAIMS) {
    await workflowExecutions.updateOne({ _id: doc._id }, { $set: { status: "FAILED", completedAt: new Date().toISOString(), deadLetter: true, "lease.owner": null, errors: [{ code: "DEAD_LETTER", message: `The execution was claimed ${doc.claims} times without finishing and was dead-lettered.`, at: new Date().toISOString() }] } });
    await recordWorkflowEvidence({ orgId: doc.orgId, workflowId: doc.workflowId, executionId: doc._id, action: "EXECUTION_FAILED", mode: doc.mode, result: "DEAD_LETTER", data: { claims: doc.claims } });
    return { deadLettered: true, execution: doc };
  }
  return { execution: doc };
}

/** Runs claimed executions until none are due (or `max` reached). */
export async function processQueue({ workerId = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`, max = 10 } = {}) {
  const ran = [];
  for (let i = 0; i < max; i++) {
    const claim = await claimNext({ workerId });
    if (!claim) break;
    if (claim.deadLettered) { ran.push({ executionId: String(claim.execution._id), status: "FAILED", deadLetter: true }); continue; }
    try {
      const out = await runExecution(claim.execution._id, { workerId });
      ran.push({ executionId: String(out._id), status: out.status });
    } catch (err) {
      if (err instanceof LeaseLost) { ran.push({ executionId: String(claim.execution._id), status: "LEASE_LOST" }); continue; }
      // an unexpected engine error must not strand the execution RUNNING with a live lease
      const { workflowExecutions } = await getOrgCollections();
      await workflowExecutions.updateOne({ _id: claim.execution._id, "lease.owner": workerId }, { $set: { status: "FAILED", completedAt: new Date().toISOString(), "lease.owner": null, errors: [{ code: "ENGINE_ERROR", message: String(err.message).slice(0, 300), at: new Date().toISOString() }] } });
      ran.push({ executionId: String(claim.execution._id), status: "FAILED", engineError: true });
    }
  }
  return { ran };
}

/** Runs ONE specific execution now (used by "Execute workflow" so the user sees a result). */
export async function runExecutionNow(executionId, { workerId = `inline-${process.pid}-${Math.random().toString(36).slice(2, 8)}` } = {}) {
  const { workflowExecutions } = await getOrgCollections();
  const now = new Date().toISOString();
  const claimed = await workflowExecutions.findOneAndUpdate(
    { _id: toObjectId(executionId), $or: [{ status: { $in: ["QUEUED", "WAITING"] }, "lease.owner": null }, { status: "RUNNING", "lease.expiresAt": { $lt: now } }] },
    { $set: { status: "RUNNING", "lease.owner": workerId, "lease.expiresAt": new Date(Date.now() + LEASE_MS).toISOString(), "lease.heartbeatAt": now }, $inc: { claims: 1 } },
    { returnDocument: "after" },
  );
  if (!claimed) return await workflowExecutions.findOne({ _id: toObjectId(executionId) }); // someone else has it
  try { return await runExecution(claimed._id, { workerId }); } catch (err) {
    if (err instanceof LeaseLost) return await workflowExecutions.findOne({ _id: claimed._id });
    await workflowExecutions.updateOne({ _id: claimed._id, "lease.owner": workerId }, { $set: { status: "FAILED", completedAt: new Date().toISOString(), "lease.owner": null, errors: [{ code: "ENGINE_ERROR", message: String(err.message).slice(0, 300), at: new Date().toISOString() }] } });
    return await workflowExecutions.findOne({ _id: claimed._id });
  }
}

// ---------------------------------------------------------- approval waiters
export async function processApprovalWaits({ limit = 50 } = {}) {
  const { workflowExecutions } = await getOrgCollections();
  const waiting = await workflowExecutions.find({ status: "WAITING_APPROVAL" }).sort({ createdAt: 1 }).limit(limit).toArray();
  let resumed = 0; let expired = 0;
  for (const e of waiting) {
    if (Date.now() - Date.parse(e.startedAt || e.createdAt) > APPROVAL_WAIT_LIMIT_MS) {
      await workflowExecutions.updateOne({ _id: e._id, status: "WAITING_APPROVAL" }, { $set: { status: "EXPIRED", completedAt: new Date().toISOString(), errors: [{ code: "APPROVAL_TIMEOUT", message: "Approval was not resolved in time.", at: new Date().toISOString() }] } });
      await recordWorkflowEvidence({ orgId: e.orgId, workflowId: e.workflowId, executionId: e._id, action: "EXECUTION_EXPIRED", mode: e.mode, result: "EXPIRED", data: { reason: "approval wait limit" } });
      expired++; continue;
    }
    const r = await resolveApprovalWaits(e._id);
    if (r.resumed) resumed++;
  }
  return { waiting: waiting.length, resumed, expired };
}

// ----------------------------------------------------------------- lifecycle
export async function cancelExecutionRecord({ orgId, executionId, actorEmail }) {
  const { workflowExecutions } = await getOrgCollections();
  const id = toObjectId(executionId); const oid = toObjectId(orgId);
  const idle = await workflowExecutions.findOneAndUpdate({ _id: id, orgId: oid, status: { $in: ["QUEUED", "WAITING", "WAITING_APPROVAL", "PAUSED"] }, "lease.owner": null }, { $set: { status: "CANCELLED", completedAt: new Date().toISOString(), cancelledBy: actorEmail } }, { returnDocument: "after" });
  if (idle) { await recordWorkflowEvidence({ orgId, workflowId: idle.workflowId, executionId: id, action: "EXECUTION_CANCELLED", mode: idle.mode, result: "CANCELLED", actorEmail, actorType: "human", data: { by: actorEmail } }); return { execution: idle }; }
  const running = await workflowExecutions.findOneAndUpdate({ _id: id, orgId: oid, status: "RUNNING" }, { $set: { cancelRequested: true, cancelledBy: actorEmail } }, { returnDocument: "after" });
  if (running) return { execution: running, pending: true };
  return fail("That execution is already finished or does not exist.", 409);
}

export async function pauseExecutionRecord({ orgId, executionId }) {
  const { workflowExecutions } = await getOrgCollections();
  const r = await workflowExecutions.findOneAndUpdate({ _id: toObjectId(executionId), orgId: toObjectId(orgId), status: { $in: ["QUEUED", "RUNNING", "WAITING"] } }, { $set: { pauseRequested: true } }, { returnDocument: "after" });
  if (!r) return fail("That execution cannot be paused.", 409);
  if (r.status !== "RUNNING") await workflowExecutions.updateOne({ _id: r._id, status: { $in: ["QUEUED", "WAITING"] }, "lease.owner": null }, { $set: { status: "PAUSED" } });
  return { execution: await workflowExecutions.findOne({ _id: r._id }) };
}

export async function resumeExecutionRecord({ orgId, executionId }) {
  const { workflowExecutions } = await getOrgCollections();
  const r = await workflowExecutions.findOneAndUpdate({ _id: toObjectId(executionId), orgId: toObjectId(orgId), status: "PAUSED" }, { $set: { status: "QUEUED", nextAttemptAt: new Date().toISOString(), pauseRequested: false, "lease.owner": null } }, { returnDocument: "after" });
  return r ? { execution: r } : fail("That execution is not paused.", 409);
}

/** Manual retry from the failed node(s): finished nodes keep their results (SOW §51). */
export async function retryExecutionRecord({ orgId, executionId, actorEmail }) {
  const { workflowExecutions } = await getOrgCollections();
  const e = await workflowExecutions.findOne({ _id: toObjectId(executionId), orgId: toObjectId(orgId) });
  if (!e) return fail("Execution not found.", 404);
  if (!["FAILED", "EXPIRED"].includes(e.status)) return fail("Only a failed or expired execution can be retried.", 409);
  if (e.deadLetter) return fail("This execution was dead-lettered; start a new execution instead.", 409);
  const nodeResults = { ...(e.nodeResults || {}) };
  for (const [k, r] of Object.entries(nodeResults)) if (["FAILED", "SKIPPED"].includes(r.status) && r.skippedReason !== "Not on the branch that was taken.") nodeResults[k] = { type: r.type, name: r.name, status: "PENDING", attempts: 0, attemptLog: [...(r.attemptLog || []), ...(r.error ? [{ attempt: "final", error: r.error, at: r.completedAt, note: "prior run" }] : [])] };
  const r = await workflowExecutions.findOneAndUpdate({ _id: e._id, status: { $in: ["FAILED", "EXPIRED"] } }, { $set: { status: "QUEUED", nodeResults, nextAttemptAt: new Date().toISOString(), completedAt: null, errors: [], "lease.owner": null, budgets: {} }, $inc: { "retryState.manualRetries": 1 } }, { returnDocument: "after" });
  if (!r) return fail("The execution changed state; try again.", 409);
  await recordWorkflowEvidence({ orgId, workflowId: e.workflowId, executionId: e._id, action: "TRIGGERED", mode: e.mode, actorEmail, actorType: "human", data: { retry: true, manualRetries: r.retryState.manualRetries }, graph: false });
  return { execution: r };
}

// ------------------------------------------------------------------ scheduler
/** Fires due schedules and data-change checks. Safe to call from any number of workers. */
export async function processSchedules({ now = new Date(), limit = 100 } = {}) {
  const { workflows, orgs } = await getOrgCollections();
  const nowIso = now.toISOString();
  const due = await workflows.find({ status: "ACTIVE", deletedAt: null, "schedule.enabled": true, "schedule.nextRunAt": { $lte: nowIso } }).limit(limit).toArray();
  const fired = []; const refused = [];
  for (const wf of due) {
    const scheduledFor = wf.schedule.nextRunAt;
    const next = nextRun(wf.schedule.config, now);
    // claim this slot: only one worker advances nextRunAt from the value it read
    const claim = await workflows.findOneAndUpdate({ _id: wf._id, "schedule.nextRunAt": scheduledFor }, { $set: { "schedule.nextRunAt": next, "schedule.lastFiredAt": nowIso } }, { returnDocument: "after" });
    if (!claim) continue;
    const org = await orgs.findOne({ _id: wf.orgId });
    const membership = await getMembership(wf.orgId, wf.ownerEmail);
    if (!orgIsActive(org) || !membership) {
      await recordWorkflowEvidence({ orgId: wf.orgId, workflowId: wf._id, action: "SCHEDULE_REFUSED", result: "REFUSED", data: { scheduledFor, reason: !orgIsActive(org) ? "organization is disabled" : `owner ${wf.ownerEmail} is no longer an active member` } });
      refused.push({ workflowId: String(wf._id), reason: !orgIsActive(org) ? "ORG_INACTIVE" : "OWNER_INACTIVE" });
      continue;
    }
    const definition = wf.published?.definition;
    const q = await enqueueExecution({ orgId: wf.orgId, workflow: wf, version: wf.published.version, mode: "production", trigger: { type: "schedule", scheduledFor, source: "scheduler" }, runAs: wf.ownerEmail, initiatingIdentity: { kind: "schedule", email: wf.ownerEmail }, idempotencyKey: `sched:${wf._id}:v${wf.published.version}:${scheduledFor}`, executionDate: scheduledFor });
    if (q.error) { refused.push({ workflowId: String(wf._id), reason: q.reasonCode || "REFUSED" }); await recordWorkflowEvidence({ orgId: wf.orgId, workflowId: wf._id, action: "SCHEDULE_REFUSED", result: "REFUSED", data: { scheduledFor, reason: q.error } }); continue; }
    fired.push({ workflowId: String(wf._id), executionId: String(q.execution._id), scheduledFor, duplicate: !!q.duplicate });
  }

  // data-change triggers: compare a hash of the source snapshot with the last one seen
  const checks = await workflows.find({ status: "ACTIVE", deletedAt: null, "dataChange.enabled": true, "dataChange.nextCheckAt": { $lte: nowIso } }).limit(limit).toArray();
  const changed = [];
  for (const wf of checks) {
    const dc = wf.dataChange;
    const claim = await workflows.findOneAndUpdate({ _id: wf._id, "dataChange.nextCheckAt": dc.nextCheckAt }, { $set: { "dataChange.nextCheckAt": new Date(now.getTime() + dc.checkEveryMinutes * 60000).toISOString() } });
    if (!claim) continue;
    try {
      const membership = await getMembership(wf.orgId, wf.ownerEmail);
      if (!membership) continue;
      const ctx = await buildDataContext({ orgId: wf.orgId, membership, email: wf.ownerEmail });
      const type = dc.source === "support_tickets" ? null : `data.${dc.source}`;
      if (!type) continue; // helpdesk change detection needs an outbound call; scheduled polling of tickets uses a schedule trigger instead
      const snap = await runDataNode(type, {}, ctx);
      const hash = canonicalHash({ count: snap.count ?? snap.totals ?? null, rows: (snap.invoices || snap.tasks || snap.deals || []).map((r) => r.invoiceNumber || r.title) });
      if (dc.lastHash && dc.lastHash !== hash) {
        const q = await enqueueExecution({ orgId: wf.orgId, workflow: wf, version: wf.published.version, mode: "production", trigger: { type: "data_change", source: dc.source, payload: { previousHash: dc.lastHash, hash } }, runAs: wf.ownerEmail, initiatingIdentity: { kind: "data_change", email: wf.ownerEmail }, idempotencyKey: `dc:${wf._id}:${hash}` });
        if (!q.error) changed.push({ workflowId: String(wf._id), executionId: String(q.execution._id) });
      }
      await workflows.updateOne({ _id: wf._id }, { $set: { "dataChange.lastHash": hash } });
    } catch (err) { console.error("workflow data-change check failed:", err.message); }
  }
  return { fired, refused, changed };
}

// --------------------------------------------------------------------- events
/**
 * Fires event / Evidence Graph / Digital Twin triggers for an organization.
 * `type` is "event" | "evidence_event" | "twin_complete"; `key` is the event type or subject type.
 */
export async function emitWorkflowEvent({ orgId, type, key = null, eventId, payload = {} }) {
  const { workflows } = await getOrgCollections();
  const q = { orgId: toObjectId(orgId), status: "ACTIVE", deletedAt: null, "triggerEvents.type": type };
  const candidates = await workflows.find(q).limit(50).toArray();
  const fired = [];
  for (const wf of candidates) {
    const t = (wf.triggerEvents || []).find((x) => x.type === type && (!x.key || x.key === key));
    if (!t) continue;
    const membership = await getMembership(wf.orgId, wf.ownerEmail);
    if (!membership) continue;
    const r = await enqueueExecution({ orgId: wf.orgId, workflow: wf, version: wf.published.version, mode: "production", trigger: { type: type === "event" ? "event" : type, source: key, payload: { eventId: String(eventId), key, ...payload } }, runAs: wf.ownerEmail, initiatingIdentity: { kind: "event", email: wf.ownerEmail }, idempotencyKey: `event:${wf._id}:${type}:${eventId}` });
    if (!r.error) fired.push({ workflowId: String(wf._id), executionId: String(r.execution._id), duplicate: !!r.duplicate });
  }
  return { fired };
}
