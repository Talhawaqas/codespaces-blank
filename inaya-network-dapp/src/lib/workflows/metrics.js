// src/lib/workflows/metrics.js
//
// SOW §44, §48, §70: observability, retention and Automation Health. Everything is
// scoped to the organization and to the workflows the caller may see; metrics are
// computed from the execution records (no second metrics store).

import { getOrgCollections, toObjectId } from "../orgs.js";
import { canManageOrg } from "../orgGates.js";
import { createNotification } from "../notifications.js";
import { credentialStatus } from "./credentials.js";
import { normalizeSettings } from "./nodes.js";
import { rightsFor } from "./service.js";

const DAY = 86400000;
const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

async function visibleWorkflows(orgId, membership, email) {
  const { workflows } = await getOrgCollections();
  const all = await workflows.find({ orgId: toObjectId(orgId), deletedAt: null }).toArray();
  return all.filter((w) => rightsFor(w, membership, email).has("viewExecutions"));
}

export async function getWorkflowMetrics({ orgId, membership, email, days = 30 }) {
  const { workflowExecutions } = await getOrgCollections();
  const visible = await visibleWorkflows(orgId, membership, email);
  const ids = visible.map((w) => w._id);
  const since = new Date(Date.now() - Math.min(Math.max(days, 1), 365) * DAY).toISOString();
  const execs = ids.length ? await workflowExecutions.find({ orgId: toObjectId(orgId), workflowId: { $in: ids }, mode: "production", createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(3000).toArray() : [];
  const nameOf = new Map(visible.map((w) => [String(w._id), w.name]));

  const done = execs.filter((e) => e.status === "COMPLETED");
  const failed = execs.filter((e) => ["FAILED", "EXPIRED"].includes(e.status));
  const aiDur = []; const httpDur = []; const failNodes = {}; const perWf = {}; const approvalWait = [];
  let retries = 0; let notifOk = 0; let notifAll = 0;
  for (const e of execs) {
    perWf[String(e.workflowId)] = (perWf[String(e.workflowId)] || 0) + 1;
    for (const [k, r] of Object.entries(e.nodeResults || {})) {
      retries += r.retryCount || 0;
      if (r.type === "ai.agent" && r.durationMs) aiDur.push(r.durationMs);
      if ((r.type === "http.request" || r.type === "data.support_tickets") && r.durationMs) httpDur.push(r.durationMs);
      if (r.status === "FAILED") { const label = `${nameOf.get(String(e.workflowId)) || e.workflowName}:${k}`; failNodes[label] = (failNodes[label] || 0) + 1; }
      if (r.type?.startsWith("notify.") && !r.output?.simulated) {
        for (const d of r.output?.deliveries || []) { notifAll++; if (["DELIVERED", "DEDUPED"].includes(d.status)) notifOk++; }
        if (r.status === "FAILED") notifAll++;
      }
      if (r.type === "action.propose" && r.completedAt && r.startedAt && r.output?.approvalStatus) approvalWait.push(Date.parse(r.completedAt) - Date.parse(r.startedAt));
    }
  }
  const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1])[0] || null;
  const topWf = top(perWf); const topFail = top(failNodes);
  return {
    periodDays: days, scope: canManageOrg(membership) ? "organization" : "workflows you can view",
    totals: { executions: execs.length, successful: done.length, failed: failed.length, inProgress: execs.filter((e) => ["QUEUED", "RUNNING", "WAITING", "WAITING_APPROVAL", "PAUSED"].includes(e.status)).length, cancelled: execs.filter((e) => e.status === "CANCELLED").length },
    successRate: done.length + failed.length ? Math.round((done.length / (done.length + failed.length)) * 100) : null,
    averageDurationMs: avg(done.map((e) => e.durationMs || 0)), aiNodeAverageDurationMs: avg(aiDur), externalApiAverageDurationMs: avg(httpDur), retryCount: retries,
    notificationDeliveryRate: notifAll ? Math.round((notifOk / notifAll) * 100) : null, approvalWaitAverageMs: avg(approvalWait),
    mostFrequentlyFailingNode: topFail ? { node: topFail[0], failures: topFail[1] } : null,
    mostUsedWorkflow: topWf ? { workflowId: topWf[0], name: nameOf.get(topWf[0]) || null, executions: topWf[1] } : null,
  };
}

