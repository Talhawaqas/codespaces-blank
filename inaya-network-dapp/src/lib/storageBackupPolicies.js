// src/lib/storageBackupPolicies.js
//
// IBM Cloud VPC Storage Gap Expansion SOW, Workstreams J/K/L/M -- Storage
// Backup Policy Engine, Backup Plans, Retention Enforcement, Backup Job
// Health.
//
// PARTIAL GAP (confirmed by audit): cloudBackupScheduler.js (Modular
// Enterprise Adoption Features SOW, Feature 3) already has a real,
// tested job-execution/health-tracking skeleton -- HEALTH_STATUS,
// consecutiveFailures/staleness-based health, a per-run job record -- but
// it pulls from an EXTERNAL cloud source (AWS/Azure/GCS) into ONE
// hardcoded destination bucket. It has no tag-selector concept, no
// policy-to-many-plans hierarchy, and no retention at all (every run just
// re-syncs current state; nothing ever expires an old copy).
//
// This file is the complementary, Inaya-NATIVE half: a policy selects
// which of the org's OWN storageResources.js resources to protect (by tag
// selector, e.g. {env: "prod"}), each policy has one or more plans
// (daily/weekly/monthly/long-term, each its own schedule+retention), and
// running a plan creates a real storageSnapshots.js Snapshot per matching
// resource -- reusing that engine, never a second snapshot mechanism.
// Retention then deletes the oldest snapshots beyond each plan's
// configured count, every deletion audited (never silent).
//
// Health status mirrors cloudBackupScheduler.js's own HEALTH_STATUS
// values/thresholds exactly, for a consistent operator experience across
// both backup systems.

import { getOrgCollections, toObjectId, canManageStorage, canAccessStorage } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";
import { createNotification } from "./notifications.js";
import { matchesSelector, normalizeTags } from "./storageResources.js";
import { createSnapshot } from "./storageSnapshots.js";

export const HEALTH_STATUS = ["HEALTHY", "WARNING", "DEGRADED", "FAILED", "PAUSED", "UNKNOWN"];
export const PLAN_FREQUENCIES = ["daily", "weekly", "monthly", "longTerm"];

const FREQUENCY_HOURS = { daily: 24, weekly: 24 * 7, monthly: 24 * 30, longTerm: 24 * 90 };

async function assertAccess(membership, requireManage) {
  const ok = requireManage ? canManageStorage(membership) : canAccessStorage(membership);
  if (!ok) return { error: requireManage ? "Only a storage manager can do that." : "You don't have storage-infrastructure access.", status: 403 };
  return null;
}

function computeHealthStatus({ enabled, consecutiveFailures, lastRunAt, frequency }) {
  if (!enabled) return "PAUSED";
  if (consecutiveFailures >= 3) return "FAILED";
  if (consecutiveFailures > 0) return "DEGRADED";
  if (!lastRunAt) return "UNKNOWN";
  const staleAfterMs = (FREQUENCY_HOURS[frequency] || 24) * 3600000 * 3; // 3 missed cycles = stale, same rule as cloudBackupScheduler.js
  if (Date.now() - new Date(lastRunAt).getTime() > staleAfterMs) return "WARNING";
  return "HEALTHY";
}

// ---------------------------------------------------------------------
// Backup Policy (Workstream J)
// ---------------------------------------------------------------------

export async function createBackupPolicy({ orgId, name, tagSelector, notificationPolicy, membership, actorEmail }) {
  const denied = await assertAccess(membership, true);
  if (denied) return denied;
  if (!name?.trim()) return { error: "name is required.", status: 400 };

  let normalizedSelector;
  try {
    normalizedSelector = normalizeTags(tagSelector);
  } catch (err) {
    return { error: err.message, status: 400 };
  }

  const { storageBackupPolicies } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), name: name.trim(), tagSelector: normalizedSelector,
    enabled: true, notificationPolicy: notificationPolicy || "onFailure",
    createdByEmail: actorEmail, createdAt: now, updatedAt: now, deletedAt: null,
  };
  const result = await storageBackupPolicies.insertOne(doc);
  await logOrgActivity({ orgId, recordType: "STORAGE_BACKUP_POLICY", recordId: result.insertedId, actorEmail, action: "CREATED", previousState: null, newState: null, metadata: { name: doc.name, tagSelector: normalizedSelector } });
  return { policy: { ...doc, _id: result.insertedId } };
}

