// src/lib/identity/jobs.js
//
// SOW §40 (bulk / asynchronous operations). A JOB is a durable list of items, each with its own state, processed in bounded slices by
// the worker (or by an explicit "process now" call). It is resumable: an item is claimed atomically, so two workers never do the same
// item, and a crashed worker's claim expires. Partial failure is normal: every item ends COMPLETED / FAILED (with its error class) and the
// job reports totals. A whole job is never one giant transaction, and one bad row never stops the rest.
//
//   kinds: PROVISION (events), DISABLE (revoke), RESTRICT, RESTORE, REVIEW_REVOKE, RECONCILE_SNAPSHOT, GRANT_TEMPORARY

import { toObjectId } from "../orgs.js";
import { getIdentityCollections } from "./db.js";
import { fail, nowIso, normEmail, classifyError, RETRYABLE } from "./common.js";
import { getProvider } from "./providers.js";
import { validateCanonical } from "./normalize.js";
import { processEvent, restoreAccess } from "./engine.js";
import { revokeAccess } from "./revocation.js";
import { grantTemporary } from "./temporary.js";
import { audit } from "./record.js";

export const JOB_KINDS = ["PROVISION", "DISABLE", "RESTRICT", "RESTORE", "GRANT_TEMPORARY"];
const MAX_ITEMS = 5000;
const CLAIM_MS = 3 * 60 * 1000;
const MAX_ATTEMPTS = 4;
const oidOf = (id) => { try { return toObjectId(id); } catch { return null; } };

export async function createJob({ orgId, kind, items, providerId = null, dryRun = false, actor, note = "" }) {
  if (!JOB_KINDS.includes(kind)) return fail(`kind must be one of ${JOB_KINDS.join(", ")}.`);
  if (!Array.isArray(items) || !items.length) return fail("items must be a non-empty array.");
  if (items.length > MAX_ITEMS) return fail(`A job can hold at most ${MAX_ITEMS} items; split it.`, 413);
  let provider = null;
  if (kind === "PROVISION") { provider = providerId ? await getProvider({ orgId, providerId }) : null; if (!provider) return fail("PROVISION jobs need a providerId.", 400); }
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (kind === "PROVISION") { const errs = validateCanonical(it); if (errs.length) return fail(`items[${i}]: ${errs[0]}`); }
    else if (kind === "GRANT_TEMPORARY") { if (!it?.email) return fail(`items[${i}]: email required.`); }
    else if (!it?.email && !it?.externalId) return fail(`items[${i}]: email required.`);
  }
  const { identityJobs } = await getIdentityCollections();
  const job = { orgId: toObjectId(orgId), kind, providerId: provider ? String(provider._id) : null, dryRun: !!dryRun, status: "QUEUED", note: String(note).slice(0, 200), createdBy: normEmail(actor), createdAt: nowIso(), totals: { items: items.length, completed: 0, failed: 0 }, items: items.map((it, i) => ({ n: i, item: it, state: "PENDING", attempts: 0, claimedUntil: 0, result: null, error: null })) };
  // items live inline (bounded at MAX_ITEMS, ~ well below the 16 MB doc limit for normal payloads); size-check to be safe
  if (JSON.stringify(job.items).length > 12_000_000) return fail("The job payload is too large; split it.", 413);
  job._id = (await identityJobs.insertOne(job)).insertedId;
  await audit({ orgId, action: "IDENTITY_JOB_CREATED", actorEmail: actor, metadata: { jobId: String(job._id), kind, items: items.length, dryRun: !!dryRun } });
  return { job: jobView(job) };
}

const jobView = (j, withItems = false) => ({ jobId: String(j._id), kind: j.kind, status: j.status, dryRun: j.dryRun, note: j.note, createdBy: j.createdBy, createdAt: j.createdAt, completedAt: j.completedAt || null, totals: j.totals, ...(withItems ? { items: j.items.map((i) => ({ n: i.n, state: i.state, attempts: i.attempts, result: i.result, error: i.error })) } : {}) });

export async function listJobs({ orgId, limit = 30 }) {
  const { identityJobs } = await getIdentityCollections();
  const rows = await identityJobs.find({ orgId: toObjectId(orgId) }).project({ items: 0 }).sort({ createdAt: -1 }).limit(limit).toArray();
  return { jobs: rows.map((r) => jobView(r)) };
}
export async function getJob({ orgId, jobId }) {
  const id = oidOf(jobId); if (!id) return null;
  const { identityJobs } = await getIdentityCollections();
  const j = await identityJobs.findOne({ _id: id, orgId: toObjectId(orgId) });
  return j ? jobView(j, true) : null;
}
export async function cancelJob({ orgId, jobId, actor }) {
  const id = oidOf(jobId); const { identityJobs } = await getIdentityCollections();
  const r = await identityJobs.updateOne({ _id: id, orgId: toObjectId(orgId), status: { $in: ["QUEUED", "RUNNING"] } }, { $set: { status: "CANCELLED", completedAt: nowIso() } });
  if (!r.modifiedCount) return fail("Job not found or already finished.", 404);
  await audit({ orgId, action: "IDENTITY_JOB_CANCELLED", actorEmail: actor, metadata: { jobId: String(id) } });
  return { cancelled: true };
}

