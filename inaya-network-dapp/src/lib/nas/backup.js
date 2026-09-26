// src/lib/nas/backup.js
//
// Sovereign NAS SOW Workstreams M (NAS-to-Inaya sovereign backup), O
// (multi-target) and X (verified recovery).
//
// NOT a second backup engine or upload protocol: every byte moves through the
// target adapter (cloudTargets.js), whose Inaya implementation is the existing
// s3-compat putS3Object pipeline (encrypt -> shard -> pin -> replicate). What
// this module adds is the NAS-specific orchestration the SOW lists:
//
//   dataset selection   include paths / exclude patterns per policy
//   deduplication       a file whose sha256 already matches the last backed-up
//                       copy on that target is NOT uploaded again (real,
//                       file-level; recorded as filesSkipped)
//   resumable           a run keeps a per-file done set; retrying the same run
//                       continues where it stopped and never re-uploads what
//                       finished (duplicate-safe by construction)
//   integrity           after upload, files are read back from the target and
//                       compared to the source hash; "BACKUP_VERIFIED" evidence
//                       is written ONLY when that comparison passed
//   recovery points     each run stores its manifest (path, size, sha256,
//                       object key, version id) and a manifest hash
//   restore             to the original share (never silently over live data),
//                       to an alternate share/appliance of the same org, or as
//                       a pointer to the object in Inaya
//   drills              a backup is not "recoverable" until a test restore
//                       matched bytes (see runRecoveryDrill / recoveryReadiness)
//
// encryptionMode is "server-managed" for the Inaya target for the same
// structural reason store.js documents: SMB/NFS clients and this job do not run
// Inaya's browser-side encryption. Stated plainly, not glossed over.

import { createHash } from "node:crypto";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { fail, gate, loadShare, iso, notifyNasManagers } from "./common.js";
import { recordNasEvidence } from "./evidence.js";
import { getTargetAdapter, recordTargetResult, INAYA_TARGET_ID } from "./cloudTargets.js";
import { putBucketVersioning, getS3Bucket } from "../s3-compat/store.js";
import { registerJobHandler, enqueueJob, runJob } from "./jobs.js";

const MAX_MANIFEST_FILES = 5000;
const MAX_FILE_BYTES = 200 * 1024 * 1024;

function guessContentType(rel) {
  const ext = rel.split(".").pop()?.toLowerCase();
  return { txt: "text/plain", json: "application/json", pdf: "application/pdf", csv: "text/csv", md: "text/markdown" }[ext] || "application/octet-stream";
}

/** Pure: does `rel` fall inside the policy's selected dataset? */
export function selectedByPolicy(rel, { includePaths = [], excludePatterns = [] } = {}) {
  const inc = includePaths.map((p) => p.replace(/^\/+|\/+$/g, "")).filter(Boolean);
  if (inc.length && !inc.some((p) => rel === p || rel.startsWith(p + "/"))) return false;
  for (const pat of excludePatterns) {
    const esc = String(pat).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    if (new RegExp(`^${esc}$`).test(rel) || new RegExp(`(^|/)${esc}($|/)`).test(rel)) return false;
  }
  return true;
}

/** Pure: which files must be uploaded, given the last backed-up index. */
export function planBackup(files, index) {
  const upload = [];
  const skip = [];
  for (const f of files) {
    const prev = index.get(f.relativePath);
    (prev && prev.sha256 === f.sha256 ? skip : upload).push(f);
  }
  return { upload, skip };
}

export function manifestHashOf(files) {
  return createHash("sha256").update(files.map((f) => `${f.relativePath}\t${f.sizeBytes}\t${f.sha256}`).sort().join("\n")).digest("hex");
}

async function ensureVersioned(orgId, bucket) {
  try {
    const b = await getS3Bucket({ orgId, bucket });
    if (!b || b.versioningStatus !== "Enabled") await putBucketVersioning({ orgId, bucket, status: "Enabled" });
  } catch (e) {
    console.error("ensureVersioned (non-fatal):", e.message);
  }
}

