// src/lib/incidents.js
//
// Healthcare & Legal Expansion SOW, Phase 1 (§4.8) — organizational
// incident response. Confirmed via codebase audit that security.js has NO
// equivalent concept (it tracks threat-indicators and per-identity
// block/warn/allow decisions, never an assignable, timelined incident
// record) — this is genuinely new, following document-workflow.js's
// TRANSITIONS-map + atomic findOneAndUpdate pattern exactly.
//
// Every state change goes through org-activity-log.js's logOrgActivity
// (human-readable org_activity entry + best-effort audit-chain append) —
// no parallel audit system.

import { getOrgCollections, toObjectId, canManageOrg } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";
import { createNotification } from "./notifications.js";

export const INCIDENT_CATEGORIES = [
  "unauthorized_access", "suspicious_login", "data_export", "accidental_disclosure",
  "malware", "ransomware", "lost_device", "compromised_account", "policy_violation",
  "ai_security_event", "backup_failure",
  // Financial Services & Regulated Enterprise SOW, Phase 4 (§53) — the
  // broader incident-class list a regulated-enterprise org needs beyond
  // the original security-only set above.
  "financial", "fraud", "regulatory", "data_integrity", "vendor", "physical_security", "safety",
];

export const INCIDENT_SEVERITIES = ["low", "medium", "high", "critical"];

export const INCIDENT_STATES = ["OPEN", "CONTAINED", "INVESTIGATING", "RESOLVED", "CLOSED"];

export const INCIDENT_TRANSITIONS = {
  contain: { from: "OPEN", to: "CONTAINED", activityAction: "CONTAINED" },
  investigate: { from: "CONTAINED", to: "INVESTIGATING", activityAction: "INVESTIGATION_STARTED" },
  resolve: { from: "INVESTIGATING", to: "RESOLVED", activityAction: "RESOLVED" },
  close: { from: "RESOLVED", to: "CLOSED", activityAction: "CLOSED" },
  reopen: { from: "RESOLVED", to: "INVESTIGATING", activityAction: "REOPENED" },
};

/** Only owner/admin may manage incidents in Phase 1 — the SOW doesn't
 *  define a dedicated "incident responder" role, and inventing one
 *  without being asked would be scope creep beyond what §4.8 actually
 *  specifies. A future pass can add a narrower role if needed. */
export async function createIncident({ orgId, category, severity, description, affectedRecordType, affectedRecordIds, ownerEmail, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can report an incident.", status: 403 };
  if (!INCIDENT_CATEGORIES.includes(category)) return { error: `Unknown incident category "${category}".`, status: 400 };
  if (!INCIDENT_SEVERITIES.includes(severity)) return { error: `Unknown severity "${severity}".`, status: 400 };

  const { incidents } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const now = new Date().toISOString();
  const doc = {
    orgId: orgObjectId,
    category, severity, description: description || "",
    affectedRecordType: affectedRecordType || null,
    affectedRecordIds: affectedRecordIds || [],
    status: "OPEN",
    ownerEmail: ownerEmail || actorEmail,
    containmentNotes: [], investigationNotes: [], evidenceRefs: [], taskIds: [],
    timeline: [{ event: "REPORTED", actorEmail, at: now }],
    createdByEmail: actorEmail,
    createdAt: now, updatedAt: now, resolvedAt: null, postIncidentReview: null,
  };
  const result = await incidents.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "INCIDENT", recordId: inserted._id, actorEmail, action: "REPORTED", previousState: null, newState: "OPEN", metadata: { category, severity } });

  await createNotification({
    scope: "org", orgId, targetEmail: null, category: "incident", severity: severity === "critical" || severity === "high" ? "critical" : "warning",
    type: "incident_reported", title: `Incident reported: ${category.replace(/_/g, " ")}`, body: description || "",
    sourceModule: "incidents", sourceId: inserted._id, actionUrl: "/business?view=trustCenter",
    dedupeKey: `${orgId}:incident_reported:${inserted._id}`,
  });

  return { incident: inserted };
}

export async function transitionIncident({ orgId, incidentId, action, actorEmail, membership, note }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can update an incident.", status: 403 };
  const definition = INCIDENT_TRANSITIONS[action];
  if (!definition) return { error: `Unknown action "${action}".`, status: 400 };

  const { incidents } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const incidentObjectId = toObjectId(incidentId);
  const now = new Date().toISOString();

  const updated = await incidents.findOneAndUpdate(
    { _id: incidentObjectId, orgId: orgObjectId, status: definition.from },
    {
      $set: { status: definition.to, updatedAt: now, ...(definition.to === "RESOLVED" ? { resolvedAt: now } : {}) },
      $push: { timeline: { event: definition.activityAction, actorEmail, at: now, note: note || null } },
    },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await incidents.findOne({ _id: incidentObjectId, orgId: orgObjectId });
    if (!current) return { error: "Incident not found.", status: 404 };
    return { error: `This incident isn't in ${definition.from} state (it's currently ${current.status}).`, status: 409 };
  }

  await logOrgActivity({ orgId, recordType: "INCIDENT", recordId: incidentObjectId, actorEmail, action: definition.activityAction, previousState: definition.from, newState: definition.to, metadata: note ? { note } : {} });
  return { incident: updated };
}

/** SOW §4.8's post-incident review — a plain text field set once, only on
 *  a CLOSED incident (a review of an incident still open makes no sense). */
export async function recordPostIncidentReview({ orgId, incidentId, actorEmail, membership, review }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can record a post-incident review.", status: 403 };
  const { incidents } = await getOrgCollections();
  const updated = await incidents.findOneAndUpdate(
    { _id: toObjectId(incidentId), orgId: toObjectId(orgId), status: "CLOSED" },
    { $set: { postIncidentReview: { review, recordedByEmail: actorEmail, recordedAt: new Date().toISOString() } } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Incident must be CLOSED before recording a post-incident review.", status: 409 };
  return { incident: updated };
}

export async function listIncidents(orgId, { status } = {}) {
  const { incidents } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (status) query.status = status;
  return incidents.find(query).sort({ createdAt: -1 }).toArray();
}
