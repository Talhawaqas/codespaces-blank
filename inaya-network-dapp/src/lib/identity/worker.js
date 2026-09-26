// src/lib/identity/worker.js
//
// The periodic pass (cron every 5 minutes, also callable by an operator for one organization). Each step is independent: a failure in
// one is recorded and never stops the others. Every step is idempotent, so overlapping invocations are safe.
//
//   1. temporary access expiry            (retire, re-derive, verify, revoke lapsed contractors)
//   2. unfinished revocations             (PENDING / PARTIAL / FAILED: re-run only the steps that are not verified, exponential backoff)
//   3. parked or stranded events          (PENDING because the identity was busy, or RECEIVED by a crashed worker)
//   4. bulk jobs                          (bounded slice)
//   5. overdue access reviews             (one reminder per campaign)
//   6. orphan detection                   (hourly per organization)
//   7. scheduled directory pull           (Microsoft Graph, only for providers that opted in; daily)

import { toObjectId } from "../orgs.js";
import { getIdentityCollections, ensureIdentityIndexes } from "./db.js";
import { expireTemporary } from "./temporary.js";
import { revokeAccess } from "./revocation.js";
import { processEvent } from "./engine.js";
import { processJobs } from "./jobs.js";
import { remindOverdue } from "./reviews.js";
import { detectOrphans } from "./orphans.js";
import { pullEntraUsers } from "./entraGraph.js";
import { reconcileSubjects } from "./reconcile.js";
import { getProviderById } from "./providers.js";
import { nowIso } from "./common.js";
import { processDeliveries } from "./outbound.js";

const MAX_REVOCATION_ATTEMPTS = 8;
const MAX_EVENT_RETRIES = 6;

async function step(name, out, fn) { try { out[name] = await fn(); } catch (e) { console.error(`identity worker step ${name} failed:`, e); out[name] = { error: String(e.message || e).slice(0, 200) }; } }

export async function retryUnfinishedRevocations({ now = Date.now(), orgId = null } = {}) {
  const { identityRevocations } = await getIdentityCollections();
  const q = { state: { $in: ["REVOCATION_PENDING", "REVOCATION_PARTIAL", "REVOCATION_FAILED"] } }; if (orgId) q.orgId = toObjectId(orgId);
  const rows = await identityRevocations.find(q).sort({ updatedAt: 1 }).limit(50).toArray();
  const out = { tried: 0, completed: 0, stillOpen: 0, gaveUp: 0 };
  for (const r of rows) {
    const attempts = r.attempts || 0;
    if (attempts >= MAX_REVOCATION_ATTEMPTS) { out.gaveUp++; continue; }
    const wait = Math.min(60, Math.pow(2, attempts)) * 60000; // 1,2,4,...60 min
    if (Date.parse(r.updatedAt || r.createdAt) + wait > now) continue;
    out.tried++;
    const res = await revokeAccess({ orgId: r.orgId, email: r.email, trigger: r.trigger, reason: r.reason, actor: "identity-worker", mode: r.mode, runId: r.runId });
    if (res.revocation?.state === "REVOCATION_COMPLETE") out.completed++; else out.stillOpen++;
  }
  return out;
}

export async function retryParkedEvents({ now = Date.now(), orgId = null } = {}) {
  const { identityEvents } = await getIdentityCollections();
  const stranded = new Date(now - 10 * 60000).toISOString(); const parked = new Date(now - 30000).toISOString();
  const q = { $or: [{ status: "PENDING", $or: [{ parkedAt: { $lte: parked } }, { parkedAt: { $exists: false } }] }, { status: "RECEIVED", receivedAt: { $lte: stranded } }], retryCount: { $not: { $gte: MAX_EVENT_RETRIES } }, event: { $exists: true } };
  if (orgId) q.orgId = toObjectId(orgId);
  const rows = await identityEvents.find(q).sort({ receivedAt: 1 }).limit(25).toArray();
  const out = { tried: 0, processed: 0, stillPending: 0, failed: 0 };
  for (const e of rows) {
    const claim = await identityEvents.updateOne({ _id: e._id, status: e.status, retryCount: e.retryCount || 0 }, { $set: { parkedAt: nowIso() }, $inc: { retryCount: 1 } });
    if (!claim.modifiedCount) continue;
    const provider = await getProviderById(e.providerId); if (!provider) continue;
    out.tried++;
    const r = await processEvent({ provider, event: e.event, actor: "identity-worker", origin: e.origin || "webhook", retry: true });
    if (r.status === "PROCESSED" || ["STALE", "UNRESOLVED", "REJECTED"].includes(r.status)) out.processed++; else if (r.status === "PENDING") out.stillPending++; else out.failed++;
  }
  return out;
}

