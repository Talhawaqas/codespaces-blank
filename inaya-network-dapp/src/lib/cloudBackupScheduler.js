// src/lib/cloudBackupScheduler.js
//
// Modular Enterprise Adoption Features SOW, Feature 3 -- Smart Cloud
// Backup & Health Scheduler. Orchestrates inaya-migration-agent's real,
// already-tested source adapters and its runMigration() engine (retry+
// backoff, real size-verified integrity check, structured per-object
// events) rather than reimplementing sync/copy/retry logic -- see this
// file's header comment and package.json for why the package needed a
// `file:` dependency link to be reachable from this deployment at all.
//
// TWO REAL GAPS runMigration()'s own design doesn't cover, resolved here
// rather than by modifying that shared package:
//
// 1. inaya-migration-agent's Manifest is a local JSON-Lines FILE
//    (node:fs) -- meant for a human operator's own machine, and
//    structurally incompatible with a Vercel serverless cron invocation,
//    whose filesystem does not persist between runs. Solved by passing
//    runMigration() a plain object satisfying its exact {isDone, record,
//    summary} duck-typed interface, backed by MongoDB instead.
//
// 2. Manifest.isDone(key) means "was this key EVER successfully
//    migrated" -- once true, runMigration() skips it FOREVER, which is
//    correct for a one-time migration tool but wrong for a RECURRING
//    backup (a changed source object must be re-copied). Solved by never
//    relying on isDone() for that decision at all: this file does its
//    OWN incremental diff (comparing each listed object's real
//    size/etag/lastModified against backupObjectState, the durable
//    per-object record of the last successful sync) BEFORE calling
//    runMigration(), and passes only the changed/new keys via
//    runMigration()'s own `objectKeys` parameter -- so the shim
//    manifest's isDone() can honestly always return false (nothing in
//    the already-filtered candidate list has been decided "done" yet)
//    while its record() persists the real per-object outcome runMigration()
//    computes (byte size, verified/failed, retries) into backupObjectState
//    for the NEXT run's diff.
//
// DESTINATION: writes go straight through s3-compat/store.js's own
// putS3Object/headS3Object/ensureS3Bucket -- the exact same functions
// every other S3-compat write path in this app already uses -- rather
// than the package's own createInayaDestination(), which is an HTTP
// client built for an EXTERNAL process talking to Inaya over the network.
// Running in-process, there is no reason to round-trip to itself.

import { getOrgCollections, canManageOrg, toObjectId } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";
import { createNotification } from "./notifications.js";
import { resolveBackupCredential, BACKUP_PROVIDERS } from "./backupCryptoAndCredentials.js";
import * as s3Store from "./s3-compat/store.js";
import { runMigration } from "@inaya-network/migration-agent/src/migrate.js";
import { createAwsSource } from "@inaya-network/migration-agent/src/adapters/aws.js";
import { createAzureSource } from "@inaya-network/migration-agent/src/adapters/azure.js";
import { createGcsSource } from "@inaya-network/migration-agent/src/adapters/gcs.js";

const MIN_INTERVAL_HOURS = 1;
const MAX_OBJECTS_PER_RUN = 500; // bounded per serverless invocation; remaining changed objects are picked up on the NEXT scheduled tick, never silently dropped.

export const HEALTH_STATUS = ["HEALTHY", "WARNING", "DEGRADED", "FAILED", "PAUSED", "UNKNOWN"];

function buildSourceAdapter(provider, credentials, { bucket, prefix }) {
  if (provider === "aws") return createAwsSource({ region: credentials.region, accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken, bucket });
  if (provider === "azure") return createAzureSource({ accountName: credentials.accountName, accountKey: credentials.accountKey, connectionString: credentials.connectionString, container: bucket });
  if (provider === "gcs") return createGcsSource({ hmacAccessId: credentials.hmacAccessId, hmacSecret: credentials.hmacSecret, bucket, endpoint: credentials.endpoint });
  throw new Error(`Unknown provider "${provider}".`);
}