async function runItem(job, entry) {
  const orgId = job.orgId; const it = entry.item;
  if (job.kind === "PROVISION") { const provider = await getProvider({ orgId, providerId: job.providerId }); if (!provider || provider.status === "disabled") throw Object.assign(new Error("Provider unavailable."), { klass: "PERMANENT" }); const r = await processEvent({ provider, event: { ...it, eventId: it.eventId || `job-${job._id}-${entry.n}` }, dryRun: job.dryRun, actor: job.createdBy, origin: "job" }); if (r.error) throw Object.assign(new Error(r.error), { klass: r.status >= 500 ? "PROVIDER" : "PERMANENT" }); return { state: r.run?.state || r.status || "OK", runId: r.run?.runId || null, dryRun: job.dryRun }; }
  if (job.dryRun) return { dryRun: true, would: `${job.kind} ${it.email}` };
  if (job.kind === "DISABLE" || job.kind === "RESTRICT") { const r = await revokeAccess({ orgId, email: it.email, trigger: "bulk_job", reason: it.reason || job.note || `Bulk ${job.kind.toLowerCase()}`, actor: job.createdBy, mode: job.kind === "RESTRICT" ? "restrict" : "full" }); if (r.error) throw Object.assign(new Error(r.error), { klass: r.status === 404 ? "PERMANENT" : "PROVIDER" }); if (r.revocation.noop && /no membership/i.test(r.revocation.reason || "")) throw Object.assign(new Error(`No membership for ${it.email} in this organization.`), { klass: "PERMANENT" }); return { state: r.revocation.state }; }
  if (job.kind === "RESTORE") { const r = await restoreAccess({ orgId, email: it.email, actor: job.createdBy, reason: it.reason || job.note || "Bulk restore" }); if (r.error) throw Object.assign(new Error(r.error), { klass: "PERMANENT" }); return { restored: true }; }
  if (job.kind === "GRANT_TEMPORARY") { const r = await grantTemporary({ orgId, ...it, actor: job.createdBy }); if (r.error) throw Object.assign(new Error(r.error), { klass: "PERMANENT" }); return { grantSetId: r.grantSetId }; }
  throw new Error("Unknown job kind.");
}

/** Processes up to `budget` items of one job (or the oldest runnable job). Safe to call concurrently. */
export async function processJobs({ jobId = null, orgId = null, budget = 25, now = Date.now() } = {}) {
  const { identityJobs } = await getIdentityCollections();
  const out = { jobs: 0, items: 0, completed: 0, failed: 0, retried: 0 };
  const q = { status: { $in: ["QUEUED", "RUNNING"] } }; if (jobId) q._id = oidOf(jobId); if (orgId) q.orgId = toObjectId(orgId);
  const jobs = await identityJobs.find(q).project({ _id: 1 }).sort({ createdAt: 1 }).limit(jobId ? 1 : 5).toArray();
  let left = budget;
  for (const { _id } of jobs) {
    if (left <= 0) break; out.jobs++;
    await identityJobs.updateOne({ _id, status: "QUEUED" }, { $set: { status: "RUNNING", startedAt: nowIso() } });
    while (left > 0) {
      // atomic claim: an item whose claim expired is claimable again (crash recovery)
      const claimed = await identityJobs.findOneAndUpdate(
        { _id, status: "RUNNING", items: { $elemMatch: { state: "PENDING", claimedUntil: { $lte: now } } } },
        { $set: { "items.$.claimedUntil": now + CLAIM_MS }, $inc: { "items.$.attempts": 1 } }, { returnDocument: "after" });
      const job = claimed?.value ?? claimed; if (!job || !job.items) break;
      const entry = job.items.find((i) => i.state === "PENDING" && i.claimedUntil === now + CLAIM_MS && i.attempts >= 1);
      if (!entry) break;
      left--; out.items++;
      let res = null; let err = null;
      try { res = await runItem(job, entry); } catch (e) { err = { klass: e.klass || classifyError(e), message: String(e.message || e).slice(0, 300) }; }
      if (!err) { await identityJobs.updateOne({ _id, "items.n": entry.n }, { $set: { "items.$.state": "COMPLETED", "items.$.result": res, "items.$.error": null }, $inc: { "totals.completed": 1 } }); out.completed++; }
      else if (RETRYABLE.has(err.klass) && entry.attempts < MAX_ATTEMPTS) { await identityJobs.updateOne({ _id, "items.n": entry.n }, { $set: { "items.$.claimedUntil": now + Math.pow(2, entry.attempts) * 60000, "items.$.error": err } }); out.retried++; }
      else { await identityJobs.updateOne({ _id, "items.n": entry.n }, { $set: { "items.$.state": "FAILED", "items.$.error": err }, $inc: { "totals.failed": 1 } }); out.failed++; }
    }
    const fresh = await identityJobs.findOne({ _id });
    if (fresh && fresh.status === "RUNNING" && !fresh.items.some((i) => i.state === "PENDING")) {
      await identityJobs.updateOne({ _id, status: "RUNNING" }, { $set: { status: fresh.totals.failed ? (fresh.totals.completed ? "PARTIAL" : "FAILED") : "COMPLETED", completedAt: nowIso() } });
      await audit({ orgId: fresh.orgId, action: "IDENTITY_JOB_FINISHED", metadata: { jobId: String(_id), kind: fresh.kind, ...fresh.totals } });
    }
  }
  return out;
}
