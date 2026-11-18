// src/lib/licensing/job.js -- the scheduled license job (SOW sections 8, 15). Run hourly by /api/cron/licenses.
//
//   1. payment due soon      -> "payment due" notice PAYMENT_DUE_NOTICE_DAYS before the due date
//   2. due date passed       -> active -> grace_period (graceStartedAt = the due instant, never the job's run time) + notice
//   3. grace reminders       -> one every day of grace (e-mail + in-app): "X days remaining"; today's only, if the job was down
//   4. grace deadline passed -> re-read, re-check, then grace_period -> suspended + notice (automatic suspension ON),
//                               or record once that the company WOULD be suspended (dry run, production default until approved)
//   5. company data exports  -> build queued exports, delete expired ZIPs (exports.js)
// Every step is idempotent: transitions are guarded by status + version, notices by a unique key per billing period,
// so running the job twice (or concurrently: withJobRun allows one live run) changes nothing the second time.
// The job never depends on anyone signing in. Times come from the stored deadlines (dates.js), not from "now + 14".

import { autoSuspendEnabled, PAYMENT_DUE_NOTICE_DAYS } from "./config.js";
import { graceDay } from "./dates.js";
import { effectiveState } from "./state.js";
import { licenseCollections, systemTransition } from "./service.js";
import { sendLicenseNotice } from "./notices.js";
import { toObjectId } from "../orgs.js";

const DAY = 86400000;

// `orgIds` limits a run to some companies (tests with a simulated clock must never act on anyone else's license).
export async function runLicenseJob({ now = new Date(), autoSuspend = autoSuspendEnabled(), sender, exportsStep = true, orgIds = null } = {}) {
  const { subs, ledger } = await licenseCollections();
  const out = { dueSoonNotices: 0, graceStarted: 0, reminders: 0, suspended: 0, dryRunSuspensions: 0, skipped: 0, errors: [] };
  const live = { licenseId: { $exists: true }, ...(orgIds ? { orgId: { $in: orgIds.map((id) => toObjectId(id)) } } : {}) };
  const iso = now.toISOString();

  // 1. payment due soon (active, due within the notice window, not yet due)
  for (const lic of await subs.find({ ...live, licenseStatus: "active", paymentDueAt: { $gt: iso, $lte: new Date(now.getTime() + PAYMENT_DUE_NOTICE_DAYS * DAY).toISOString() } }).toArray()) {
    try { const r = await sendLicenseNotice({ orgId: lic.orgId, type: "payment_due", license: lic, now, sender }); if (r.sent) out.dueSoonNotices++; } catch (e) { out.errors.push(err(lic, e)); }
  }

  // 2. due date passed while still stored as active -> grace period
  for (const lic of await subs.find({ ...live, licenseStatus: "active", paymentDueAt: { $lte: iso } }).toArray()) {
    try {
      if (lic.overrideUntil && new Date(lic.overrideUntil) > now) continue;
      const next = await systemTransition({ lic, to: "grace_period", now, reason: "payment not confirmed by the due date" });
      if (!next) { out.skipped++; continue; }
      out.graceStarted++;
      await sendLicenseNotice({ orgId: lic.orgId, type: "grace_started", license: next, now, sender });
    } catch (e) { out.errors.push(err(lic, e)); }
  }

  // 3 + 4. licenses in grace
  for (const lic of await subs.find({ ...live, licenseStatus: "grace_period" }).toArray()) {
    try {
      if (lic.overrideUntil && new Date(lic.overrideUntil) > now) continue;
      if (lic.graceEndsAt && new Date(lic.graceEndsAt) <= now) {
        if (autoSuspend) {
          // Re-validate immediately before suspending (SOW 15.2): reload; the transition itself is conditional on the
          // status and version being unchanged, so a payment confirmed a moment earlier wins.
          const fresh = await subs.findOne({ _id: lic._id });
          const eff = effectiveState(fresh, now, { autoSuspend: true });
          if (fresh.licenseStatus !== "grace_period" || eff.state !== "suspended") { out.skipped++; continue; }
          const next = await systemTransition({ lic: fresh, to: "suspended", now, reason: "grace period ended without a confirmed payment" });
          if (!next) { out.skipped++; continue; }
          out.suspended++;
          await sendLicenseNotice({ orgId: lic.orgId, type: "suspended", license: next, now, sender });
        } else {
          // Dry run: record once per billing period that this company would now be suspended.
          try {
            await ledger.insertOne({ kind: "license_event", orgId: lic.orgId, licenseId: lic.licenseId, eventType: "suspension_due_dry_run", actorType: "system", actorId: "license-job", source: "cron", at: iso, createdAt: iso, previousState: "grace_period", newState: "grace_period", reason: "automatic suspension is off (LICENSE_AUTO_SUSPEND); access was not restricted", dedupeKey: `dryrun:${lic.licenseId}:${lic.paymentDueAt}` });
            out.dryRunSuspensions++;
          } catch (e) { if (e?.code !== 11000) throw e; }
        }
        continue;
      }
      // Daily reminder (day 0 is the "payment overdue" notice sent when grace starts).
      const day = graceDay(lic.paidThroughDate, now);
      if (day !== null && day >= 1) {
        const r = await sendLicenseNotice({ orgId: lic.orgId, type: "grace_daily", license: lic, now, sender, day });
        if (r.sent) out.reminders++;
      }
    } catch (e) { out.errors.push(err(lic, e)); }
  }

  if (exportsStep) {
    try { const { processExportJobs, expireExportArtifacts } = await import("./exports.js"); out.exports = await processExportJobs({ now }); out.expiredExports = await expireExportArtifacts({ now }); }
    catch (e) { out.errors.push({ step: "exports", error: String(e.message || e).slice(0, 200) }); }
  }
  import("../metrics/metrics.js").then((m) => m.metric?.("license.job_run", { label: out.errors.length ? "failed" : "ok" })).catch(() => {});
  return out;
}

const err = (lic, e) => ({ orgId: String(lic.orgId), licenseId: lic.licenseId, error: String(e?.message || e).slice(0, 200) });