async function streamToBuffer(readable) {
  if (Buffer.isBuffer(readable)) return readable;
  const chunks = [];
  for await (const chunk of readable) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** In-process destination -- see module header. Matches the exact
 *  {ensureBucket, putObject, headObject} shape runMigration() expects. */
function buildInayaDestination({ orgId, bucket, actorEmail }) {
  return {
    async ensureBucket() {
      // putS3Object's own ensureS3Bucket call handles this per-write already;
      // nothing to do up front.
    },
    async putObject({ key, body, contentType }) {
      const bodyBuffer = await streamToBuffer(body);
      await s3Store.putS3Object({ orgId, bucket, key, bodyBuffer, contentType, actorEmail: actorEmail || "cloud-backup-scheduler" });
    },
    async headObject({ key }) {
      const doc = await s3Store.headS3Object({ orgId, bucket, key });
      return doc ? { sizeBytes: doc.sizeBytes } : null;
    },
  };
}

export async function createBackupSchedule({ orgId, name, provider, credentialId, sourceBucket, sourcePrefix, destinationBucket, intervalHours, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can create a backup schedule.", status: 403 };
  if (!BACKUP_PROVIDERS.includes(provider)) return { error: `Unknown provider "${provider}".`, status: 400 };
  if (!name?.trim() || !credentialId || !sourceBucket?.trim() || !destinationBucket?.trim()) return { error: "name, credentialId, sourceBucket and destinationBucket are required.", status: 400 };
  const interval = Number(intervalHours);
  if (!Number.isFinite(interval) || interval < MIN_INTERVAL_HOURS) return { error: `intervalHours must be a number >= ${MIN_INTERVAL_HOURS}.`, status: 400 };

  const { backupSchedules } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), name: name.trim(), provider, credentialId: toObjectId(credentialId),
    sourceBucket: sourceBucket.trim(), sourcePrefix: sourcePrefix ? sourcePrefix.trim() : "",
    destinationBucket: destinationBucket.trim(), intervalHours: interval,
    status: "enabled", lastRunAt: null, nextRunAt: now, consecutiveFailures: 0,
    createdByEmail: actorEmail, createdAt: now, updatedAt: now, deletedAt: null,
  };
  const result = await backupSchedules.insertOne(doc);
  await logOrgActivity({ orgId, recordType: "BACKUP_SCHEDULE", recordId: result.insertedId, actorEmail, action: "CREATED", previousState: null, newState: null, metadata: { provider, sourceBucket: doc.sourceBucket, intervalHours: interval } });
  return { schedule: { ...doc, _id: result.insertedId } };
}

export async function listBackupSchedules(orgId) {
  const { backupSchedules } = await getOrgCollections();
  return backupSchedules.find({ orgId: toObjectId(orgId), deletedAt: null }).sort({ createdAt: -1 }).toArray();
}

