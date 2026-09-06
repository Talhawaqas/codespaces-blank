// src/lib/fundraising.js
//
// Financial Services & Regulated Enterprise SOW, Phase 3 (§40) —
// Fundraising Management (raising a NEW fund from LPs). "private_capital"
// vertical only.
//
// A prospective LP is not yet a capital-committed investor -- same
// LEAD-before-CUSTOMER distinction Business CRM's contacts.js already
// uses. convertToInvestor() is the field-edit-style conversion (matching
// that precedent, tested in crm-workflow.test.mjs's "contact type flip")
// into a REAL financial-investors.js Investor record once an LP closes,
// rather than a second, parallel investor concept. Data room/subscription
// documents/closing checklist reuse org_documents + document-permissions
// like every other document concept in this codebase, not a new storage
// system.

import { getOrgCollections, canAccessFinancialEntities, canManageFinancialEntities, toObjectId } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";
import { createInvestor } from "./financial-investors.js";

export const LP_PIPELINE_STAGES = ["IDENTIFIED", "OUTREACH", "MEETING", "DILIGENCE", "SOFT_CIRCLE", "LEGAL_DOCS", "CLOSED", "PASSED"];
const OPEN_PIPELINE = ["IDENTIFIED", "OUTREACH", "MEETING", "DILIGENCE", "SOFT_CIRCLE", "LEGAL_DOCS"];

function nextOpenStage(stage) {
  const i = OPEN_PIPELINE.indexOf(stage);
  return i >= 0 && i < OPEN_PIPELINE.length - 1 ? OPEN_PIPELINE[i + 1] : null;
}

export async function createFundraisingProspect({ orgId, fundId, legalName, targetCommitment, source, actorEmail, membership }) {
  if (!canAccessFinancialEntities(membership)) return { error: "You don't have financial-entities access.", status: 403 };
  if (!legalName?.trim()) return { error: "A prospect legal name is required.", status: 400 };

  const { fundraisingProspects } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), fundId: toObjectId(fundId), legalName: legalName.trim(),
    targetCommitment: targetCommitment ?? null, source: source || null,
    communications: [], convertedInvestorId: null,
    stage: "IDENTIFIED",
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await fundraisingProspects.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "FUNDRAISING_PROSPECT", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: "IDENTIFIED", metadata: { legalName: doc.legalName } });
  return { prospect: inserted };
}

export async function transitionProspect({ orgId, prospectId, action, actorEmail, membership, note }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can update a fundraising prospect.", status: 403 };
  if (!["advance", "pass", "reopen"].includes(action)) return { error: `Unknown action "${action}".`, status: 400 };

  const { fundraisingProspects } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const prospectObjectId = toObjectId(prospectId);
  const prospect = await fundraisingProspects.findOne({ _id: prospectObjectId, orgId: orgObjectId });
  if (!prospect) return { error: "Fundraising prospect not found.", status: 404 };

  let to;
  let activityAction;
  if (action === "advance") {
    to = nextOpenStage(prospect.stage);
    if (!to) return { error: `"${prospect.stage}" has no next pipeline stage -- use convertToInvestor() to close it.`, status: 409 };
    activityAction = "PROSPECT_ADVANCED";
  } else if (action === "pass") {
    if (!OPEN_PIPELINE.includes(prospect.stage)) return { error: `A prospect in "${prospect.stage}" can't be passed on -- it's already closed.`, status: 409 };
    to = "PASSED";
    activityAction = "PROSPECT_PASSED";
  } else {
    if (prospect.stage !== "PASSED") return { error: `Only a PASSED prospect can be reopened (this one is "${prospect.stage}").`, status: 409 };
    to = "IDENTIFIED";
    activityAction = "PROSPECT_REOPENED";
  }

  const now = new Date().toISOString();
  const updated = await fundraisingProspects.findOneAndUpdate(
    { _id: prospectObjectId, orgId: orgObjectId, stage: prospect.stage },
    { $set: { stage: to, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: `This prospect's stage changed since it was loaded (was "${prospect.stage}") -- reload and try again.`, status: 409 };

  await logOrgActivity({ orgId, recordType: "FUNDRAISING_PROSPECT", recordId: prospectObjectId, actorEmail, action: activityAction, previousState: prospect.stage, newState: to, metadata: note ? { note } : {} });
  return { prospect: updated };
}

/** The only path from LEGAL_DOCS to CLOSED -- creates a REAL
 *  financial-investors.js Investor record, reusing Phase 1's onboarding/
 *  capital-account machinery rather than inventing a parallel one. */
export async function convertToInvestor({ orgId, prospectId, entityType, jurisdiction, accreditationStatus, actorEmail, membership }) {
  if (!canManageFinancialEntities(membership)) return { error: "Only a financial-entities manager or org owner/admin can convert a prospect.", status: 403 };
  const { fundraisingProspects } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const prospectObjectId = toObjectId(prospectId);
  const prospect = await fundraisingProspects.findOne({ _id: prospectObjectId, orgId: orgObjectId });
  if (!prospect) return { error: "Fundraising prospect not found.", status: 404 };
  if (prospect.stage !== "LEGAL_DOCS") return { error: `A prospect can only convert to investor from LEGAL_DOCS (this one is "${prospect.stage}").`, status: 409 };

  const { investor, error, status } = await createInvestor({ orgId, fundId: prospect.fundId, legalName: prospect.legalName, entityType, jurisdiction, accreditationStatus, actorEmail, membership });
  if (error) return { error, status };

  const now = new Date().toISOString();
  const updated = await fundraisingProspects.findOneAndUpdate(
    { _id: prospectObjectId, orgId: orgObjectId, stage: "LEGAL_DOCS" },
    { $set: { stage: "CLOSED", convertedInvestorId: investor._id, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "This prospect's stage changed since it was loaded -- reload and try again.", status: 409 };

  await logOrgActivity({ orgId, recordType: "FUNDRAISING_PROSPECT", recordId: prospectObjectId, actorEmail, action: "CONVERTED_TO_INVESTOR", previousState: "LEGAL_DOCS", newState: "CLOSED", metadata: { investorId: investor._id } });
  return { prospect: updated, investor };
}

export async function recordCommunication({ orgId, prospectId, note, actorEmail, membership }) {
  if (!canAccessFinancialEntities(membership)) return { error: "You don't have financial-entities access.", status: 403 };
  if (!note?.trim()) return { error: "A note is required.", status: 400 };
  const { fundraisingProspects } = await getOrgCollections();
  const now = new Date().toISOString();
  const updated = await fundraisingProspects.findOneAndUpdate(
    { _id: toObjectId(prospectId), orgId: toObjectId(orgId) },
    { $push: { communications: { note: note.trim(), actorEmail, at: now } }, $set: { updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Fundraising prospect not found.", status: 404 };
  return { prospect: updated };
}

export async function listFundraisingProspects(orgId, fundId, { stage } = {}) {
  const { fundraisingProspects } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId), fundId: toObjectId(fundId) };
  if (stage) query.stage = stage;
  return fundraisingProspects.find(query).sort({ createdAt: -1 }).toArray();
}
