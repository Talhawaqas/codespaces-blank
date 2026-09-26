// src/lib/nas/routeActions.js
//
// Small dispatchers behind the NAS API routes that take an { action } in the
// request body. They only route to the real library functions (which own the
// permission checks, validation and audit) so the route files stay thin and
// there is exactly one implementation of every operation.

import { fail, gate } from "./common.js";
import { scrubPool, simulateDiskFailure, replaceDisk } from "./pools.js";
import { setShareQuota, setUserQuota, getUserQuotas } from "./quotas.js";
import { scanShare, setBaseline, approveLockdown, liftLockdown, resolveThreatEvent } from "./ransomware.js";
import { replicateNow, verifyReplica, failoverReplica } from "./replication.js";
import { decideTiering, applyTiering, recallProposal } from "./tiering.js";
import { rotateNasUserPassword, setNasUserEnabled, unlockNasUser } from "./users.js";
import { renameShare, updateShareSettings } from "./shares.js";
import { listJobs, pauseJob, resumeJob, cancelJob, runJob, getJob } from "./jobs.js";
import { listNasEvidence, verifyNasEvidence } from "./evidence.js";
import { gatherNasEvidence } from "./compliance.js";
import { recoveryReadiness } from "./backup.js";
import { runNasWorker } from "./runner.js";

export async function poolAction({ orgId, poolId, body, membership, actorEmail }) {
  switch (body.action) {
    case "scrub": return scrubPool({ orgId, poolId, membership, actorEmail });
    case "simulate-disk-failure": return simulateDiskFailure({ orgId, poolId, member: body.member, confirm: body.confirm, membership, actorEmail });
    case "replace-disk": return replaceDisk({ orgId, poolId, member: body.member, membership, actorEmail });
    default: return fail("action must be scrub, simulate-disk-failure or replace-disk.");
  }
}

export async function quotaAction({ orgId, shareId, body, membership, actorEmail }) {
  if (body.scope === "user") {
    if (body.read) return getUserQuotas({ orgId, shareId, membership });
    return setUserQuota({ orgId, shareId, nasUserId: body.nasUserId, softBytes: body.softBytes, hardBytes: body.hardBytes, membership, actorEmail });
  }
  return setShareQuota({ orgId, shareId, hardBytes: body.hardBytes, softBytes: body.softBytes, warnPercent: body.warnPercent, criticalPercent: body.criticalPercent, membership, actorEmail });
}

export async function threatAction({ orgId, shareId, body, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  switch (body.action) {
    case "scan": return scanShare({ orgId, shareId, respond: body.respond !== false, actorEmail, actorType: "human" });
    case "baseline": return setBaseline({ orgId, shareId, membership, actorEmail });
    case "lift-lockdown": return liftLockdown({ orgId, shareId, membership, actorEmail });
    default: return fail("action must be scan, baseline or lift-lockdown.");
  }
}

export async function threatEventAction({ orgId, eventId, body, membership, actorEmail }) {
  switch (body.action) {
    case "approve-lockdown": return approveLockdown({ orgId, eventId, minutes: body.minutes, membership, actorEmail });
    case "resolve": return resolveThreatEvent({ orgId, eventId, resolution: body.resolution, note: body.note, membership, actorEmail });
    default: return fail("action must be approve-lockdown or resolve.");
  }
}

export async function replicationAction({ orgId, policyId, body, membership, actorEmail }) {
  switch (body.action) {
    case "run": return replicateNow({ orgId, policyId, idempotencyKey: body.idempotencyKey, membership, actorEmail });
    case "verify": return verifyReplica({ orgId, policyId, membership });
    case "failover": return failoverReplica({ orgId, policyId, mode: body.mode, shareName: body.shareName, ownerUnixUser: body.ownerUnixUser, membership, actorEmail });
    default: return fail("action must be run, verify or failover.");
  }
}

export async function tieringAction({ orgId, proposalId, body, membership, actorEmail }) {
  switch (body.action) {
    case "approve": return decideTiering({ orgId, proposalId, approve: true, membership, actorEmail });
    case "reject": return decideTiering({ orgId, proposalId, approve: false, membership, actorEmail });
    case "apply": return applyTiering({ orgId, proposalId, targetId: body.targetId, membership, actorEmail });
    case "recall": return recallProposal({ orgId, proposalId, membership, actorEmail });
    default: return fail("action must be approve, reject, apply or recall.");
  }
}

export async function userAction({ orgId, nasUserId, body, membership, actorEmail }) {
  switch (body.action) {
    case "rotate-password": return rotateNasUserPassword({ orgId, nasUserId, membership, actorEmail });
    case "enable": return setNasUserEnabled({ orgId, nasUserId, enabled: true, membership, actorEmail });
    case "disable": return setNasUserEnabled({ orgId, nasUserId, enabled: false, membership, actorEmail });
    case "unlock": return unlockNasUser({ orgId, nasUserId, membership, actorEmail });
    default: return fail("action must be rotate-password, enable, disable or unlock.");
  }
}

export async function shareUpdate({ orgId, shareId, body, membership, actorEmail }) {
  if (body.newName) return renameShare({ orgId, shareId, newName: body.newName, membership, actorEmail });
  return updateShareSettings({ orgId, shareId, enabled: body.enabled, hidden: body.hidden, readOnly: body.readOnly, membership, actorEmail });
}

export async function jobsList({ orgId, applianceId, kind, status, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  return { jobs: await listJobs({ orgId, applianceId, kind, status }) };
}

export async function jobAction({ orgId, jobId, action, membership }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  switch (action) {
    case "pause": return pauseJob({ orgId, jobId });
    case "resume": return resumeJob({ orgId, jobId });
    case "cancel": return cancelJob({ orgId, jobId });
    case "run": { const j = await getJob({ orgId, jobId }); return j ? { ...(await runJob({ jobId })) } : fail("Job not found.", 404); }
    default: return fail("action must be pause, resume, cancel or run.");
  }
}

export async function workerRun({ orgId, membership }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  return runNasWorker({ orgId, budgetMs: 100000 });
}

export async function evidenceList({ orgId, applianceId, shareId, action, verify, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const events = await listNasEvidence({ orgId, applianceId, shareId, action, limit: 100 });
  const out = { events: events.map((e) => ({ id: String(e._id), action: e.action, result: e.result, actor: e.actor, subjectType: e.subjectType, subjectId: e.subjectId ? String(e.subjectId) : null, integrityHash: e.integrityHash, previousState: e.previousState, newState: e.newState, createdAt: e.createdAt, auditRef: e.auditRef || null, rowHash: e.rowHash })) };
  if (verify) out.verification = await verifyNasEvidence({ orgId, applianceId, shareId });
  return out;
}

export async function complianceReport({ orgId, applianceId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  return gatherNasEvidence(orgId, { applianceId });
}

export async function readinessFor({ orgId, shareId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  return recoveryReadiness({ orgId, shareId });
}
