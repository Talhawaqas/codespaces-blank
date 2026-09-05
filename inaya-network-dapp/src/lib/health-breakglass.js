// src/lib/health-breakglass.js
//
// Healthcare & Legal Expansion SOW, Phase 3 (§10.20) — emergency
// break-glass access. Deliberately NOT a separate access-bypass code
// path: a break-glass grant is implemented as a genuine, time-limited
// health_care_team_assignments row (the exact same join table
// getAccessibleScope() already reads for ordinary care-team visibility),
// tagged `breakGlass: true` with a mandatory reason and an `expiresAt`.
// This means there is no second permission-check branch anywhere in the
// codebase that could be a bypass bug waiting to happen — break-glass
// access is real assignment-based access, just time-boxed and always
// audited+notified the instant it's granted, per the SOW's explicit
// "never a general bypass" instruction.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { logBreakGlassGrant } from "./health-audit.js";
import { createNotification } from "./notifications.js";

const DEFAULT_BREAK_GLASS_HOURS = 4;

export async function grantBreakGlassAccess({ orgId, patientId, actorEmail, reason, hours = DEFAULT_BREAK_GLASS_HOURS }) {
  if (!reason || !reason.trim()) return { error: "A reason is required for emergency access.", status: 400 };

  const { healthCareTeamAssignments, healthPatients, orgMembers } = await getOrgCollections();
  const patient = await healthPatients.findOne({ _id: toObjectId(patientId), orgId: toObjectId(orgId), deletedAt: null });
  if (!patient) return { error: "Patient not found.", status: 404 };

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  await healthCareTeamAssignments.findOneAndUpdate(
    { orgId: toObjectId(orgId), patientId: toObjectId(patientId), email: actorEmail },
    { $set: { role: "break_glass", breakGlass: true, reason, expiresAt, updatedAt: now }, $setOnInsert: { createdAt: now, assignedByEmail: actorEmail } },
    { upsert: true }
  );

  // Immediate audit + notification — not a post-hoc log, a real-time one,
  // per the SOW's "immediate audit + administrator/compliance
  // notification" requirement.
  await logBreakGlassGrant({ orgId, patientId, actorEmail, reason });

  const managers = await orgMembers.find({ orgId: toObjectId(orgId), $or: [{ role: { $in: ["owner", "admin"] } }, { healthRole: "manager" }] }).toArray();
  await Promise.all(
    managers.map((m) =>
      createNotification({
        scope: "org", orgId, targetEmail: m.email, category: "security", severity: "critical",
        type: "break_glass_review", title: "Emergency access granted — review required",
        body: `${actorEmail} granted themselves emergency access to a patient record. Reason: ${reason}`,
        sourceModule: "health-breakglass", sourceId: patient._id, actionUrl: "/business?view=trustCenter",
        dedupeKey: `${orgId}:break_glass_review:${patient._id}:${actorEmail}:${now}`,
      })
    )
  );

  return { granted: true, expiresAt };
}

/** Every break-glass grant needs a real post-event review — surfaced here
 *  by querying the assignment rows directly rather than a separate
 *  "reviewed" collection, since the assignment row IS the record. */
export async function listUnreviewedBreakGlassGrants(orgId) {
  const { healthCareTeamAssignments } = await getOrgCollections();
  return healthCareTeamAssignments.find({ orgId: toObjectId(orgId), breakGlass: true, reviewedAt: { $exists: false } }).sort({ createdAt: -1 }).toArray();
}

export async function reviewBreakGlassGrant({ orgId, assignmentId, actorEmail, reviewNotes }) {
  const { healthCareTeamAssignments } = await getOrgCollections();
  const updated = await healthCareTeamAssignments.findOneAndUpdate(
    { _id: toObjectId(assignmentId), orgId: toObjectId(orgId), breakGlass: true },
    { $set: { reviewedAt: new Date().toISOString(), reviewedByEmail: actorEmail, reviewNotes: reviewNotes || "" } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Break-glass grant not found.", status: 404 };
  return { assignment: updated };
}