// ---------------------------------------------------------------- policies
export async function setBackupPolicy({ orgId, shareId, includePaths = [], excludePatterns = [], intervalMinutes = 1440, keepRecoveryPoints = 14, targetIds = [INAYA_TARGET_ID], verify = "sample", enabled = true, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  if (!Array.isArray(includePaths) || !Array.isArray(excludePatterns) || !Array.isArray(targetIds) || !targetIds.length) return fail("includePaths, excludePatterns and targetIds must be arrays (at least one target).");
  if (![...includePaths, ...excludePatterns].every((p) => typeof p === "string" && p.length < 200 && !p.split("/").includes(".."))) return fail("Paths and patterns must be short strings without '..'.");
  if (!["full", "sample"].includes(verify)) return fail("verify must be full or sample.");
  const im = Number(intervalMinutes);
  if (!Number.isFinite(im) || im < 1 || im > 525600) return fail("intervalMinutes must be 1-525600.");
  const { nasBackupPolicies, nasCloudTargets } = await getOrgCollections();
  for (const t of targetIds) {
    if (t === INAYA_TARGET_ID) continue;
    const found = await nasCloudTargets.findOne({ _id: toObjectId(t), orgId: toObjectId(orgId), deletedAt: null });
    if (!found) return fail(`Target ${t} does not belong to this organization.`, 400);
  }
  const now = iso();
  const doc = { orgId: toObjectId(orgId), shareId: res.share._id, applianceId: res.share.applianceId, includePaths, excludePatterns, intervalMinutes: im, keepRecoveryPoints, targetIds: targetIds.map(String), verify, enabled: !!enabled, nextRunAt: now, updatedAt: now, updatedBy: actorEmail };
  await nasBackupPolicies.updateOne({ orgId: doc.orgId, shareId: doc.shareId }, { $set: doc, $setOnInsert: { createdAt: now } }, { upsert: true });
  await recordNasEvidence({ orgId, applianceId: res.share.applianceId, subjectId: res.share._id, action: "POLICY_CHANGED", actorEmail, policy: { kind: "backup", includePaths, excludePatterns, intervalMinutes: im, keepRecoveryPoints, targetIds, verify, enabled }, data: { change: "backup-policy" }, graph: false });
  return { policy: doc };
}

export async function getBackupPolicy({ orgId, shareId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const { nasBackupPolicies } = await getOrgCollections();
  return { policy: await nasBackupPolicies.findOne({ orgId: toObjectId(orgId), shareId: toObjectId(shareId) }) };
}

// --------------------------------------------------------------- the run
/**
 * Runs (or resumes) one backup of a share to one target.
 * Returns the run summary; never throws for an operational failure.
 */
export async function runBackup({ orgId, shareId, targetId = INAYA_TARGET_ID, verify = "sample", includePaths = [], excludePatterns = [], resumeRunId = null, actorEmail = "system", actorType = "human", beat }) {
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  const { share, appliance, agent } = res;
  const { nasBackupRuns, nasBackupIndex, nasShares } = await getOrgCollections();

  let adapter;
  try {
    adapter = await getTargetAdapter({ orgId, appliance, targetId, actorEmail });
  } catch (err) {
    return fail(err.message, err.code === "NOT_FOUND" ? 404 : 400);
  }
  if (adapter.kind === "inaya-sovereign") await ensureVersioned(orgId, adapter.bucket);

  // ---- create or resume the run record
  let run;
  if (resumeRunId) {
    run = await nasBackupRuns.findOne({ _id: toObjectId(resumeRunId), orgId: toObjectId(orgId), shareId: share._id });
    if (!run) return fail("The run to resume was not found.", 404);
    if (run.status === "COMPLETED") return { runId: run._id, status: run.status, resumed: false, filesTotal: run.filesTotal, filesBackedUp: run.filesBackedUp, filesSkipped: run.filesSkipped, filesFailed: run.filesFailed, alreadyComplete: true };
    await nasBackupRuns.updateOne({ _id: run._id }, { $set: { status: "RUNNING", resumedAt: iso() }, $inc: { resumeCount: 1 } });
  } else {
    const doc = { orgId: toObjectId(orgId), shareId: share._id, applianceId: appliance._id, targetKey: adapter.targetKey, targetKind: adapter.kind, status: "RUNNING", startedAt: iso(), completedAt: null, filesTotal: 0, filesBackedUp: 0, filesSkipped: 0, filesFailed: 0, filesVerified: 0, bytesTransferred: 0, failures: [], done: [], resumeCount: 0, verifyMode: verify, actorType, requestedBy: actorEmail };
    const ins = await nasBackupRuns.insertOne(doc);
    run = { ...doc, _id: ins.insertedId };
    await recordNasEvidence({ orgId, applianceId: appliance._id, subjectId: share._id, action: "BACKUP_STARTED", actorEmail, actorType, data: { runId: String(run._id), target: adapter.label, targetKind: adapter.kind }, graph: false });
  }
  if (beat) await beat({ runId: String(run._id), done: (run.done || []).length });

  const finishFailed = async (message, status = 502) => {
    await nasBackupRuns.updateOne({ _id: run._id }, { $set: { status: "FAILED", completedAt: iso(), failures: [{ error: message }] } });
    await recordNasEvidence({ orgId, applianceId: appliance._id, subjectId: share._id, action: "BACKUP_FAILED", actorEmail, actorType, result: "FAILED", data: { runId: String(run._id), reason: message.slice(0, 200) } });
    await recordTargetResult({ orgId, targetKey: adapter.targetKey, ok: false, error: message });
    return fail(message, status, { runId: run._id });
  };

  // ---- list the dataset with hashes (one pass on the appliance)
  let listing;
  try {
    listing = await agent.call("manifest", { share: share.shareName, includeLines: true }, { timeout: 600000 });
  } catch (err) {
    return finishFailed(`Could not read the share on the appliance: ${err.message}`);
  }
  const all = listing.lines.map((l) => { const [relativePath, size, sha256] = l.split("\t"); return { relativePath, sizeBytes: Number(size), sha256 }; })
    .filter((f) => selectedByPolicy(f.relativePath, { includePaths, excludePatterns }));
  if (all.length > MAX_MANIFEST_FILES) return finishFailed(`This share has ${all.length} selected files; a single run supports at most ${MAX_MANIFEST_FILES}. Narrow the dataset with includePaths.`, 413);

  const idxRows = await nasBackupIndex.find({ orgId: toObjectId(orgId), shareId: share._id, targetKey: adapter.targetKey }).toArray();
  const index = new Map(idxRows.map((r) => [r.relativePath, r]));
  const done = new Set(run.done || []);
  const { upload, skip } = planBackup(all, index);

  // a resumed run retries what failed before, so those earlier failures are not carried over
  const failures = [];
  let backedUp = run.filesBackedUp || 0;
  let bytes = run.bytesTransferred || 0;
  const manifest = new Map();
  for (const f of skip) manifest.set(f.relativePath, { ...f, objectKey: index.get(f.relativePath).objectKey, versionId: index.get(f.relativePath).versionId || null });

  for (const f of upload) {
    if (done.has(f.relativePath)) { const prev = await nasBackupIndex.findOne({ orgId: toObjectId(orgId), shareId: share._id, targetKey: adapter.targetKey, relativePath: f.relativePath }); if (prev) manifest.set(f.relativePath, { ...f, objectKey: prev.objectKey, versionId: prev.versionId || null }); continue; }
    try {
      if (f.sizeBytes > MAX_FILE_BYTES) throw new Error(`File is larger than the ${MAX_FILE_BYTES} byte per-file backup limit.`);
      const buffer = await agent.readFile({ shareName: share.shareName, relativePath: f.relativePath });
      const actual = createHash("sha256").update(buffer).digest("hex");
      if (actual !== f.sha256) throw new Error("The file changed while it was being backed up; it will be picked up by the next run.");
      const put = await adapter.put({ key: `${share.shareName}/${f.relativePath}`, buffer, contentType: guessContentType(f.relativePath), tags: { nasShareId: String(share._id), nasApplianceId: String(appliance._id) } });
      await nasBackupIndex.updateOne({ orgId: toObjectId(orgId), shareId: share._id, targetKey: adapter.targetKey, relativePath: f.relativePath }, { $set: { sha256: f.sha256, sizeBytes: f.sizeBytes, objectKey: put.objectKey, versionId: put.versionId, lastBackedUpAt: iso(), runId: run._id, provider: put.provider } }, { upsert: true });
      manifest.set(f.relativePath, { ...f, objectKey: put.objectKey, versionId: put.versionId });
      done.add(f.relativePath);
      backedUp++;
      bytes += buffer.length;
      if (backedUp % 5 === 0) {
        await nasBackupRuns.updateOne({ _id: run._id }, { $set: { done: [...done], filesBackedUp: backedUp, bytesTransferred: bytes } });
        if (beat) await beat({ runId: String(run._id), done: done.size });
      }
    } catch (err) {
      failures.push({ relativePath: f.relativePath, error: String(err.message).slice(0, 300) });
    }
  }

  // ---- verification: read back from the target and compare to source hash
  const toVerify = verify === "full" ? [...manifest.values()] : [...manifest.values()].filter((f) => done.has(f.relativePath)).concat(skip.slice(0, 5).map((f) => manifest.get(f.relativePath)).filter(Boolean));
  let verified = 0;
  const mismatches = [];
  for (const f of toVerify) {
    try {
      const back = await adapter.get({ key: f.objectKey, versionId: f.versionId });
      if (!back) throw new Error("The stored object could not be read back.");
      if (createHash("sha256").update(back).digest("hex") !== f.sha256) throw new Error("The stored object does not match the source file.");
      verified++;
    } catch (err) {
      mismatches.push({ relativePath: f.relativePath, error: String(err.message).slice(0, 200) });
    }
  }

  const files = [...manifest.values()].map((f) => ({ relativePath: f.relativePath, sizeBytes: f.sizeBytes, sha256: f.sha256, objectKey: f.objectKey, versionId: f.versionId }));
  const recoveryManifestHash = manifestHashOf(files);
  const allFailures = [...failures, ...mismatches.map((m) => ({ ...m, kind: "VERIFICATION" }))];
  const status = allFailures.length === 0 ? "COMPLETED" : files.length > 0 && backedUp + skip.length > 0 ? "COMPLETED_WITH_ERRORS" : "FAILED";
  await nasBackupRuns.updateOne({ _id: run._id }, { $set: { status, completedAt: iso(), filesTotal: all.length, filesBackedUp: backedUp, filesSkipped: skip.length, filesFailed: failures.length, filesVerified: verified, verificationMismatches: mismatches.length, bytesTransferred: bytes, failures: allFailures, done: [...done], recoveryPoint: { manifestHash: recoveryManifestHash, fileCount: files.length, totalBytes: files.reduce((n, f) => n + f.sizeBytes, 0), files: files.slice(0, MAX_MANIFEST_FILES), createdAt: iso() }, verifiedAt: mismatches.length === 0 && verified >= 0 ? iso() : null } });

  const ok = status === "COMPLETED";
  await recordTargetResult({ orgId, targetKey: adapter.targetKey, ok, bytes, error: allFailures[0]?.error });
  await recordNasEvidence({ orgId, applianceId: appliance._id, subjectId: share._id, action: ok ? "BACKUP_VERIFIED" : "BACKUP_FAILED", actorEmail, actorType, result: ok ? "OK" : status, integrityHash: recoveryManifestHash, data: { runId: String(run._id), target: adapter.label, filesTotal: all.length, filesBackedUp: backedUp, filesSkipped: skip.length, filesFailed: allFailures.length, filesVerified: verified, verifyMode: verify } });
  if (ok) await nasShares.updateOne({ _id: share._id }, { $set: { lastBackup: { at: iso(), runId: run._id, target: adapter.targetKey, manifestHash: recoveryManifestHash, verifiedFiles: verified } } });
  else await notifyNasManagers({ orgId, type: "nas_backup_failed", title: `Backup of ${share.shareName} ${status.toLowerCase().replace(/_/g, " ")}`, body: allFailures[0]?.error || "See the backup run for details.", dedupeKey: `${run._id}:backup-failed`, sourceId: share._id });
  return { runId: run._id, status, filesTotal: all.length, filesBackedUp: backedUp, filesSkipped: skip.length, filesFailed: allFailures.length, filesVerified: verified, failures: allFailures, recoveryManifestHash, resumed: !!resumeRunId };
}

/** Public entry point (kept for the API): back up to Inaya, tracked as a job. */
export async function backupShareToInaya({ orgId, shareId, targetId = INAYA_TARGET_ID, verify = "sample", idempotencyKey, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  const key = idempotencyKey || `backup:${shareId}:${targetId}:${Date.now()}`;
  const { job } = await enqueueJob({ orgId, applianceId: res.share.applianceId, shareId: res.share._id, kind: "backup", payload: { targetId, verify, actorEmail }, idempotencyKey: key, maxAttempts: 3, actorEmail });
  if (job.status === "COMPLETED" && job.result) return { ...job.result, jobId: job._id, idempotent: true };
  const out = await runJob({ jobId: job._id });
  const fresh = await (await getOrgCollections()).nasJobs.findOne({ _id: job._id });
  if (fresh?.result?.runId) return { ...fresh.result, jobId: job._id, jobStatus: fresh.status };
  return { error: out.error || fresh?.lastError || "The backup did not complete.", status: 502, jobId: job._id, jobStatus: fresh?.status };
}

registerJobHandler("backup", async (job, ctx) => {
  const { targetId, verify, actorEmail } = job.payload || {};
  const resumeRunId = job.checkpoint?.runId || null;
  const out = await runBackup({ orgId: job.orgId, shareId: job.shareId, targetId, verify, resumeRunId, actorEmail: actorEmail || "system", actorType: actorEmail ? "human" : "system", beat: ctx.beat });
  if (out.error) throw new Error(out.error);
  return { status: out.status === "COMPLETED" ? "COMPLETED" : "DEGRADED", result: { ...out, runId: String(out.runId) } };
});

export async function listBackupRuns({ orgId, shareId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const { nasBackupRuns } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (shareId) query.shareId = toObjectId(shareId);
  const rows = await nasBackupRuns.find(query, { projection: { done: 0, "recoveryPoint.files": 0 } }).sort({ startedAt: -1 }).limit(50).toArray();
  return { runs: rows };
}

export async function getBackupRun({ orgId, runId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const { nasBackupRuns } = await getOrgCollections();
  let run;
  try { run = await nasBackupRuns.findOne({ _id: toObjectId(runId), orgId: toObjectId(orgId) }, { projection: { done: 0 } }); } catch { run = null; }
  return run ? { run } : fail("Backup run not found.", 404);
}

// ---------------------------------------------------------------- restore
/**
 * Restore from a recovery point. Never overwrites live data unless inPlace is
 * set with a reason; the default lands in `.restored/<runId>/`.
 * target: "original" | "alternate" (another share of this org) | "object"
 */
export async function restoreFromBackup({ orgId, shareId, runId, relPath, target = "original", alternateShareId, inPlace = false, reason, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  if (inPlace && String(reason || "").trim().length < 5) return fail("An in-place restore overwrites live data and needs a reason (at least 5 characters).");
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  const { share, appliance } = res;
  const { nasBackupRuns } = await getOrgCollections();
  let run;
  try { run = await nasBackupRuns.findOne({ _id: toObjectId(runId), orgId: toObjectId(orgId), shareId: share._id }); } catch { run = null; }
  if (!run || !run.recoveryPoint) return fail("Recovery point not found (the run has no manifest).", 404);
  let files = run.recoveryPoint.files;
  if (relPath) files = files.filter((f) => f.relativePath === relPath || f.relativePath.startsWith(relPath.replace(/\/+$/, "") + "/"));
  if (!files.length) return fail("That path is not in the recovery point.", 404);

  let destShare = share;
  let destAgent = res.agent;
  if (target === "alternate") {
    const alt = await loadShare({ orgId, shareId: alternateShareId });
    if (alt.error) return fail("The alternate share was not found in this organization.", 404);
    destShare = alt.share; destAgent = alt.agent;
  }
  if (target === "object") {
    return { target: "object", objects: files.map((f) => ({ bucket: appliance.backupBucket, key: f.objectKey, versionId: f.versionId, sha256: f.sha256, sizeBytes: f.sizeBytes })), note: "The data is already stored in Inaya; use the object references with the S3-compatible API or Inaya Drive." };
  }

  let adapter;
  try { adapter = await getTargetAdapter({ orgId, appliance, targetId: run.targetKey, actorEmail }); } catch (err) { return fail(err.message, 400); }

  await recordNasEvidence({ orgId, applianceId: destShare.applianceId, subjectId: destShare._id, action: "RECOVERY_STARTED", actorEmail, integrityHash: run.recoveryPoint.manifestHash, data: { runId: String(run._id), files: files.length, target, inPlace } , graph: false });
  const restored = [];
  const failures = [];
  for (const f of files) {
    try {
      const buffer = await adapter.get({ key: f.objectKey, versionId: f.versionId });
      if (!buffer) throw new Error("The stored object could not be retrieved.");
      if (createHash("sha256").update(buffer).digest("hex") !== f.sha256) throw new Error("The stored object does not match the recovery point (corrupted or altered).");
      const dest = inPlace && target === "original" ? f.relativePath : `.restored/${String(run._id)}/${f.relativePath}`;
      await destAgent.writeFile({ shareName: destShare.shareName, relativePath: dest, buffer });
      restored.push({ relativePath: f.relativePath, restoredTo: dest, sha256: f.sha256 });
    } catch (err) {
      failures.push({ relativePath: f.relativePath, error: String(err.message).slice(0, 200) });
    }
  }
  const ok = failures.length === 0;
  await recordNasEvidence({ orgId, applianceId: destShare.applianceId, subjectId: destShare._id, action: ok ? "RECOVERY_COMPLETED" : "RECOVERY_FAILED", actorEmail, result: ok ? "OK" : "FAILED", integrityHash: run.recoveryPoint.manifestHash, data: { runId: String(run._id), restored: restored.length, failed: failures.length, target, inPlace, reason: reason || null } });
  return { ok, restored, failures, inPlace: inPlace && target === "original" };
}

// -------------------------------------------------------- recovery drills
/** Restores files from the latest (or given) recovery point to a scratch
 *  area, compares every byte to the recorded hash, and records the result.
 *  With relativePath it drills one file (the original API). */
export async function runRecoveryDrill({ orgId, shareId, runId, relativePath, sampleFiles = 3, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  const { share, appliance, agent } = res;
  const { nasBackupRuns, nasRecoveryDrills } = await getOrgCollections();
  const q = { orgId: toObjectId(orgId), shareId: share._id, status: { $in: ["COMPLETED", "COMPLETED_WITH_ERRORS"] }, recoveryPoint: { $ne: null } };
  if (runId) q._id = toObjectId(runId);
  const run = await nasBackupRuns.find(q).sort({ startedAt: -1 }).limit(1).next();
  const startedAt = iso();
  let result;
  if (!run) {
    result = { verified: false, error: "No usable backup recovery point exists -- run a backup first." };
  } else {
    let files = run.recoveryPoint.files;
    if (relativePath) files = files.filter((f) => f.relativePath === relativePath);
    else files = [...files].sort((a, b) => a.sizeBytes - b.sizeBytes).slice(0, Math.max(1, Math.min(Number(sampleFiles) || 3, 25)));
    if (!files.length) result = { verified: false, error: `"${relativePath}" is not in the recovery point.` };
    else {
      await recordNasEvidence({ orgId, applianceId: appliance._id, subjectId: share._id, action: "RECOVERY_STARTED", actorEmail, integrityHash: run.recoveryPoint.manifestHash, data: { runId: String(run._id), drill: true, files: files.length }, graph: false });
      let adapter;
      try { adapter = await getTargetAdapter({ orgId, appliance, targetId: run.targetKey, actorEmail }); } catch (err) { adapter = null; result = { verified: false, error: err.message }; }
      if (adapter) {
        const failures = [];
        const restored = [];
        for (const f of files) {
          try {
            const buf = await adapter.get({ key: f.objectKey, versionId: f.versionId });
            if (!buf) throw new Error("The stored object could not be retrieved.");
            if (createHash("sha256").update(buf).digest("hex") !== f.sha256) throw new Error("Restored bytes do not match the recovery point.");
            const dest = `.recovery-drill/${f.relativePath}`;
            await agent.writeFile({ shareName: share.shareName, relativePath: dest, buffer: buf });
            const re = await agent.readFile({ shareName: share.shareName, relativePath: dest });
            if (Buffer.compare(buf, re) !== 0) throw new Error("The restored copy on the appliance differs from what was retrieved.");
            restored.push({ relativePath: f.relativePath, restoredTo: dest, sizeBytes: buf.length });
          } catch (err) {
            failures.push({ relativePath: f.relativePath, error: String(err.message).slice(0, 200) });
          }
        }
        result = { verified: failures.length === 0, restoredTo: restored[0]?.restoredTo, sizeBytes: restored[0]?.sizeBytes, filesRestored: restored.length, filesTested: files.length, failures, recoveryPointHash: run.recoveryPoint.manifestHash, runId: String(run._id) };
      }
    }
  }
  const doc = { orgId: toObjectId(orgId), shareId: share._id, applianceId: appliance._id, relativePath: relativePath || null, startedAt, completedAt: iso(), operator: actorEmail, backupRunId: run?._id || null, restoreTarget: "appliance-scratch", result };
  const inserted = await nasRecoveryDrills.insertOne(doc);
  const ev = await recordNasEvidence({ orgId, applianceId: appliance._id, subjectId: share._id, action: result.verified ? "RECOVERY_COMPLETED" : "RECOVERY_FAILED", actorEmail, result: result.verified ? "OK" : "FAILED", integrityHash: result.recoveryPointHash || null, data: { drillId: String(inserted.insertedId), filesTested: result.filesTested || 0, filesRestored: result.filesRestored || 0, error: result.error || null, drill: true } });
  await nasRecoveryDrills.updateOne({ _id: inserted.insertedId }, { $set: { evidenceId: ev.evidenceId || null } });
  return { drillId: inserted.insertedId, ...result };
}

/** DERIVED recovery confidence: never "ready" from a completed backup alone. */
export async function recoveryReadiness({ orgId, shareId }) {
  const { nasBackupRuns, nasRecoveryDrills, nasBackupPolicies } = await getOrgCollections();
  const lastBackup = await nasBackupRuns.find({ orgId: toObjectId(orgId), shareId: toObjectId(shareId), status: "COMPLETED" }).sort({ startedAt: -1 }).limit(1).next();
  const lastDrill = await nasRecoveryDrills.find({ orgId: toObjectId(orgId), shareId: toObjectId(shareId), "result.verified": true }).sort({ startedAt: -1 }).limit(1).next();
  const policy = await nasBackupPolicies.findOne({ orgId: toObjectId(orgId), shareId: toObjectId(shareId) });
  const maxAgeMs = (policy?.intervalMinutes || 1440) * 2 * 60000;
  const backupFresh = lastBackup && Date.now() - new Date(lastBackup.completedAt || lastBackup.startedAt).getTime() <= maxAgeMs;
  const drillAfterBackup = lastBackup && lastDrill && new Date(lastDrill.startedAt) >= new Date(lastBackup.startedAt);
  let state;
  if (!lastBackup) state = "NO_BACKUP";
  else if (!lastDrill) state = "NOT_VERIFIED";
  else if (!backupFresh) state = "AT_RISK";
  else state = drillAfterBackup ? "READY" : "VERIFIED_EARLIER";
  return { state, lastVerifiedBackupAt: lastBackup?.completedAt || null, lastSuccessfulDrillAt: lastDrill?.startedAt || null, basis: "DERIVED", note: "A completed backup alone is never reported as recovery-ready; a test restore must have matched the recorded bytes." };
}