/** SOW §70: one row per workflow classifying how it is doing right now. */
export async function getAutomationHealth({ orgId, membership, email }) {
  const { workflowExecutions } = await getOrgCollections();
  const visible = await visibleWorkflows(orgId, membership, email);
  const rows = [];
  for (const w of visible) {
    const recent = await workflowExecutions.find({ orgId: toObjectId(orgId), workflowId: w._id, mode: "production" }).sort({ createdAt: -1 }).limit(10).project({ status: 1, durationMs: 1, createdAt: 1, completedAt: 1, nodeResults: 1, errors: 1 }).toArray();
    const lastOk = recent.find((e) => e.status === "COMPLETED");
    const lastFail = recent.find((e) => ["FAILED", "EXPIRED"].includes(e.status));
    const retryHeavy = recent.slice(0, 5).reduce((a, e) => a + Object.values(e.nodeResults || {}).reduce((b, r) => b + (r.retryCount || 0), 0), 0) >= 5;
    let expiredCredential = false;
    if (w.published) for (const n of w.published.definition.nodes) if (!n.disabled && n.config?.credentialId) { const st = await credentialStatus({ orgId, credentialId: n.config.credentialId }); if (!st.ok) expiredCredential = true; }
    let state = "RUNNING_NORMALLY";
    if (w.status === "DRAFT") state = "DRAFT";
    else if (w.status === "DISABLED") state = "DISABLED";
    else if (expiredCredential) state = "CREDENTIAL_PROBLEM";
    else if (recent[0] && ["FAILED", "EXPIRED"].includes(recent[0].status)) state = "FAILING";
    else if (recent.slice(0, 3).filter((e) => ["FAILED", "EXPIRED"].includes(e.status)).length >= 2) state = "FAILING";
    else if (recent.some((e) => e.status === "WAITING_APPROVAL")) state = "WAITING_APPROVAL";
    else if (retryHeavy) state = "REPEATED_RETRIES";
    rows.push({ workflowId: String(w._id), name: w.name, state, status: w.status, lastSuccessAt: lastOk?.completedAt || null, lastFailureAt: lastFail?.completedAt || null, averageDurationMs: avg(recent.filter((e) => e.status === "COMPLETED").map((e) => e.durationMs || 0)), lastError: lastFail?.errors?.[0]?.message || null, nextRunAt: w.schedule?.nextRunAt || null });
  }
  const count = (s) => rows.filter((r) => r.state === s).length;
  const summary = { total: rows.length, runningNormally: count("RUNNING_NORMALLY"), failing: count("FAILING"), repeatedRetries: count("REPEATED_RETRIES"), waitingApproval: count("WAITING_APPROVAL"), credentialProblems: count("CREDENTIAL_PROBLEM"), disabled: count("DISABLED"), drafts: count("DRAFT") };
  const bad = summary.failing + summary.credentialProblems;
  return { summary, workflows: rows, trustDimension: { name: "automation_health", status: rows.length === 0 ? "NOT_APPLICABLE" : bad === 0 ? "HEALTHY" : bad >= Math.max(1, Math.ceil(rows.length / 2)) ? "AT_RISK" : "DEGRADED", basis: "share of active workflows failing or holding an unusable credential" } };
}

/** Sends (deduplicated per day) an Inaya notification to managers when automations are unhealthy. */
export async function notifyAutomationHealth({ orgId, membership, email }) {
  const h = await getAutomationHealth({ orgId, membership, email });
  const bad = h.workflows.filter((w) => ["FAILING", "CREDENTIAL_PROBLEM"].includes(w.state));
  if (!bad.length) return { notified: false };
  await createNotification({
    scope: "org", orgId, targetEmail: null, category: "system", severity: "warning", type: "automation_health",
    title: `${bad.length} automation(s) need attention`,
    body: bad.slice(0, 5).map((w) => `${w.name}: ${w.state}${w.lastError ? ` (${w.lastError.slice(0, 80)})` : ""}`).join("\n"),
    sourceModule: "workflows", sourceId: "health", actionUrl: "/business?view=workflows&tab=health", metadata: { count: bad.length },
    dedupeKey: `wf-health:${orgId}:${new Date().toISOString().slice(0, 10)}`,
  });
  return { notified: true, count: bad.length };
}

/**
 * SOW §48: retention. AI outputs are blanked after aiOutputDays; executions are
 * deleted after executionDays. Evidence rows and the cryptographic audit chain are
 * NEVER deleted here: the audit policy keeps them, and a UI record expiring must
 * not weaken the proof of what happened.
 */
export async function applyRetention({ now = new Date() } = {}) {
  const { workflows, workflowExecutions } = await getOrgCollections();
  const all = await workflows.find({ deletedAt: null }).project({ _id: 1, published: 1, draft: 1 }).toArray();
  let aiBlanked = 0; let deleted = 0;
  for (const w of all) {
    const s = normalizeSettings((w.published?.definition || w.draft)?.settings).retention;
    const aiCut = new Date(now.getTime() - s.aiOutputDays * DAY).toISOString();
    const old = await workflowExecutions.find({ workflowId: w._id, createdAt: { $lt: aiCut }, aiOutputPurged: { $ne: true } }).limit(200).toArray();
    for (const e of old) {
      const set = { aiOutputPurged: true };
      for (const [k, r] of Object.entries(e.nodeResults || {})) if (r.type === "ai.agent" && r.output) set[`nodeResults.${k}.output`] = { purged: true, reason: `AI output retention (${s.aiOutputDays} days)`, classification: r.output.result?.classification || null };
      await workflowExecutions.updateOne({ _id: e._id }, { $set: set });
      aiBlanked++;
    }
    const execCut = new Date(now.getTime() - s.executionDays * DAY).toISOString();
    const r = await workflowExecutions.deleteMany({ workflowId: w._id, createdAt: { $lt: execCut }, status: { $in: ["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"] } });
    deleted += r.deletedCount;
  }
  return { aiOutputsPurged: aiBlanked, executionsDeleted: deleted, kept: "evidence rows and the audit chain are retained" };
}
