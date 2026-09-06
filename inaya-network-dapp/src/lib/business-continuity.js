// src/lib/business-continuity.js
//
// Financial Services & Regulated Enterprise SOW, Phase 5 (§68) — Business
// Continuity Management. Cross-vertical. A critical_functions row is the
// business-impact-analysis record (recovery objectives, dependencies,
// alternate procedures, owners, emergency contacts) at the BUSINESS-
// PROCESS level; disaster-recovery.js's runbooks are the TECHNICAL,
// system-level recovery procedure for an ICT asset -- two different
// SOW sections (§68 vs §69) covering two different layers of the same
// resilience story, kept as separate modules rather than conflated.

import { getOrgCollections, toObjectId, canManageOrg } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";

export async function createCriticalFunction({ orgId, name, description, recoveryTimeObjectiveHours, recoveryPointObjectiveHours, dependencies, alternateProcedures, recoveryStrategy, ownerEmail, emergencyContacts, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can register a critical business function.", status: 403 };
  if (!name?.trim()) return { error: "A function name is required.", status: 400 };

  const { criticalFunctions } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), name: name.trim(), description: description || null,
    recoveryTimeObjectiveHours: recoveryTimeObjectiveHours ?? null, recoveryPointObjectiveHours: recoveryPointObjectiveHours ?? null,
    dependencies: (dependencies || []).map((id) => toObjectId(id)), alternateProcedures: alternateProcedures || null,
    recoveryStrategy: recoveryStrategy || null, ownerEmail: ownerEmail || actorEmail,
    emergencyContacts: emergencyContacts || [],
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await criticalFunctions.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "CRITICAL_FUNCTION", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: null, metadata: { name: doc.name } });
  return { criticalFunction: inserted };
}

export async function updateCriticalFunction({ orgId, functionId, updates, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can update a critical business function.", status: 403 };
  const { criticalFunctions } = await getOrgCollections();
  const allowed = ["description", "recoveryTimeObjectiveHours", "recoveryPointObjectiveHours", "alternateProcedures", "recoveryStrategy", "ownerEmail", "emergencyContacts"];
  const setDoc = { updatedAt: new Date().toISOString() };
  for (const key of allowed) if (updates[key] !== undefined) setDoc[key] = updates[key];
  if (updates.dependencies !== undefined) setDoc.dependencies = updates.dependencies.map((id) => toObjectId(id));

  const updated = await criticalFunctions.findOneAndUpdate(
    { _id: toObjectId(functionId), orgId: toObjectId(orgId) },
    { $set: setDoc },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Critical function not found.", status: 404 };
  return { criticalFunction: updated };
}

export async function listCriticalFunctions(orgId) {
  const { criticalFunctions } = await getOrgCollections();
  return criticalFunctions.find({ orgId: toObjectId(orgId) }).sort({ name: 1 }).toArray();
}

/** One continuity plan per critical function -- test schedule + evidence
 *  are append-only logs (a test never overwrites a prior one), matching
 *  every other "log of events" shape in this codebase. */
export async function createContinuityPlan({ orgId, functionId, planText, testFrequencyMonths, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can create a continuity plan.", status: 403 };
  if (!planText?.trim()) return { error: "Plan text is required.", status: 400 };

  const { criticalFunctions, continuityPlans } = await getOrgCollections();
  const fn = await criticalFunctions.findOne({ _id: toObjectId(functionId), orgId: toObjectId(orgId) });
  if (!fn) return { error: "Critical function not found.", status: 404 };

  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), functionId: toObjectId(functionId), planText: planText.trim(),
    testFrequencyMonths: testFrequencyMonths ?? 12, testLog: [],
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await continuityPlans.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "CONTINUITY_PLAN", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: null, metadata: { functionId } });
  return { plan: inserted };
}

export async function recordContinuityTest({ orgId, planId, result: testResult, notes, evidenceDocumentId, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can record a continuity test.", status: 403 };
  if (!["pass", "fail", "partial"].includes(testResult)) return { error: `Unknown test result "${testResult}".`, status: 400 };

  const { continuityPlans } = await getOrgCollections();
  const now = new Date().toISOString();
  const entry = { result: testResult, notes: notes || null, evidenceDocumentId: evidenceDocumentId ? toObjectId(evidenceDocumentId) : null, testedByEmail: actorEmail, testedAt: now };

  const updated = await continuityPlans.findOneAndUpdate(
    { _id: toObjectId(planId), orgId: toObjectId(orgId) },
    { $push: { testLog: entry }, $set: { updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Continuity plan not found.", status: 404 };
  await logOrgActivity({ orgId, recordType: "CONTINUITY_PLAN", recordId: updated._id, actorEmail, action: "TEST_RECORDED", previousState: null, newState: null, metadata: { result: testResult } });
  return { plan: updated };
}

export async function listContinuityPlans(orgId, { functionId } = {}) {
  const { continuityPlans } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (functionId) query.functionId = toObjectId(functionId);
  return continuityPlans.find(query).sort({ createdAt: -1 }).toArray();
}

/** Plans whose most recent test is older than their own test frequency
 *  (or never tested at all) -- never silently treated as "up to date"
 *  when there's simply no evidence either way. */
export async function listOverdueContinuityTests(orgId) {
  const plans = await listContinuityPlans(orgId);
  const now = Date.now();
  return plans.filter((p) => {
    const lastTest = p.testLog[p.testLog.length - 1];
    if (!lastTest) return true;
    const dueBy = new Date(lastTest.testedAt).getTime() + p.testFrequencyMonths * 30 * 24 * 60 * 60 * 1000;
    return now > dueBy;
  });
}
