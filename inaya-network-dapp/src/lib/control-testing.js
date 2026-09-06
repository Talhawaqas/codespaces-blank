// src/lib/control-testing.js
//
// Financial Services & Regulated Enterprise SOW, Phase 4 (§129-130) —
// Control Testing and the Findings & Remediation workflow. This is the
// one true state machine of this phase, following incidents.js's
// TRANSITIONS-map + atomic findOneAndUpdate pattern exactly. A failed
// control test auto-creates a Finding (§130) rather than leaving the
// failure to be manually noticed — internal-audit.js reuses this same
// Finding shape (tagged by `source`) instead of inventing a second
// finding concept, per the plan's explicit decision.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canManageCompliance, canAccessCompliance } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";
import { createNotification } from "./notifications.js";

export const TEST_METHODS = ["automated", "manual", "sampling", "evidence_review", "configuration_check", "interview", "technical_test", "external_assessment"];
export const TEST_RESULTS = ["pass", "fail", "unknown"];

export const FINDING_STATES = ["OPEN", "ASSIGNED", "IN_REMEDIATION", "READY_FOR_VALIDATION", "VALIDATED", "CLOSED"];

export const FINDING_TRANSITIONS = {
  assign: { from: "OPEN", to: "ASSIGNED", activityAction: "ASSIGNED" },
  startRemediation: { from: "ASSIGNED", to: "IN_REMEDIATION", activityAction: "REMEDIATION_STARTED" },
  submitForValidation: { from: "IN_REMEDIATION", to: "READY_FOR_VALIDATION", activityAction: "SUBMITTED_FOR_VALIDATION" },
  validate: { from: "READY_FOR_VALIDATION", to: "VALIDATED", activityAction: "VALIDATED" },
  close: { from: "VALIDATED", to: "CLOSED", activityAction: "CLOSED" },
  reopen: { from: "VALIDATED", to: "IN_REMEDIATION", activityAction: "REOPENED" },
};

export const FINDING_SEVERITIES = ["low", "medium", "high", "critical"];

async function createFinding({ orgId, controlId, severity, description, source, actorEmail }) {
  const { complianceFindings } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId),
    controlId: controlId ? toObjectId(controlId) : null,
    severity: severity || "medium",
    description: description || "",
    source: source || "control_test", // "control_test" | "internal_audit"
    status: "OPEN",
    ownerEmail: null,
    compensatingControl: null,
    timeline: [{ event: "OPENED", actorEmail, at: now }],
    createdByEmail: actorEmail,
    createdAt: now, updatedAt: now, closedAt: null,
  };
  const result = await complianceFindings.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "COMPLIANCE_FINDING", recordId: inserted._id, actorEmail, action: "OPENED", previousState: null, newState: "OPEN", metadata: { source, controlId: controlId || null, severity: doc.severity } });
  await createNotification({
    scope: "org", orgId, targetEmail: null, category: "compliance",
    severity: severity === "critical" || severity === "high" ? "critical" : "warning",
    type: "compliance_finding_opened", title: `Finding opened: ${description || "control test failure"}`, body: "",
    sourceModule: "control-testing", sourceId: inserted._id, actionUrl: "/business?view=regulated",
    dedupeKey: `${orgId}:compliance_finding_opened:${inserted._id}`,
  });
  return inserted;
}

/** Recording a test never mutates the control's `effectiveness` field
 *  directly — that's compliance-controls.js's own field, updated
 *  separately via updateControl() by a human reviewing the test result,
 *  not silently inferred here. This keeps "who decided the control is
 *  effective" always a deliberate, auditable action, never a side effect. */
export async function recordControlTest({ orgId, controlId, method, result, testerEmail, evidenceIds, sample, findingSeverity, actorEmail, membership }) {
  if (!canAccessCompliance(membership)) return { error: "Only compliance staff or org owner/admin can record a control test.", status: 403 };
  if (!TEST_METHODS.includes(method)) return { error: `Unknown test method "${method}".`, status: 400 };
  if (!TEST_RESULTS.includes(result)) return { error: `Unknown test result "${result}".`, status: 400 };

  const { complianceControlTests, complianceControls } = await getOrgCollections();
  const control = await complianceControls.findOne({ _id: toObjectId(controlId), orgId: toObjectId(orgId) });
  if (!control) return { error: "Control not found.", status: 404 };

  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId),
    controlId: toObjectId(controlId),
    method,
    result,
    testerEmail: testerEmail || actorEmail,
    sample: sample || null,
    evidenceIds: (evidenceIds || []).map((id) => toObjectId(id)),
    testedAt: now,
    findingId: null,
  };

  let finding = null;
  if (result === "fail") {
    finding = await createFinding({ orgId, controlId, severity: findingSeverity, description: `Control "${control.name}" failed testing (${method}).`, source: "control_test", actorEmail });
    doc.findingId = finding._id;
  }

  const insertResult = await complianceControlTests.insertOne(doc);
  const inserted = { ...doc, _id: insertResult.insertedId };

  await logOrgActivity({ orgId, recordType: "COMPLIANCE_CONTROL", recordId: control._id, actorEmail, action: "TESTED", previousState: null, newState: null, metadata: { result, method, findingId: finding?._id || null } });
  await complianceControls.updateOne({ _id: control._id }, { $set: { lastTestedAt: now } });

  return { test: inserted, finding };
}

export async function transitionFinding({ orgId, findingId, action, actorEmail, membership, note, ownerEmail, compensatingControl }) {
  if (!canManageCompliance(membership)) return { error: "Only a compliance manager or org owner/admin can update a finding.", status: 403 };
  const definition = FINDING_TRANSITIONS[action];
  if (!definition) return { error: `Unknown action "${action}".`, status: 400 };

  const { complianceFindings } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const findingObjectId = toObjectId(findingId);
  const now = new Date().toISOString();

  const setDoc = { status: definition.to, updatedAt: now, ...(definition.to === "CLOSED" ? { closedAt: now } : {}) };
  if (action === "assign" && ownerEmail) setDoc.ownerEmail = ownerEmail;
  if (compensatingControl) setDoc.compensatingControl = compensatingControl;

  const updated = await complianceFindings.findOneAndUpdate(
    { _id: findingObjectId, orgId: orgObjectId, status: definition.from },
    { $set: setDoc, $push: { timeline: { event: definition.activityAction, actorEmail, at: now, note: note || null } } },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await complianceFindings.findOne({ _id: findingObjectId, orgId: orgObjectId });
    if (!current) return { error: "Finding not found.", status: 404 };
    return { error: `This finding isn't in ${definition.from} state (it's currently ${current.status}).`, status: 409 };
  }

  await logOrgActivity({ orgId, recordType: "COMPLIANCE_FINDING", recordId: updated._id, actorEmail, action: definition.activityAction, previousState: definition.from, newState: definition.to, metadata: note ? { note } : {} });
  return { finding: updated };
}

export async function listFindings(orgId, { status, controlId, source } = {}) {
  const { complianceFindings } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (status) query.status = status;
  if (controlId) query.controlId = toObjectId(controlId);
  if (source) query.source = source;
  return complianceFindings.find(query).sort({ createdAt: -1 }).toArray();
}

export async function listControlTests(orgId, { controlId } = {}) {
  const { complianceControlTests } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (controlId) query.controlId = toObjectId(controlId);
  return complianceControlTests.find(query).sort({ testedAt: -1 }).toArray();
}

export { createFinding };