async function setScheduleStatus({ orgId, scheduleId, status, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can change a backup schedule.", status: 403 };
  const { backupSchedules } = await getOrgCollections();
  const updated = await backupSchedules.findOneAndUpdate(
    { _id: toObjectId(scheduleId), orgId: toObjectId(orgId), deletedAt: null },
    { $set: { status, updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Schedule not found.", status: 404 };
  await logOrgActivity({ orgId, recordType: "BACKUP_SCHEDULE", recordId: updated._id, actorEmail, action: status === "enabled" ? "RESUMED" : "PAUSED", previousState: null, newState: status, metadata: {} });
  return { schedule: updated };
}

export const pauseBackupSchedule = (args) => setScheduleStatus({ ...args, status: "paused" });
export const resumeBackupSchedule = (args) => setScheduleStatus({ ...args, status: "enabled" });

export async function deleteBackupSchedule({ orgId, scheduleId, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can delete a backup schedule.", status: 403 };
  const { backupSchedules } = await getOrgCollections();
  const updated = await backupSchedules.findOneAndUpdate(
    { _id: toObjectId(scheduleId), orgId: toObjectId(orgId), deletedAt: null },
    { $set: { deletedAt: new Date().toISOString(), status: "paused" } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Schedule not found.", status: 404 };
  await logOrgActivity({ orgId, recordType: "BACKUP_SCHEDULE", recordId: updated._id, actorEmail, action: "DELETED", previousState: null, newState: null, metadata: {} });
  return { deleted: true };
}

/** Diffs the source against backupObjectState, returns { changedKeys,
 *  seenKeys, sourceEntryByKey } -- a key is "changed" if it's new, or its
 *  size/etag/lastModified differs from what was recorded after the last
 *  successful sync. Per the SOW's own explicit caution, this never
 *  assumes a timestamp alone proves byte equality -- size AND etag must
 *  BOTH match an existing record for a key to be skipped. */
async function diffAgainstLastSync({ scheduleId, source, prefix }) {
  const { backupObjectState } = await getOrgCollections();
  const priorStates = await backupObjectState.find({ scheduleId: toObjectId(scheduleId) }).toArray();
  const priorByKey = new Map(priorStates.map((s) => [s.sourceKey, s]));

  const changedKeys = [];
  const seenKeys = new Set();
  const sourceEntryByKey = new Map();
  for await (const entry of source.listObjects({ prefix })) {
    seenKeys.add(entry.key);
    sourceEntryByKey.set(entry.key, entry);
    const prior = priorByKey.get(entry.key);
    const unchanged = prior && prior.sizeBytes === entry.sizeBytes && prior.etag === entry.etag;
    if (!unchanged) changedKeys.push(entry.key);
  }
  return { changedKeys: changedKeys.slice(0, MAX_OBJECTS_PER_RUN), seenCount: seenKeys.size, sourceEntryByKey, totalChanged: changedKeys.length };
}

function computeHealthStatus({ status, consecutiveFailures, lastRunAt, intervalHours }) {
  if (status === "paused") return "PAUSED";
  if (consecutiveFailures >= 3) return "FAILED";
  if (consecutiveFailures > 0) return "DEGRADED";
  if (!lastRunAt) return "UNKNOWN";
  const staleAfterMs = intervalHours * 60 * 60 * 1000 * 3; // 3 missed cycles = stale
  if (Date.now() - new Date(lastRunAt).getTime() > staleAfterMs) return "WARNING";
  return "HEALTHY";
}

/** Runs one schedule now -- called both by the cron route (for schedules
 *  whose nextRunAt has passed) and by a manual "Run now" action. Never
 *  reports VERIFIED unless verification genuinely ran (SOW §8.7's own
 *  explicit rule) -- that check already lives inside runMigration()
 *  itself (a real HEAD-after-PUT size comparison), reused here rather
 *  than re-implemented. */
export async function runBackupJob({ orgId, scheduleId, actorEmail }) {
  const { backupSchedules, backupRuns, backupObjectState } = await getOrgCollections();
  const schedule = await backupSchedules.findOne({ _id: toObjectId(scheduleId), orgId: toObjectId(orgId), deletedAt: null });
  if (!schedule) return { error: "Schedule not found.", status: 404 };
  if (schedule.status !== "enabled") return { error: "This schedule is paused.", status: 409 };

  const startedAt = new Date().toISOString();
  const runResult = await backupRuns.insertOne({ scheduleId: schedule._id, orgId: schedule.orgId, startedAt, completedAt: null, status: "RUNNING", objectsSeen: 0, objectsChanged: 0, objectsCopied: 0, objectsVerified: 0, verificationFailures: 0, bytesTransferred: 0, errorSummary: null });
  const runId = runResult.insertedId;

  try {
    const resolved = await resolveBackupCredential({ orgId, credentialId: schedule.credentialId });
    if (!resolved) throw new Error("The stored cloud credential for this schedule has been revoked or is missing.");

    const source = buildSourceAdapter(schedule.provider, resolved.credentials, { bucket: schedule.sourceBucket });
    const destination = buildInayaDestination({ orgId, bucket: schedule.destinationBucket, actorEmail });

    const { changedKeys, sourceEntryByKey, seenCount } = await diffAgainstLastSync({ scheduleId, source, prefix: schedule.sourcePrefix });

    let objectsCopied = 0, objectsVerified = 0, verificationFailures = 0, bytesTransferred = 0;
    const errors = [];

    if (changedKeys.length > 0) {
      // A throwaway shim satisfying runMigration()'s exact {isDone, record,
      // summary} interface -- see module header for why isDone() can
      // honestly always return false here (this file already decided what's
      // changed) and why record() persisting into backupObjectState (not a
      // local file) is what makes this safe to call from a stateless
      // serverless invocation.
      const shimManifest = {
        isDone: () => false,
        record: async (rec) => {
          if (rec.status === "MIGRATED") {
            objectsCopied++;
            objectsVerified += rec.destinationVerified ? 1 : 0;
            verificationFailures += rec.destinationVerified ? 0 : 1;
            bytesTransferred += rec.byteSize || 0;
            const entry = sourceEntryByKey.get(rec.sourceKey);
            await backupObjectState.updateOne(
              { scheduleId: toObjectId(scheduleId), sourceKey: rec.sourceKey },
              { $set: { sizeBytes: entry?.sizeBytes ?? rec.byteSize, etag: entry?.etag || null, lastModified: entry?.lastModified || null, lastSyncedAt: rec.completedAt } },
              { upsert: true }
            );
          } else {
            errors.push({ key: rec.sourceKey, reason: rec.failureReason });
          }
        },
        summary: () => ({}),
      };

      await runMigration({ source, destination, manifest: shimManifest, objectKeys: changedKeys, dryRun: false });
    }

    const completedAt = new Date().toISOString();
    const runStatus = errors.length === 0 ? (verificationFailures > 0 ? "VERIFICATION_FAILED" : "SUCCESS") : (objectsCopied > 0 ? "PARTIAL" : "FAILED");
    await backupRuns.updateOne({ _id: runId }, { $set: {
      completedAt, status: runStatus, objectsSeen: seenCount, objectsChanged: changedKeys.length,
      objectsCopied, objectsVerified, verificationFailures, bytesTransferred,
      errorSummary: errors.length > 0 ? errors.slice(0, 20) : null,
    } });

    const consecutiveFailures = runStatus === "FAILED" ? schedule.consecutiveFailures + 1 : 0;
    await backupSchedules.updateOne({ _id: schedule._id }, { $set: {
      lastRunAt: completedAt, nextRunAt: new Date(Date.now() + schedule.intervalHours * 3600000).toISOString(), consecutiveFailures, updatedAt: completedAt,
    } });

    await logOrgActivity({ orgId, recordType: "BACKUP_SCHEDULE", recordId: schedule._id, actorEmail: actorEmail || "cloud-backup-scheduler", action: "RUN_COMPLETED", previousState: null, newState: null, metadata: { runId: runId.toString(), status: runStatus, objectsCopied, verificationFailures } });

    if (runStatus === "FAILED" || verificationFailures > 0) {
      await notifyScheduleOwners({ orgId, schedule, runStatus, verificationFailures }).catch(() => {});
    }

    return { run: { _id: runId, status: runStatus, objectsSeen: seenCount, objectsChanged: changedKeys.length, objectsCopied, objectsVerified, verificationFailures, bytesTransferred } };
  } catch (err) {
    const completedAt = new Date().toISOString();
    await backupRuns.updateOne({ _id: runId }, { $set: { completedAt, status: "FAILED", errorSummary: err.message } });
    const consecutiveFailures = schedule.consecutiveFailures + 1;
    await backupSchedules.updateOne({ _id: schedule._id }, { $set: { lastRunAt: completedAt, nextRunAt: new Date(Date.now() + schedule.intervalHours * 3600000).toISOString(), consecutiveFailures, updatedAt: completedAt } });
    await logOrgActivity({ orgId, recordType: "BACKUP_SCHEDULE", recordId: schedule._id, actorEmail: actorEmail || "cloud-backup-scheduler", action: "RUN_FAILED", previousState: null, newState: null, metadata: { runId: runId.toString(), error: err.message } });
    await notifyScheduleOwners({ orgId, schedule, runStatus: "FAILED", error: err.message }).catch(() => {});
    return { error: err.message, status: 500 };
  }
}

async function notifyScheduleOwners({ orgId, schedule, runStatus, verificationFailures, error }) {
  const { orgMembers } = await getOrgCollections();
  const managers = await orgMembers.find({ orgId: toObjectId(orgId), role: { $in: ["owner", "admin"] }, status: "active" }).toArray();
  await Promise.all(managers.map((m) => createNotification({
    scope: "org", orgId, targetEmail: m.email, category: "backupScheduler", severity: "warning",
    type: "backup_run_issue", title: `Cloud backup schedule "${schedule.name}" ${runStatus === "FAILED" ? "failed" : "had verification failures"}`,
    body: error || `${verificationFailures} object(s) failed verification.`,
    sourceModule: "cloud-backup-scheduler", sourceId: schedule._id, actionUrl: "/business?view=cloudBackup",
    dedupeKey: `${orgId}:backup_run_issue:${schedule._id}:${new Date().toISOString().slice(0, 13)}`,
  })));
}

/** For the cron route -- every enabled schedule across every org whose
 *  nextRunAt has passed, bounded per invocation so one serverless call
 *  never tries to run an unbounded number of orgs' jobs. */
export async function findDueSchedules(limit = 20) {
  const { backupSchedules } = await getOrgCollections();
  const now = new Date().toISOString();
  return backupSchedules.find({ status: "enabled", deletedAt: null, nextRunAt: { $lte: now } }).limit(limit).toArray();
}

export function getScheduleHealth(schedule) {
  return computeHealthStatus(schedule);
}
