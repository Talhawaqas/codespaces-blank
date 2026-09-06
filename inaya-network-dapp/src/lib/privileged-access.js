// src/lib/privileged-access.js
//
// Financial Services & Regulated Enterprise SOW, Phase 5 (§62-63) —
// Privileged Access + Break-Glass Access. Cross-vertical. ONE collection,
// TWO grant paths, sharing the same "time-limited elevated session"
// record shape rather than a second bypass code path:
//
//   requestElevation() -> PENDING_APPROVAL -> approveElevation() (must be
//   a DIFFERENT person than the requester -- the exact segregation-of-
//   duties conflict §61 lists: "administrator approving own access") ->
//   ACTIVE, expires at requestedHours.
//
//   grantBreakGlass() -> ACTIVE immediately (§63: "reason required,
//   identity verified" -- no approval gate, since emergency access must
//   not wait on one), but sends an immediate critical notification to
//   every owner/admin (same real-time-audit pattern as
//   health-breakglass.js) and REQUIRES a post-event review + attestation
//   before it can be considered closed out.
//
// Both paths converge on isSessionActive() (checks status==="ACTIVE" AND
// expiresAt in the future) as the single source of truth for "is this
// elevation currently in effect" -- no separate boolean flag that could
// drift out of sync with the actual expiry.

import { getOrgCollections, toObjectId, canManageOrg } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";
import { createNotification } from "./notifications.js";

export const PRIVILEGED_SESSION_STATES = ["PENDING_APPROVAL", "ACTIVE", "EXPIRED", "REVOKED", "REJECTED"];
const DEFAULT_BREAK_GLASS_HOURS = 4;

export async function requestElevation({ orgId, role, reason, scope, requestedHours, actorEmail, membership }) {
  if (!reason?.trim()) return { error: "A reason is required.", status: 400 };
  if (!scope?.trim()) return { error: "A scope is required.", status: 400 };

  const { privilegedSessions } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), grantType: "planned", role: role || null, reason: reason.trim(), scope: scope.trim(),
    requestedHours: requestedHours || DEFAULT_BREAK_GLASS_HOURS, requestedByEmail: actorEmail,
    approvedByEmail: null, approvedAt: null, expiresAt: null,
    status: "PENDING_APPROVAL", reviewedAt: null, reviewedByEmail: null, reviewNotes: null, attestation: null,
    sessionLog: [{ event: "requested", actorEmail, at: now }],
    createdAt: now, updatedAt: now,
  };
  const result = await privilegedSessions.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "PRIVILEGED_SESSION", recordId: inserted._id, actorEmail, action: "REQUESTED", previousState: null, newState: "PENDING_APPROVAL", metadata: { role, scope } });
  return { session: inserted };
}

/** SECURITY: the approver must be a different person than the requester
 *  -- the exact SoD conflict §61 calls out ("administrator approving own
 *  access"). */