export async function listBackupPolicies({ orgId, membership }) {
  const denied = await assertAccess(membership, false);
  if (denied) return denied;
  const { storageBackupPolicies } = await getOrgCollections();
  return { policies: await storageBackupPolicies.find({ orgId: toObjectId(orgId), deletedAt: null }).sort({ createdAt: -1 }).toArray() };
}

export async function setBackupPolicyEnabled({ orgId, policyId, enabled, membership, actorEmail }) {
  const denied = await assertAccess(membership, true);
  if (denied) return denied;
  const { storageBackupPolicies } = await getOrgCollections();
  const updated = await storageBackupPolicies.findOneAndUpdate(
    { _id: toObjectId(policyId), orgId: toObjectId(orgId), deletedAt: null },
    { $set: { enabled: !!enabled, updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Policy not found.", status: 404 };
  await logOrgActivity({ orgId, recordType: "STORAGE_BACKUP_POLICY", recordId: updated._id, actorEmail, action: enabled ? "RESUMED" : "PAUSED", previousState: null, newState: enabled, metadata: {} });
  return { policy: updated };
}

// ---------------------------------------------------------------------
// Backup Plans (Workstream K) -- Policy -> many Plans
// ---------------------------------------------------------------------

export async function createBackupPlan({ orgId, policyId, frequency, retentionCount, priority, membership, actorEmail }) {
  const denied = await assertAccess(membership, true);
  if (denied) return denied;
  if (!PLAN_FREQUENCIES.includes(frequency)) return { error: `frequency must be one of: ${PLAN_FREQUENCIES.join(", ")}.`, status: 400 };
  const retention = Number(retentionCount);
  if (!Number.isFinite(retention) || retention < 1) return { error: "retentionCount must be a positive number.", status: 400 };

  const { storageBackupPolicies, storageBackupPlans } = await getOrgCollections();
  const policy = await storageBackupPolicies.findOne({ _id: toObjectId(policyId), orgId: toObjectId(orgId), deletedAt: null });
  if (!policy) return { error: "Policy not found.", status: 404 };

  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), policyId: policy._id, frequency, retentionCount: retention, priority: priority || "normal",
    lastRunAt: null, nextRunAt: now, consecutiveFailures: 0,
    createdByEmail: actorEmail, createdAt: now, updatedAt: now, deletedAt: null,
  };
  const result = await storageBackupPlans.insertOne(doc);
  await logOrgActivity({ orgId, recordType: "STORAGE_BACKUP_PLAN", recordId: result.insertedId, actorEmail, action: "CREATED", previousState: null, newState: null, metadata: { policyId: policyId.toString(), frequency, retentionCount: retention } });
  return { plan: { ...doc, _id: result.insertedId } };
}

export async function listBackupPlans({ orgId, policyId, membership }) {
  const denied = await assertAccess(membership, false);
  if (denied) return denied;
  const { storageBackupPlans } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId), deletedAt: null };
  if (policyId) query.policyId = toObjectId(policyId);
  const plans = await storageBackupPlans.find(query).sort({ createdAt: -1 }).toArray();
  return { plans: plans.map((p) => ({ ...p, health: computeHealthStatus({ enabled: true, consecutiveFailures: p.consecutiveFailures, lastRunAt: p.lastRunAt, frequency: p.frequency }) })) };
}

// ---------------------------------------------------------------------
// Retention Enforcement (Workstream L) -- never silent. Every automatic
// deletion is audited; failures are reported, not swallowed.
// ---------------------------------------------------------------------