export async function pullAndReconcile({ provider, actor = "identity-worker" }) {
  const users = await pullEntraUsers({ provider, groupIds: provider.graph?.groupIds || [] });
  return reconcileSubjects({ orgId: provider.orgId, provider, subjects: users, complete: true, actor, source: "graph_pull" });
}

async function scheduledPulls({ now = Date.now(), orgId = null } = {}) {
  const { identityProviders } = await getIdentityCollections();
  const q = { status: "ACTIVE", kind: "entra", "graph.autoPull": true, $or: [{ lastPullAt: { $exists: false } }, { lastPullAt: { $lte: new Date(now - 24 * 3600000).toISOString() } }] }; if (orgId) q.orgId = toObjectId(orgId);
  const rows = await identityProviders.find(q).limit(5).toArray();
  const out = { pulled: 0, failed: 0 };
  for (const p of rows) {
    const claim = await identityProviders.updateOne({ _id: p._id, lastPullAt: p.lastPullAt }, { $set: { lastPullAt: nowIso() } }); if (!claim.modifiedCount) continue;
    try { await pullAndReconcile({ provider: p }); out.pulled++; } catch (e) { out.failed++; await identityProviders.updateOne({ _id: p._id }, { $set: { lastError: `scheduled pull: ${String(e.message).slice(0, 200)}` } }); }
  }
  return out;
}

async function orphanScans({ now = Date.now(), orgId = null } = {}) {
  const { identityProviders } = await getIdentityCollections();
  const q = { status: "ACTIVE", $or: [{ lastOrphanScanAt: { $exists: false } }, { lastOrphanScanAt: { $lte: new Date(now - 3600000).toISOString() } }] }; if (orgId) q.orgId = toObjectId(orgId);
  const rows = await identityProviders.find(q).project({ orgId: 1, lastOrphanScanAt: 1 }).limit(20).toArray();
  const seen = new Set(); const out = { orgs: 0, created: 0 };
  for (const p of rows) {
    const k = String(p.orgId); if (seen.has(k)) continue; seen.add(k);
    const claim = await identityProviders.updateMany({ orgId: p.orgId, status: "ACTIVE" }, { $set: { lastOrphanScanAt: nowIso() } }); if (!claim.modifiedCount) continue;
    const r = await detectOrphans({ orgId: p.orgId }); out.orgs++; out.created += r.created;
  }
  return out;
}

export async function runIdentityWorker({ orgId = null, now = Date.now() } = {}) {
  await ensureIdentityIndexes();
  const out = { at: nowIso() };
  await step("temporaryExpiry", out, () => expireTemporary({ now, orgIds: orgId ? [orgId] : null }));
  await step("revocations", out, () => retryUnfinishedRevocations({ now, orgId }));
  await step("events", out, () => retryParkedEvents({ now, orgId }));
  await step("jobs", out, () => processJobs({ orgId, now }));
  await step("reviews", out, () => remindOverdue({ now }));
  await step("orphans", out, () => orphanScans({ now, orgId }));
  await step("directoryPull", out, () => scheduledPulls({ now, orgId }));
  await step("outboundEvents", out, () => processDeliveries({ orgId }));
  return out;
}
