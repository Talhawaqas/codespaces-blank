// src/lib/legal-matter-workflow.js
//
// Healthcare & Legal Expansion SOW, Phase 6 (§11.4) — matter lifecycle +
// matter-team assignment (the join table getAccessibleScope() reads for
// assignment-based matter visibility, same shape as health-patients.js's
// assignCareTeamMember).

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canAccessLegalMatters } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export const MATTER_STATES = ["OPEN", "ACTIVE", "ON_HOLD", "CLOSED"];

export const MATTER_TRANSITIONS = {
  activate: { from: "OPEN", to: "ACTIVE", activityAction: "ACTIVATED" },
  putOnHold: { from: "ACTIVE", to: "ON_HOLD", activityAction: "ON_HOLD" },
  resume: { from: "ON_HOLD", to: "ACTIVE", activityAction: "RESUMED" },
  close: { from: "ACTIVE", to: "CLOSED", activityAction: "CLOSED" },
};

export async function createMatter({ orgId, name, clientId, type, jurisdiction, court, opposingParties, responsiblePartnerEmail, priority, confidentiality, privilegeClassification, billingArrangement, actorEmail, membership }) {
  if (!canAccessLegalMatters(membership)) return { error: "You don't have permission to open a matter.", status: 403 };
  const { legalMatters } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), name, clientId: clientId ? toObjectId(clientId) : null, type,
    jurisdiction: jurisdiction || null, court: court || null, opposingParties: opposingParties || [],
    responsiblePartnerEmail: responsiblePartnerEmail || actorEmail, team: [],
    status: "OPEN", priority: priority || "normal",
    confidentiality: confidentiality || "Confidential", privilegeClassification: privilegeClassification || null,
    billingArrangement: billingArrangement || null,
    openDate: now, closeDate: null,
    createdByEmail: actorEmail, createdAt: now, updatedAt: now, deletedAt: null,
  };
  const result = await legalMatters.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "LEGAL_MATTER", recordId: inserted._id, actorEmail, action: "OPENED", previousState: null, newState: "OPEN", metadata: { clientId, type } });
  return { matter: inserted };
}

export async function transitionMatter({ orgId, matterId, action, actorEmail, membership }) {
  if (!canAccessLegalMatters(membership)) return { error: "You don't have permission to update this matter.", status: 403 };
  const definition = MATTER_TRANSITIONS[action];
  if (!definition) return { error: `Unknown action "${action}".`, status: 400 };

  const { legalMatters } = await getOrgCollections();
  const now = new Date().toISOString();
  const setFields = { status: definition.to, updatedAt: now };
  if (action === "close") setFields.closeDate = now;

  const updated = await legalMatters.findOneAndUpdate(
    { _id: toObjectId(matterId), orgId: toObjectId(orgId), status: definition.from },
    { $set: setFields },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await legalMatters.findOne({ _id: toObjectId(matterId), orgId: toObjectId(orgId) });
    if (!current) return { error: "Matter not found.", status: 404 };
    return { error: `This matter isn't in ${definition.from} state (it's currently ${current.status}).`, status: 409 };
  }
  await logOrgActivity({ orgId, recordType: "LEGAL_MATTER", recordId: updated._id, actorEmail, action: definition.activityAction, previousState: definition.from, newState: definition.to, metadata: {} });
  return { matter: updated };
}

export async function assignMatterTeamMember({ orgId, matterId, memberEmail, role, actorEmail, membership }) {
  if (!canAccessLegalMatters(membership)) return { error: "You don't have permission to manage this matter's team.", status: 403 };
  const { legalMatterTeamAssignments, legalMatters } = await getOrgCollections();
  const matter = await legalMatters.findOne({ _id: toObjectId(matterId), orgId: toObjectId(orgId), deletedAt: null });
  if (!matter) return { error: "Matter not found.", status: 404 };

  const now = new Date().toISOString();
  await legalMatterTeamAssignments.findOneAndUpdate(
    { orgId: toObjectId(orgId), matterId: toObjectId(matterId), email: memberEmail },
    { $set: { role: role || "member", updatedAt: now }, $setOnInsert: { createdAt: now, assignedByEmail: actorEmail } },
    { upsert: true }
  );
  await logOrgActivity({ orgId, recordType: "LEGAL_MATTER", recordId: matter._id, actorEmail, action: "TEAM_MEMBER_ASSIGNED", previousState: null, newState: null, metadata: { memberEmail, role } });
  return { assigned: true };
}

export async function getMatterWorkspace(orgId, matterId) {
  const { legalMatters, legalMatterTeamAssignments } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const matterObjectId = toObjectId(matterId);
  const [matter, team] = await Promise.all([
    legalMatters.findOne({ _id: matterObjectId, orgId: orgObjectId }),
    legalMatterTeamAssignments.find({ orgId: orgObjectId, matterId: matterObjectId }).toArray(),
  ]);
  if (!matter) return null;
  return { matter, team };
}