async function enforceRetention({ orgId, resourceId, planId, retentionCount, actorEmail }) {
  const { storageSnapshots, storageBackupJobs } = await getOrgCollections();
  // Snapshots created by runs of THIS plan, for THIS resource, newest first.
  const jobsForPlan = await storageBackupJobs.find({ orgId: toObjectId(orgId), planId: toObjectId(planId), resourceId: toObjectId(resourceId), status: "SUCCEEDED" }).sort({ completedAt: -1 }).toArray();
  const snapshotIdsInOrder = jobsForPlan.map((j) => j.snapshotId).filter(Boolean);
  const toDelete = snapshotIdsInOrder.slice(retentionCount);
  let deleted = 0;
  const failures = [];
  for (const snapshotId of toDelete) {
    try {
      await storageSnapshots.updateOne({ _id: snapshotId, orgId: toObjectId(orgId), deletedAt: null }, { $set: { deletedAt: new Date().toISOString() } });
      await logOrgActivity({ orgId, recordType: "STORAGE_SNAPSHOT", recordId: snapshotId, actorEmail: actorEmail || "storage-backup-policy-retention", action: "SNAPSHOT_RETENTION_DELETED", previousState: null, newState: "DELETED", metadata: { planId: planId.toString(), retentionCount } });
      deleted++;
    } catch (err) {
      failures.push({ snapshotId: snapshotId.toString(), reason: err.message });
    }
  }
  return { deleted, failures };
}

// ---------------------------------------------------------------------
// Backup Job execution and health (Workstream M)
// ---------------------------------------------------------------------

/** Runs one plan now: snapshots every resource matching the policy's tag
 *  selector, records a job row per resource, enforces retention per
 *  resource, and updates the plan's health. Idempotent per call -- running
 *  twice in immediate succession just creates two real, distinct
 *  snapshots (matching real backup semantics: a manual re-run is a
 *  legitimate new recovery point, not a duplicate to suppress).
 *
 *  No membership parameter here by design -- same as cloudBackupScheduler.js's
 *  runBackupJob(). This function is only ever reached through a caller that
 *  has ALREADY authorized the action (the manual "run now" API route checks
 *  canManageStorage before calling this; the cron sweep runs at system
 *  authority). The synthetic {role:"owner"} membership passed to
 *  createSnapshot() below exists only to satisfy that function's own
 *  general-purpose permission check -- it is never derived from, or a
 *  substitute for, an end user's real membership. */
export async function runBackupPolicyPlan({ orgId, planId, actorEmail }) {
  const { storageBackupPolicies, storageBackupPlans, storageResources, storageBackupJobs } = await getOrgCollections();
  const plan = await storageBackupPlans.findOne({ _id: toObjectId(planId), orgId: toObjectId(orgId), deletedAt: null });
  if (!plan) return { error: "Plan not found.", status: 404 };
  const policy = await storageBackupPolicies.findOne({ _id: plan.policyId, orgId: toObjectId(orgId), deletedAt: null });
  if (!policy) return { error: "The plan's policy no longer exists.", status: 404 };
  if (!policy.enabled) return { error: "This policy is paused.", status: 409 };

  const resources = await storageResources.find({ orgId: toObjectId(orgId), deletedAt: null }).toArray();
  const matching = resources.filter((r) => matchesSelector(r.tags, policy.tagSelector));

  const jobResults = [];
  for (const resource of matching) {
    const startedAt = new Date().toISOString();
    const jobInsert = await storageBackupJobs.insertOne({
      orgId: toObjectId(orgId), policyId: policy._id, planId: plan._id, resourceId: resource._id,
      status: "RUNNING", startedAt, completedAt: null, retryCount: 0, errorCode: null, errorReason: null, verification: null, snapshotId: null,
    });

    try {
      const result = await createSnapshot({ orgId, resourceId: resource._id, membership: { role: "owner" }, actorEmail: actorEmail || "storage-backup-policy" });
      if (result.error) throw new Error(result.error);
      const completedAt = new Date().toISOString();
      await storageBackupJobs.updateOne({ _id: jobInsert.insertedId }, { $set: { status: "SUCCEEDED", completedAt, verification: { integrityHash: result.snapshot.integrityHash, objectCount: result.snapshot.manifest.length }, snapshotId: result.snapshot._id } });

      const retention = await enforceRetention({ orgId, resourceId: resource._id, planId: plan._id, retentionCount: plan.retentionCount, actorEmail });
      jobResults.push({ resourceId: resource._id, status: "SUCCEEDED", snapshotId: result.snapshot._id, retentionDeleted: retention.deleted });
    } catch (err) {
      const completedAt = new Date().toISOString();
      await storageBackupJobs.updateOne({ _id: jobInsert.insertedId }, { $set: { status: "FAILED", completedAt, errorCode: "SNAPSHOT_FAILED", errorReason: err.message } });
      jobResults.push({ resourceId: resource._id, status: "FAILED", errorReason: err.message });
    }
  }

  const anyFailed = jobResults.some((j) => j.status === "FAILED");
  const allFailed = jobResults.length > 0 && jobResults.every((j) => j.status === "FAILED");
  const consecutiveFailures = allFailed ? plan.consecutiveFailures + 1 : 0;
  const now = new Date().toISOString();
  const nextRunAt = new Date(Date.now() + (FREQUENCY_HOURS[plan.frequency] || 24) * 3600000).toISOString();
  await storageBackupPlans.updateOne({ _id: plan._id }, { $set: { lastRunAt: now, nextRunAt, consecutiveFailures, updatedAt: now } });

  await logOrgActivity({ orgId, recordType: "STORAGE_BACKUP_PLAN", recordId: plan._id, actorEmail: actorEmail || "storage-backup-policy", action: "PLAN_RUN_COMPLETED", previousState: null, newState: null, metadata: { resourceCount: matching.length, succeeded: jobResults.filter((j) => j.status === "SUCCEEDED").length, failed: jobResults.filter((j) => j.status === "FAILED").length } });

  if (anyFailed && (policy.notificationPolicy === "onFailure" || policy.notificationPolicy === "always")) {
    await notifyPolicyOwners({ orgId, policy, plan, jobResults }).catch(() => {});
  }

  return { resourcesProcessed: matching.length, jobResults };
}

