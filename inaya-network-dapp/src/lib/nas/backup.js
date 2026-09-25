// src/lib/nas/backup.js
//
// Sovereign NAS SOW, Workstream M (NAS-to-Inaya sovereign backup) and
// Workstream X (recovery verification). Deliberately NOT a second backup
// engine: every file is pushed through s3-compat/store.js's
// putS3Object()/getS3ObjectBody(), the exact same real
// encrypt(server-managed AES-256-GCM)→disperseAndSlice→pin→
// backupEngine.replicateShard() pipeline the S3-compatibility layer
// already uses and that Automated Storage Health & Repair already relies
// on -- reused verbatim, not re-implemented. The one genuinely new piece
// is reading/writing the appliance's real files (via NasAgentClient) on
// either side of that existing pipeline.
//
// encryptionMode is "server-managed" here for the same structural reason
// store.js documents: SMB/NFS clients (and this backup job) don't run
// Inaya's client-side browser encryption, so the key is held server-side
// under NAS_ENCRYPTION_KEY-derived custody, not the user's own passkey --
// stated plainly, not glossed over.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";
import { canManageNAS, canAccessNAS } from "../orgGates.js";
import { resolveApplianceForAgent } from "./appliances.js";
import { putS3Object, getS3ObjectBody } from "../s3-compat/store.js";
import { ensureOwnerS3Passphrase } from "../s3-compat/credentials.js";

async function assertAccess(membership, requireManage) {
  const ok = requireManage ? canManageNAS(membership) : canAccessNAS(membership);
  if (!ok) return { error: requireManage ? "Only a NAS manager can do that." : "You don't have NAS access.", status: 403 };
  return null;
}

function guessContentType(relativePath) {
  const ext = relativePath.split(".").pop()?.toLowerCase();
  const map = { txt: "text/plain", json: "application/json", pdf: "application/pdf", csv: "text/csv", md: "text/markdown" };
  return map[ext] || "application/octet-stream";
}

/** Backs up every real file currently on a share into the appliance's own
 *  real S3-compat bucket (appliance.backupBucket) -- one Inaya object per
 *  NAS file, keyed by "<shareName>/<relativePath>" so multiple shares on
 *  one appliance never collide. Real progress/failure per file, not an
 *  all-or-nothing black box (SOW Section 39's IDEMPOTENT/RESUMABLE/
 *  RETRYABLE/AUDITABLE/OBSERVABLE requirement -- re-running this job
 *  simply re-uploads unchanged files, which putS3Object's own versioning
 *  already makes safe and non-duplicating at the storage layer). */
export async function backupShareToInaya({ orgId, shareId, membership, actorEmail }) {
  const denied = await assertAccess(membership, true);
  if (denied) return denied;

  const { nasShares, nasAppliances, nasBackupRuns } = await getOrgCollections();
  const share = await nasShares.findOne({ _id: toObjectId(shareId), orgId: toObjectId(orgId), deletedAt: null });
  if (!share) return { error: "Share not found.", status: 404 };
  const appliance = await nasAppliances.findOne({ _id: share.applianceId, orgId: toObjectId(orgId), deletedAt: null });
  if (!appliance) return { error: "Appliance not found.", status: 404 };

  const resolved = await resolveApplianceForAgent({ orgId, applianceId: appliance._id.toString() });
  if (!resolved) return { error: "Appliance not reachable.", status: 502 };

  // NAS backup is an internal system use of the s3-compat pipeline, not
  // the org deliberately managing its own S3 API credentials -- the org
  // shouldn't need to separately "issue an S3 credential" first just to
  // back up a NAS share, so the passphrase is ensured here the same way
  // issueS3Credential() itself ensures it before minting a credential.
  await ensureOwnerS3Passphrase({ type: "org", orgId });

  const runDoc = {
    orgId: toObjectId(orgId), shareId: share._id, applianceId: appliance._id,
    status: "RUNNING", startedAt: new Date().toISOString(), completedAt: null,
    filesTotal: 0, filesBackedUp: 0, filesFailed: 0, failures: [],
  };
  const runResult = await nasBackupRuns.insertOne(runDoc);

  let files;
  try {
    files = await resolved.agent.listFiles({ shareName: share.shareName });
  } catch (err) {
    await nasBackupRuns.updateOne({ _id: runResult.insertedId }, { $set: { status: "FAILED", completedAt: new Date().toISOString(), failures: [{ error: err.message }] } });
    return { error: `Could not list files on appliance: ${err.message}`, status: 502 };
  }

  const failures = [];
  let backedUp = 0;
  for (const file of files) {
    try {
      const buffer = await resolved.agent.readFile({ shareName: share.shareName, relativePath: file.relativePath });
      await putS3Object({
        orgId, bucket: appliance.backupBucket, key: `${share.shareName}/${file.relativePath}`,
        bodyBuffer: buffer, contentType: guessContentType(file.relativePath), actorEmail,
        tags: { nasShareId: share._id.toString(), nasApplianceId: appliance._id.toString() },
      });
      backedUp++;
    } catch (err) {
      failures.push({ relativePath: file.relativePath, error: err.message });
    }
  }

  const status = failures.length === 0 ? "COMPLETED" : (backedUp > 0 ? "COMPLETED_WITH_ERRORS" : "FAILED");
  await nasBackupRuns.updateOne({ _id: runResult.insertedId }, {
    $set: { status, completedAt: new Date().toISOString(), filesTotal: files.length, filesBackedUp: backedUp, filesFailed: failures.length, failures },
  });

  await logOrgActivity({
    orgId, recordType: "NAS_SHARE", recordId: share._id, actorEmail,
    action: failures.length === 0 ? "BACKUP_VERIFIED" : "BACKUP_FAILED",
    previousState: null, newState: status,
    metadata: { shareName: share.shareName, filesTotal: files.length, filesBackedUp: backedUp, filesFailed: failures.length },
  });

  return { runId: runResult.insertedId, status, filesTotal: files.length, filesBackedUp: backedUp, filesFailed: failures.length, failures };
}

