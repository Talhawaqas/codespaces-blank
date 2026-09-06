// src/lib/regulatory-examination.js
//
// Financial Services & Regulated Enterprise SOW, Phase 4 (§52) — the
// Regulatory Examination Workspace's internal (org-side) core: creating
// an examination, requesting evidence from internal owners, and
// reviewing their responses. The EXTERNAL examiner's own access session
// is a separate, deliberately small module — regulatory-examination-
// access.js — since an outside auditor is not an org_member and needs a
// completely different auth model (see that file's header for why the
// existing Data Room couldn't just be reused here).

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canManageAudit } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";
import { createNotification } from "./notifications.js";

export const EXAMINATION_STATES = ["SCOPING", "ACTIVE", "RESPONSE_REVIEW", "CLOSED"];

export const EXAMINATION_TRANSITIONS = {
  activate: { from: "SCOPING", to: "ACTIVE", activityAction: "ACTIVATED" },
  beginReview: { from: "ACTIVE", to: "RESPONSE_REVIEW", activityAction: "REVIEW_STARTED" },
  close: { from: "RESPONSE_REVIEW", to: "CLOSED", activityAction: "CLOSED" },
};

export const REQUEST_STATES = ["REQUESTED", "SUBMITTED", "APPROVED", "REJECTED"];

export async function createExamination({ orgId, examinerOrgName, scope, dueDate, actorEmail, membership }) {
  if (!canManageAudit(membership)) return { error: "Only an audit manager or org owner/admin can create a regulatory examination.", status: 403 };
  if (!examinerOrgName?.trim()) return { error: "The examining organization's name is required.", status: 400 };

  const { regulatoryExaminations } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId),
    examinerOrgName: examinerOrgName.trim(),
    scope: scope || "",
    dueDate: dueDate || null,
    status: "SCOPING",
    createdByEmail: actorEmail,
    createdAt: now, updatedAt: now,
  };
  const result = await regulatoryExaminations.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "REGULATORY_EXAMINATION", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: "SCOPING", metadata: { examinerOrgName: doc.examinerOrgName } });
  return { examination: inserted };
}

export async function transitionExamination({ orgId, examinationId, action, actorEmail, membership }) {
  if (!canManageAudit(membership)) return { error: "Only an audit manager or org owner/admin can update an examination.", status: 403 };
  const definition = EXAMINATION_TRANSITIONS[action];
  if (!definition) return { error: `Unknown action "${action}".`, status: 400 };

  const { regulatoryExaminations } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const examObjectId = toObjectId(examinationId);
  const now = new Date().toISOString();

  const updated = await regulatoryExaminations.findOneAndUpdate(
    { _id: examObjectId, orgId: orgObjectId, status: definition.from },
    { $set: { status: definition.to, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await regulatoryExaminations.findOne({ _id: examObjectId, orgId: orgObjectId });
    if (!current) return { error: "Examination not found.", status: 404 };
    return { error: `This examination isn't in ${definition.from} state (it's currently ${current.status}).`, status: 409 };
  }

  await logOrgActivity({ orgId, recordType: "REGULATORY_EXAMINATION", recordId: updated._id, actorEmail, action: definition.activityAction, previousState: definition.from, newState: definition.to, metadata: {} });
  return { examination: updated };
}

export async function createEvidenceRequest({ orgId, examinationId, description, dueDate, ownerEmail, actorEmail, membership }) {
  if (!canManageAudit(membership)) return { error: "Only an audit manager or org owner/admin can create an evidence request.", status: 403 };
  if (!description?.trim()) return { error: "A request description is required.", status: 400 };

  const { regulatoryExaminationRequests, regulatoryExaminations } = await getOrgCollections();
  const examination = await regulatoryExaminations.findOne({ _id: toObjectId(examinationId), orgId: toObjectId(orgId) });
  if (!examination) return { error: "Examination not found.", status: 404 };

  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId),
    examinationId: toObjectId(examinationId),
    description: description.trim(),
    dueDate: dueDate || null,
    ownerEmail: ownerEmail || null,
    status: "REQUESTED",
    response: null,
    reviewerComments: null,
    createdByEmail: actorEmail,
    createdAt: now, updatedAt: now,
  };
  const result = await regulatoryExaminationRequests.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "REGULATORY_EXAMINATION", recordId: examination._id, actorEmail, action: "EVIDENCE_REQUESTED", previousState: null, newState: null, metadata: { requestId: inserted._id } });
  if (ownerEmail) {
    await createNotification({
      scope: "org", orgId, targetEmail: ownerEmail, category: "compliance", severity: "warning",
      type: "examination_request_assigned", title: `Examination evidence request: ${description.trim()}`, body: "",
      sourceModule: "regulatory-examination", sourceId: inserted._id, actionUrl: "/business?view=regulated",
      dedupeKey: `${orgId}:examination_request_assigned:${inserted._id}`,
    });
  }
  return { request: inserted };
}

export async function respondToRequest({ orgId, requestId, response, actorEmail }) {
  const { regulatoryExaminationRequests } = await getOrgCollections();
  const now = new Date().toISOString();
  const updated = await regulatoryExaminationRequests.findOneAndUpdate(
    { _id: toObjectId(requestId), orgId: toObjectId(orgId), status: "REQUESTED" },
    { $set: { status: "SUBMITTED", response: response || "", updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await regulatoryExaminationRequests.findOne({ _id: toObjectId(requestId), orgId: toObjectId(orgId) });
    if (!current) return { error: "Request not found.", status: 404 };
    return { error: `This request isn't awaiting a response (it's currently ${current.status}).`, status: 409 };
  }
  await logOrgActivity({ orgId, recordType: "REGULATORY_EXAMINATION", recordId: updated.examinationId, actorEmail, action: "REQUEST_RESPONDED", previousState: null, newState: null, metadata: { requestId: updated._id } });
  return { request: updated };
}

export async function approveResponse({ orgId, requestId, approve, reviewerComments, actorEmail, membership }) {
  if (!canManageAudit(membership)) return { error: "Only an audit manager or org owner/admin can review an examination response.", status: 403 };
  const { regulatoryExaminationRequests } = await getOrgCollections();
  const toState = approve ? "APPROVED" : "REJECTED";
  const now = new Date().toISOString();
  const updated = await regulatoryExaminationRequests.findOneAndUpdate(
    { _id: toObjectId(requestId), orgId: toObjectId(orgId), status: "SUBMITTED" },
    { $set: { status: toState, reviewerComments: reviewerComments || null, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "This response isn't awaiting review.", status: 409 };
  await logOrgActivity({ orgId, recordType: "REGULATORY_EXAMINATION", recordId: updated.examinationId, actorEmail, action: toState === "APPROVED" ? "REQUEST_APPROVED" : "REQUEST_REJECTED", previousState: "SUBMITTED", newState: toState, metadata: { requestId: updated._id } });
  return { request: updated };
}

export async function listExaminations(orgId, { status } = {}) {
  const { regulatoryExaminations } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (status) query.status = status;
  return regulatoryExaminations.find(query).sort({ createdAt: -1 }).toArray();
}

export async function listExaminationRequests(orgId, examinationId, { status, ownerEmail } = {}) {
  const { regulatoryExaminationRequests } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId), examinationId: toObjectId(examinationId) };
  if (status) query.status = status;
  if (ownerEmail) query.ownerEmail = ownerEmail;
  return regulatoryExaminationRequests.find(query).sort({ createdAt: -1 }).toArray();
}