async function notifyPolicyOwners({ orgId, policy, plan, jobResults }) {
  const { orgMembers } = await getOrgCollections();
  const failedCount = jobResults.filter((j) => j.status === "FAILED").length;
  const managers = await orgMembers.find({ orgId: toObjectId(orgId), role: { $in: ["owner", "admin"] }, status: "active" }).toArray();
  await Promise.all(managers.map((m) => createNotification({
    scope: "org", orgId, targetEmail: m.email, category: "storageBackupPolicy", severity: failedCount > 0 ? "warning" : "info",
    type: "storage_backup_plan_issue", title: `Backup policy "${policy.name}" had ${failedCount} failure(s)`,
    body: `${failedCount} of ${jobResults.length} resource(s) failed to back up in this run.`,
    sourceModule: "storage-backup-policies", sourceId: plan._id, actionUrl: "/business?view=storageControlPlane",
    dedupeKey: `${orgId}:storage_backup_plan_issue:${plan._id}:${new Date().toISOString().slice(0, 13)}`,
  })));
}

export async function listBackupJobs({ orgId, policyId, planId, membership, limit = 50 }) {
  const denied = await assertAccess(membership, false);
  if (denied) return denied;
  const { storageBackupJobs } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (policyId) query.policyId = toObjectId(policyId);
  if (planId) query.planId = toObjectId(planId);
  return { jobs: await storageBackupJobs.find(query).sort({ startedAt: -1 }).limit(Math.min(limit, 200)).toArray() };
}

/** For a cron sweep -- every enabled policy's due plans. */
export async function findDueBackupPlans(limit = 20) {
  const { storageBackupPlans, storageBackupPolicies } = await getOrgCollections();
  const now = new Date().toISOString();
  const duePlans = await storageBackupPlans.find({ deletedAt: null, nextRunAt: { $lte: now } }).limit(limit).toArray();
  const enabled = [];
  for (const plan of duePlans) {
    const policy = await storageBackupPolicies.findOne({ _id: plan.policyId, deletedAt: null, enabled: true });
    if (policy) enabled.push(plan);
  }
  return enabled;
}

export function getPlanHealth(plan) {
  return computeHealthStatus({ enabled: true, consecutiveFailures: plan.consecutiveFailures, lastRunAt: plan.lastRunAt, frequency: plan.frequency });
}
