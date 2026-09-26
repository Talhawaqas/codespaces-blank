// src/lib/workflows/runner.js
//
// One pass of the workflow background work, shared by the Vercel cron route and the
// standalone worker script (scripts/workflow-worker.mjs), exactly like nas/runner.js.
// Every step is idempotent, so any number of workers can call it, and a restart in
// the middle never duplicates an execution, a notification or an approval request.
//
// On Vercel (paid plan) /api/cron/workflows runs every 5 minutes (vercel.json), which is also
// the finest schedule the workflow validator accepts. The worker script is for running the
// same pass somewhere else, for example next to a NAS appliance or on a self-hosted server.

import { getOrgCollections } from "../orgs.js";
import { getMembership } from "../orgs.js";
import { processSchedules, processQueue, processApprovalWaits } from "./queue.js";
import { applyRetention, notifyAutomationHealth } from "./metrics.js";

let lastMaintenance = 0;

export async function runWorkflowWorker({ maxExecutions = 10, maintenance = null } = {}) {
  const t0 = Date.now();
  const schedules = await processSchedules();
  const approvals = await processApprovalWaits();
  const queue = await processQueue({ max: maxExecutions });
  // hourly housekeeping: retention + health notifications (deduplicated per day)
  let housekeeping = null;
  const due = maintenance ?? Date.now() - lastMaintenance > 3600_000;
  if (due) {
    lastMaintenance = Date.now();
    const retention = await applyRetention();
    const { workflows } = await getOrgCollections();
    const orgIds = await workflows.distinct("orgId", { status: "ACTIVE", deletedAt: null });
    let notified = 0;
    for (const orgId of orgIds) {
      const owner = await workflows.findOne({ orgId, status: "ACTIVE", deletedAt: null }, { projection: { ownerEmail: 1 } });
      const membership = owner ? await getMembership(orgId, owner.ownerEmail) : null;
      if (membership && ["owner", "admin"].includes(membership.role)) { const r = await notifyAutomationHealth({ orgId: String(orgId), membership, email: owner.ownerEmail }).catch(() => ({})); if (r.notified) notified++; }
    }
    housekeeping = { retention, healthNotifications: notified };
  }
  return { schedules: { fired: schedules.fired.length, refused: schedules.refused.length, changed: schedules.changed.length }, approvals, executions: queue.ran.length, ran: queue.ran, housekeeping, elapsedMs: Date.now() - t0 };
}