export async function approveElevation({ orgId, sessionId, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can approve a privileged access request.", status: 403 };
  const { privilegedSessions } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const sessionObjectId = toObjectId(sessionId);
  const current = await privilegedSessions.findOne({ _id: sessionObjectId, orgId: orgObjectId });
  if (!current) return { error: "Privileged access request not found.", status: 404 };
  if (current.requestedByEmail === actorEmail) return { error: "The approver must be a different person than the requester.", status: 403 };

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + current.requestedHours * 60 * 60 * 1000).toISOString();
  const updated = await privilegedSessions.findOneAndUpdate(
    { _id: sessionObjectId, orgId: orgObjectId, status: "PENDING_APPROVAL" },
    { $set: { status: "ACTIVE", approvedByEmail: actorEmail, approvedAt: now, expiresAt, updatedAt: now }, $push: { sessionLog: { event: "approved", actorEmail, at: now } } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "This request is no longer pending approval.", status: 409 };
  await logOrgActivity({ orgId, recordType: "PRIVILEGED_SESSION", recordId: updated._id, actorEmail, action: "APPROVED", previousState: "PENDING_APPROVAL", newState: "ACTIVE", metadata: {} });
  return { session: updated };
}

export async function rejectElevation({ orgId, sessionId, actorEmail, membership, reason }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can reject a privileged access request.", status: 403 };
  const { privilegedSessions } = await getOrgCollections();
  const now = new Date().toISOString();
  const updated = await privilegedSessions.findOneAndUpdate(
    { _id: toObjectId(sessionId), orgId: toObjectId(orgId), status: "PENDING_APPROVAL" },
    { $set: { status: "REJECTED", updatedAt: now }, $push: { sessionLog: { event: "rejected", actorEmail, reason: reason || null, at: now } } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "This request is no longer pending approval.", status: 409 };
  return { session: updated };
}

/** Emergency access -- ACTIVE immediately, no approval gate, but always
 *  real-time audited + notified, exactly like health-breakglass.js. */
export async function grantBreakGlass({ orgId, role, reason, scope, hours = DEFAULT_BREAK_GLASS_HOURS, actorEmail, membership }) {
  if (!reason?.trim()) return { error: "A reason is required for emergency access.", status: 400 };
  if (!scope?.trim()) return { error: "A scope is required for emergency access.", status: 400 };

  const { privilegedSessions, orgMembers } = await getOrgCollections();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  const doc = {
    orgId: toObjectId(orgId), grantType: "break_glass", role: role || null, reason: reason.trim(), scope: scope.trim(),
    requestedHours: hours, requestedByEmail: actorEmail,
    approvedByEmail: null, approvedAt: null, expiresAt,
    status: "ACTIVE", reviewedAt: null, reviewedByEmail: null, reviewNotes: null, attestation: null,
    sessionLog: [{ event: "granted", actorEmail, at: now }],
    createdAt: now, updatedAt: now,
  };
  const result = await privilegedSessions.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "PRIVILEGED_SESSION", recordId: inserted._id, actorEmail, action: "BREAK_GLASS_GRANTED", previousState: null, newState: "ACTIVE", metadata: { scope: doc.scope, reason: doc.reason } });

  const managers = await orgMembers.find({ orgId: toObjectId(orgId), role: { $in: ["owner", "admin"] } }).toArray();
  await Promise.all(managers.map((m) => createNotification({
    scope: "org", orgId, targetEmail: m.email, category: "security", severity: "critical",
    type: "break_glass_review", title: "Emergency access granted — review required",
    body: `${actorEmail} granted themselves emergency access (${doc.scope}). Reason: ${doc.reason}`,
    sourceModule: "privileged-access", sourceId: inserted._id, actionUrl: "/business?view=trustCenter",
    dedupeKey: `${orgId}:break_glass_review:${inserted._id}`,
  })));

  return { session: inserted, expiresAt };
}

export async function revokeSession({ orgId, sessionId, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can revoke a privileged session.", status: 403 };
  const { privilegedSessions } = await getOrgCollections();
  const now = new Date().toISOString();
  const updated = await privilegedSessions.findOneAndUpdate(
    { _id: toObjectId(sessionId), orgId: toObjectId(orgId), status: "ACTIVE" },
    { $set: { status: "REVOKED", updatedAt: now }, $push: { sessionLog: { event: "revoked", actorEmail, at: now } } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "This session is not currently active.", status: 409 };
  await logOrgActivity({ orgId, recordType: "PRIVILEGED_SESSION", recordId: updated._id, actorEmail, action: "REVOKED", previousState: "ACTIVE", newState: "REVOKED", metadata: {} });
  return { session: updated };
}

/** Mandatory post-event review (§62, §63) -- required for every
 *  break-glass grant and every completed planned elevation, recording an
 *  explicit attestation, not just a silent status flip. */
export async function reviewSession({ orgId, sessionId, actorEmail, membership, reviewNotes, attestation }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can review a privileged session.", status: 403 };
  if (!attestation?.trim()) return { error: "An attestation statement is required to close out the review.", status: 400 };

  const { privilegedSessions } = await getOrgCollections();
  const now = new Date().toISOString();
  const updated = await privilegedSessions.findOneAndUpdate(
    { _id: toObjectId(sessionId), orgId: toObjectId(orgId), reviewedAt: null },
    { $set: { reviewedAt: now, reviewedByEmail: actorEmail, reviewNotes: reviewNotes || "", attestation: attestation.trim() } },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await privilegedSessions.findOne({ _id: toObjectId(sessionId), orgId: toObjectId(orgId) });
    if (!current) return { error: "Privileged session not found.", status: 404 };
    return { error: "This session has already been reviewed.", status: 409 };
  }
  return { session: updated };
}

export function isSessionActive(session) {
  return session.status === "ACTIVE" && new Date(session.expiresAt).getTime() > Date.now();
}

export async function listUnreviewedSessions(orgId) {
  const { privilegedSessions } = await getOrgCollections();
  return privilegedSessions.find({ orgId: toObjectId(orgId), reviewedAt: null, status: { $in: ["ACTIVE", "EXPIRED", "REVOKED"] } }).sort({ createdAt: -1 }).toArray();
}

export async function listSessions(orgId, { status, grantType } = {}) {
  const { privilegedSessions } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (status) query.status = status;
  if (grantType) query.grantType = grantType;
  return privilegedSessions.find(query).sort({ createdAt: -1 }).toArray();
}