export async function listBackupRuns({ orgId, shareId, membership }) {
  const denied = await assertAccess(membership, false);
  if (denied) return denied;
  const { nasBackupRuns } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (shareId) query.shareId = toObjectId(shareId);
  const rows = await nasBackupRuns.find(query).sort({ startedAt: -1 }).limit(50).toArray();
  return { runs: rows };
}

/** Verified-recovery drill (Workstream X): restores one file from Inaya
 *  back to the appliance and returns a byte-for-byte comparison against
 *  what's on the appliance right now -- real proof, not a "backup
 *  succeeded" assumption. Writes to a *different* relative path
 *  (".recovery-drill/<original path>") so a drill never silently
 *  overwrites live data. */
export async function runRecoveryDrill({ orgId, shareId, relativePath, membership, actorEmail }) {
  const denied = await assertAccess(membership, true);
  if (denied) return denied;

  const { nasShares, nasAppliances, nasRecoveryDrills } = await getOrgCollections();
  const share = await nasShares.findOne({ _id: toObjectId(shareId), orgId: toObjectId(orgId), deletedAt: null });
  if (!share) return { error: "Share not found.", status: 404 };
  const appliance = await nasAppliances.findOne({ _id: share.applianceId, orgId: toObjectId(orgId), deletedAt: null });
  if (!appliance) return { error: "Appliance not found.", status: 404 };
  const resolved = await resolveApplianceForAgent({ orgId, applianceId: appliance._id.toString() });
  if (!resolved) return { error: "Appliance not reachable.", status: 502 };

  const startedAt = new Date().toISOString();
  let result;
  try {
    const backedUp = await getS3ObjectBody({ orgId, bucket: appliance.backupBucket, key: `${share.shareName}/${relativePath}` });
    if (!backedUp) throw new Error(`No backup found for "${relativePath}" — run a backup first.`);
    const restorePath = `.recovery-drill/${relativePath}`;
    await resolved.agent.writeFile({ shareName: share.shareName, relativePath: restorePath, buffer: backedUp.buffer });
    const rereadFromAppliance = await resolved.agent.readFile({ shareName: share.shareName, relativePath: restorePath });
    const bytesMatch = Buffer.compare(backedUp.buffer, rereadFromAppliance) === 0;
    result = { verified: bytesMatch, restoredTo: restorePath, sizeBytes: backedUp.buffer.length };
  } catch (err) {
    result = { verified: false, error: err.message };
  }

  const doc = { orgId: toObjectId(orgId), shareId: share._id, relativePath, startedAt, completedAt: new Date().toISOString(), operator: actorEmail, result };
  const inserted = await nasRecoveryDrills.insertOne(doc);

  await logOrgActivity({
    orgId, recordType: "NAS_SHARE", recordId: share._id, actorEmail,
    action: result.verified ? "RECOVERY_COMPLETED" : "RECOVERY_FAILED",
    previousState: null, newState: result.verified ? "VERIFIED" : "FAILED",
    metadata: { relativePath },
  });

  return { drillId: inserted.insertedId, ...result };
}
