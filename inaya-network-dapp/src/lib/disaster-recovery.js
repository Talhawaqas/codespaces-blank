// src/lib/disaster-recovery.js
//
// Financial Services & Regulated Enterprise SOW, Phase 5 (§69) — Disaster
// Recovery. Cross-vertical. A runbook is the TECHNICAL, system-level
// recovery procedure for one ICT asset (RTO/RPO, backup dependency,
// restoration steps) -- distinct from business-continuity.js's
// business-process-level continuity plans (§68). This is deliberately a
// different concept from backupHealth.js, which tracks the health of
// Inaya's own encrypted-file-storage replication layer, not a customer
// org's IT-system recovery posture -- the two should never be conflated.
//
// Every DR test records a result, findings, remediation, and whether a
// retest is required (§69) -- a "pass" with open findings is a
// contradiction this module doesn't allow silently: findings and
// remediation are captured on every test regardless of pass/fail.

import { getOrgCollections, toObjectId, canManageOrg } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";

export async function createRunbook({ orgId, name, assetId, functionId, recoveryTimeObjectiveHours, recoveryPointObjectiveHours, backupDependency, restorationProcedure, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can create a DR runbook.", status: 403 };
  if (!name?.trim()) return { error: "A runbook name is required.", status: 400 };
  if (!restorationProcedure?.trim()) return { error: "A restoration procedure is required.", status: 400 };

  const { drRunbooks } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), name: name.trim(), assetId: assetId ? toObjectId(assetId) : null,
    functionId: functionId ? toObjectId(functionId) : null,
    recoveryTimeObjectiveHours: recoveryTimeObjectiveHours ?? null, recoveryPointObjectiveHours: recoveryPointObjectiveHours ?? null,
    backupDependency: backupDependency || null, restorationProcedure: restorationProcedure.trim(),
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await drRunbooks.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "DR_RUNBOOK", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: null, metadata: { name: doc.name } });
  return { runbook: inserted };
}

export async function updateRunbook({ orgId, runbookId, updates, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can update a DR runbook.", status: 403 };
  const { drRunbooks } = await getOrgCollections();
  const allowed = ["recoveryTimeObjectiveHours", "recoveryPointObjectiveHours", "backupDependency", "restorationProcedure"];
  const setDoc = { updatedAt: new Date().toISOString() };
  for (const key of allowed) if (updates[key] !== undefined) setDoc[key] = updates[key];

  const updated = await drRunbooks.findOneAndUpdate(
    { _id: toObjectId(runbookId), orgId: toObjectId(orgId) },
    { $set: setDoc },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Runbook not found.", status: 404 };
  return { runbook: updated };
}

export async function listRunbooks(orgId) {
  const { drRunbooks } = await getOrgCollections();
  return drRunbooks.find({ orgId: toObjectId(orgId) }).sort({ name: 1 }).toArray();
}

/** Every test is a new, immutable record -- never edited after the fact,
 *  so the full test history for a runbook is always reconstructable. */
export async function recordDrTest({ orgId, runbookId, result, findings, remediation, retestRequired, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can record a DR test.", status: 403 };
  if (!["pass", "fail", "partial"].includes(result)) return { error: `Unknown test result "${result}".`, status: 400 };

  const { drRunbooks, drTests } = await getOrgCollections();
  const runbook = await drRunbooks.findOne({ _id: toObjectId(runbookId), orgId: toObjectId(orgId) });
  if (!runbook) return { error: "Runbook not found.", status: 404 };

  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), runbookId: toObjectId(runbookId), result,
    findings: findings || [], remediation: remediation || null, retestRequired: !!retestRequired,
    testedByEmail: actorEmail, testedAt: now,
  };
  const insertResult = await drTests.insertOne(doc);
  const inserted = { ...doc, _id: insertResult.insertedId };
  await logOrgActivity({ orgId, recordType: "DR_TEST", recordId: inserted._id, actorEmail, action: "RECORDED", previousState: null, newState: null, metadata: { runbookId, result } });
  return { test: inserted };
}

export async function listDrTests(orgId, { runbookId } = {}) {
  const { drTests } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (runbookId) query.runbookId = toObjectId(runbookId);
  return drTests.find(query).sort({ testedAt: -1 }).toArray();
}

/** Runbooks whose most recent test either failed, requires a retest, or
 *  has never been tested at all -- never silently presented as "recovery
 *  ready" when the evidence says otherwise. */
export async function listRunbooksNeedingAttention(orgId) {
  const runbooks = await listRunbooks(orgId);
  const attention = [];
  for (const rb of runbooks) {
    const tests = await listDrTests(orgId, { runbookId: rb._id });
    const latest = tests[0];
    if (!latest) { attention.push({ runbook: rb, reason: "never_tested" }); continue; }
    if (latest.result === "fail") { attention.push({ runbook: rb, reason: "last_test_failed", test: latest }); continue; }
    if (latest.retestRequired) { attention.push({ runbook: rb, reason: "retest_required", test: latest }); }
  }
  return attention;
}
