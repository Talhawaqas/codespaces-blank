// src/lib/risk-register.js
//
// Healthcare & Legal Expansion SOW, Phase 1 (§4.11) — organizational risk
// register. A simpler CRUD-plus-review-date shape than incidents.js/
// export-center.js — the SOW doesn't define a state-machine lifecycle for
// risk entries the way it does for incidents/exports, just fields plus a
// status. Owner/admin only, same reasoning as incidents.js.

import { getOrgCollections, toObjectId, canManageOrg } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";

export const RISK_SEVERITIES = ["low", "medium", "high", "critical"];
export const RISK_STATUSES = ["open", "mitigating", "accepted", "closed"];

export async function createRisk({ orgId, category, severity, likelihood, impact, ownerEmail, mitigation, reviewDate, relatedIncidentId, controlId, requirementId, frameworkId, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can add a risk entry.", status: 403 };
  const { riskRegister } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), category, severity, likelihood, impact,
    ownerEmail: ownerEmail || actorEmail, mitigation: mitigation || "",
    status: "open", reviewDate: reviewDate || null, evidence: [],
    relatedIncidentId: relatedIncidentId ? toObjectId(relatedIncidentId) : null,
    // Financial Services & Regulated Enterprise SOW, Phase 4 (§50) — the
    // Risk & Control Matrix is this same risk register with these three
    // foreign keys, not a parallel risk concept. All three are optional:
    // a risk doesn't have to be compliance-linked to exist here.
    controlId: controlId ? toObjectId(controlId) : null,
    requirementId: requirementId || null,
    frameworkId: frameworkId || null,
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await riskRegister.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "RISK", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: "open", metadata: { category, severity } });
  return { risk: inserted };
}

export async function linkRiskToControl({ orgId, riskId, controlId, requirementId, frameworkId, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can link a risk entry.", status: 403 };
  const { riskRegister } = await getOrgCollections();
  const setDoc = { updatedAt: new Date().toISOString() };
  if (controlId !== undefined) setDoc.controlId = controlId ? toObjectId(controlId) : null;
  if (requirementId !== undefined) setDoc.requirementId = requirementId;
  if (frameworkId !== undefined) setDoc.frameworkId = frameworkId;

  const updated = await riskRegister.findOneAndUpdate(
    { _id: toObjectId(riskId), orgId: toObjectId(orgId) },
    { $set: setDoc },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Risk entry not found.", status: 404 };
  await logOrgActivity({ orgId, recordType: "RISK", recordId: updated._id, actorEmail, action: "LINKED", previousState: null, newState: null, metadata: { controlId: controlId || null, requirementId: requirementId || null } });
  return { risk: updated };
}

export async function updateRiskStatus({ orgId, riskId, status, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can update a risk entry.", status: 403 };
  if (!RISK_STATUSES.includes(status)) return { error: `Unknown status "${status}".`, status: 400 };
  const { riskRegister } = await getOrgCollections();
  const current = await riskRegister.findOne({ _id: toObjectId(riskId), orgId: toObjectId(orgId) });
  if (!current) return { error: "Risk entry not found.", status: 404 };
  const updated = await riskRegister.findOneAndUpdate(
    { _id: toObjectId(riskId), orgId: toObjectId(orgId) },
    { $set: { status, updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  await logOrgActivity({ orgId, recordType: "RISK", recordId: updated._id, actorEmail, action: "STATUS_CHANGED", previousState: current.status, newState: status, metadata: {} });
  return { risk: updated };
}

export async function listRisks(orgId, { status } = {}) {
  const { riskRegister } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (status) query.status = status;
  return riskRegister.find(query).sort({ reviewDate: 1, createdAt: -1 }).toArray();
}
