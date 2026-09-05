// src/lib/legal-clients.js
//
// Healthcare & Legal Expansion SOW, Phase 6 (§11.2-11.3) — client &
// prospective-client management. Prospective clients get a DELIBERATELY
// restricted default (classification CONFIDENTIAL, no department
// fallback per §11.3) since a prospect record often contains conflict-
// sensitive information about a matter the firm hasn't even taken yet.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canAccessLegalMatters } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export async function createClient({ orgId, personOrCompany, name, contacts, conflictIdentifiers, actorEmail, membership }) {
  if (!canAccessLegalMatters(membership)) return { error: "You don't have permission to add a client.", status: 403 };
  const { legalClients } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), personOrCompany: personOrCompany || "person", name,
    contacts: contacts || [], status: "active", conflictIdentifiers: conflictIdentifiers || [],
    portalAccess: false, createdByEmail: actorEmail, createdAt: now, updatedAt: now, deletedAt: null,
  };
  const result = await legalClients.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "LEGAL_CLIENT", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: "active", metadata: {} });
  return { client: inserted };
}

/** SOW §11.3's intake workflow start — a restricted prospect record, not
 *  a full client. `restricted:true` is meant to be read by whatever UI/
 *  API layer renders prospect lists — enforcing it as an actual access
 *  boundary is classification.js's job once this record is tagged
 *  CONFIDENTIAL and surfaced through the same resolveClassificationAccess
 *  path documents already use. */
export async function createProspect({ orgId, name, contacts, conflictIdentifiers, actorEmail, membership }) {
  if (!canAccessLegalMatters(membership)) return { error: "You don't have permission to add a prospective client.", status: 403 };
  const { legalProspects } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), name, contacts: contacts || [], conflictIdentifiers: conflictIdentifiers || [],
    status: "intake", classification: "CONFIDENTIAL",
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await legalProspects.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "LEGAL_PROSPECT", recordId: inserted._id, actorEmail, action: "INTAKE", previousState: null, newState: "intake", metadata: {} });
  return { prospect: inserted };
}

/** Converts a cleared prospect into an engagement decision — advances the
 *  prospect's own status rather than deleting it, matching this
 *  codebase's "never destroy the intake trail" discipline. Does NOT
 *  create the client/matter itself — that's a deliberate separate step
 *  (createClient / legal-matter-workflow.js's createMatter), since a
 *  prospect converting doesn't always become exactly one client+matter
 *  pair without a human decision in between. */
export async function decideProspectEngagement({ orgId, prospectId, decision, actorEmail, membership }) {
  if (!canAccessLegalMatters(membership)) return { error: "You don't have permission to decide on a prospective client.", status: 403 };
  if (!["engage", "decline"].includes(decision)) return { error: `Unknown decision "${decision}".`, status: 400 };
  const { legalProspects } = await getOrgCollections();
  const toStatus = decision === "engage" ? "engaged" : "declined";
  const updated = await legalProspects.findOneAndUpdate(
    { _id: toObjectId(prospectId), orgId: toObjectId(orgId), status: { $in: ["intake", "consultation"] } },
    { $set: { status: toStatus, updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Prospect not found, or already decided.", status: 409 };
  await logOrgActivity({ orgId, recordType: "LEGAL_PROSPECT", recordId: updated._id, actorEmail, action: toStatus.toUpperCase(), previousState: "intake", newState: toStatus, metadata: {} });
  return { prospect: updated };
}
