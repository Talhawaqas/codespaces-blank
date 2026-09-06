// src/lib/internal-audit.js
//
// Financial Services & Regulated Enterprise SOW, Phase 4 (§51) — Internal
// Audit. An audit plan does NOT invent its own finding concept: a finding
// discovered during an audit is the exact same Finding row/lifecycle as
// control-testing.js's, just tagged `source: "internal_audit"` and linked
// back to the audit plan via `auditPlanId` — one finding lifecycle for the
// whole app, matching the plan's explicit decision to avoid two parallel
// finding systems. The `line` field (three-lines-of-defense) is a label
// for filtering/reporting in this pass, not yet a hard access boundary —
// documented as a fast-follow, same honesty as vendor-management.js's
// scoped-down state today.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canManageAudit, canAccessAudit } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";
import { createFinding } from "./control-testing.js";

export const AUDIT_STATES = ["PLANNED", "FIELDWORK", "REPORTING", "CLOSED"];

export const AUDIT_TRANSITIONS = {
  startFieldwork: { from: "PLANNED", to: "FIELDWORK", activityAction: "FIELDWORK_STARTED" },
  startReporting: { from: "FIELDWORK", to: "REPORTING", activityAction: "REPORTING_STARTED" },
  close: { from: "REPORTING", to: "CLOSED", activityAction: "CLOSED" },
};

export const AUDIT_LINES = ["1", "2", "3"];

export async function createAuditPlan({ orgId, name, scope, universe, program, line, leadAuditorEmail, actorEmail, membership }) {
  if (!canManageAudit(membership)) return { error: "Only an audit manager or org owner/admin can create an audit plan.", status: 403 };
  if (!name?.trim()) return { error: "An audit plan name is required.", status: 400 };
  if (line && !AUDIT_LINES.includes(line)) return { error: `Unknown line of defense "${line}".`, status: 400 };

  const { internalAuditPlans } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId),
    name: name.trim(),
    scope: scope || "",
    universe: universe || "",
    program: program || [],
    line: line || "2",
    leadAuditorEmail: leadAuditorEmail || actorEmail,
    status: "PLANNED",
    findingIds: [],
    auditReport: null,
    createdByEmail: actorEmail,
    createdAt: now, updatedAt: now,
  };
  const result = await internalAuditPlans.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "INTERNAL_AUDIT_PLAN", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: "PLANNED", metadata: { name: doc.name } });
  return { auditPlan: inserted };
}

export async function transitionAuditPlan({ orgId, auditPlanId, action, actorEmail, membership, auditReport }) {
  if (!canManageAudit(membership)) return { error: "Only an audit manager or org owner/admin can update an audit plan.", status: 403 };
  const definition = AUDIT_TRANSITIONS[action];
  if (!definition) return { error: `Unknown action "${action}".`, status: 400 };

  const { internalAuditPlans } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const planObjectId = toObjectId(auditPlanId);
  const now = new Date().toISOString();

  const setDoc = { status: definition.to, updatedAt: now };
  if (action === "close" && auditReport) setDoc.auditReport = auditReport;

  const updated = await internalAuditPlans.findOneAndUpdate(
    { _id: planObjectId, orgId: orgObjectId, status: definition.from },
    { $set: setDoc },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await internalAuditPlans.findOne({ _id: planObjectId, orgId: orgObjectId });
    if (!current) return { error: "Audit plan not found.", status: 404 };
    return { error: `This audit plan isn't in ${definition.from} state (it's currently ${current.status}).`, status: 409 };
  }

  await logOrgActivity({ orgId, recordType: "INTERNAL_AUDIT_PLAN", recordId: updated._id, actorEmail, action: definition.activityAction, previousState: definition.from, newState: definition.to, metadata: {} });
  return { auditPlan: updated };
}

/** Records a finding discovered during audit fieldwork, reusing
 *  control-testing.js's createFinding() so there is exactly one finding
 *  lifecycle in the app — this one is just tagged and linked back. */
export async function recordAuditFinding({ orgId, auditPlanId, controlId, severity, description, actorEmail, membership }) {
  if (!canManageAudit(membership)) return { error: "Only an audit manager or org owner/admin can record an audit finding.", status: 403 };
  const { internalAuditPlans } = await getOrgCollections();
  const plan = await internalAuditPlans.findOne({ _id: toObjectId(auditPlanId), orgId: toObjectId(orgId) });
  if (!plan) return { error: "Audit plan not found.", status: 404 };
  if (plan.status !== "FIELDWORK" && plan.status !== "REPORTING") {
    return { error: "Findings can only be recorded during fieldwork or reporting.", status: 409 };
  }

  const finding = await createFinding({ orgId, controlId, severity, description, source: "internal_audit", actorEmail });
  await internalAuditPlans.updateOne(
    { _id: plan._id },
    { $push: { findingIds: finding._id }, $set: { updatedAt: new Date().toISOString() } }
  );
  return { finding };
}

export async function addManagementResponse({ orgId, findingId, response, actorEmail, membership }) {
  if (!canAccessAudit(membership)) {
    return { error: "Only audit staff or org owner/admin can add a management response.", status: 403 };
  }
  const { complianceFindings } = await getOrgCollections();
  const now = new Date().toISOString();
  const updated = await complianceFindings.findOneAndUpdate(
    { _id: toObjectId(findingId), orgId: toObjectId(orgId) },
    { $push: { timeline: { event: "MANAGEMENT_RESPONSE", actorEmail, at: now, note: response } }, $set: { updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Finding not found.", status: 404 };
  return { finding: updated };
}

export async function listAuditPlans(orgId, { status } = {}) {
  const { internalAuditPlans } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (status) query.status = status;
  return internalAuditPlans.find(query).sort({ createdAt: -1 }).toArray();
}
