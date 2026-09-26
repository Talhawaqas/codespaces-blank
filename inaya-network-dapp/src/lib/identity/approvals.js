// src/lib/identity/approvals.js
//
// SOW §38: human approval for high-risk lifecycle mutations reuses Inaya's existing Controlled Actions
// (ai_action_requests: PENDING_APPROVAL -> APPROVED -> 36 h delay -> EXECUTED, idempotent, risk-classified).
// There is no second approval engine.
//
// What needs approval: GRANTING privilege that comes from outside (the admin role, and any mapping an administrator
// marked privileged). What never does: removing or restricting access. A delay on a revocation would defeat its purpose.
//
// The grant sits in the ledger as PENDING_APPROVAL and confers NOTHING until it is approved AND the delay has passed.
// At execution time the request is re-checked against the world as it is then: if the person was disabled, revoked, or
// the grant withdrawn in the meantime, it does not execute (honest EXPIRED), so an approval can never resurrect access.

import { toObjectId } from "../orgs.js";
import { proposeAiAction } from "../ai-action-requests.js";
import { getIdentityCollections } from "./db.js";
import { fail, nowIso, normEmail } from "./common.js";
import { materialize } from "./grants.js";
import { audit } from "./record.js";

/** Creates the Controlled Action for one pending privileged grant. Returns { requestId } or { error }. */
export async function proposePrivilegedGrant({ orgId, email, grant, runId, providerId, actorLabel }) {
  const r = await proposeAiAction({
    orgId, assistantSurface: "identity-integration", toolName: "identity_privileged_grant", targetRecordType: "IDENTITY_LIFECYCLE", targetRecordId: runId,
    proposedAction: "grant", args: { orgId: String(orgId), email: normEmail(email), grantId: String(grant._id), kind: grant.kind, value: grant.value, providerId: providerId ? String(providerId) : null },
    requestedContextSummary: `Grant ${grant.kind} "${grant.value}" to ${normEmail(email)} (from ${actorLabel}). It has no effect until approved and the standard delay has passed.`,
    actorEmail: actorLabel, canPropose: true,
  });
  if (r.error) return r;
  const { identityGrants } = await getIdentityCollections();
  await identityGrants.updateOne({ _id: grant._id }, { $set: { requestId: String(r.request._id) } });
  return { requestId: String(r.request._id), deduped: !!r.deduped };
}

/**
 * Executor registered with Controlled Actions (see ai-action-requests.js). Runs only after a human approved the request and
 * the delay elapsed. Returns { success } or { error } (an error is recorded as an honest EXPIRED, never as executed).
 */
export async function executeApprovedGrant({ orgId, args, actorEmail }) {
  const { identityGrants, identityExternalUsers } = await getIdentityCollections();
  const { getOrgCollections } = await import("../orgs.js");
  const { orgMembers } = await getOrgCollections();
  const g = await identityGrants.findOne({ _id: toObjectId(args.grantId), orgId: toObjectId(orgId) });
  if (!g || g.status !== "PENDING_APPROVAL") return { error: "The grant is no longer pending (it was withdrawn or already applied).", status: 409 };
  const m = await orgMembers.findOne({ orgId: toObjectId(orgId), email: g.email });
  if (!m || m.status !== "active") return { error: "The person no longer has active access, so the grant was not applied.", status: 409 };
  const ext = await identityExternalUsers.findOne({ orgId: toObjectId(orgId), inayaEmail: g.email });
  if (ext && ["DISABLED", "REVOKED"].includes(ext.lifecycleState)) return { error: "The person was disabled in the source directory after this was proposed, so the grant was not applied.", status: 409 };
  await identityGrants.updateOne({ _id: g._id }, { $set: { status: "ACTIVE", activatedAt: nowIso(), approvedBy: actorEmail } });
  await materialize({ orgId, email: g.email });
  await audit({ orgId, action: "IDENTITY_PRIVILEGED_GRANT_APPLIED", actorEmail, metadata: { email: g.email, kind: g.kind, value: g.value, requestId: args.grantId } });
  return { success: true };
}

/** A pending privileged grant that was never approved (or whose request was rejected/expired) is withdrawn. */
export async function withdrawPending({ orgId, email }) {
  const { identityGrants } = await getIdentityCollections();
  const r = await identityGrants.updateMany({ orgId: toObjectId(orgId), email: normEmail(email), status: "PENDING_APPROVAL" }, { $set: { status: "REVOKED", revokedAt: nowIso(), revokedReason: "withdrawn" } });
  return r.modifiedCount;
}

export const notAllowed = (m) => fail(m, 403);
