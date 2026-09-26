// src/lib/identity/revocation.js
//
// SOW §14-§16, §34: immediate access revocation, as an explicit state machine.
//
//   REVOCATION_PENDING -> REVOCATION_PARTIAL (some step failed; retry only what is left) -> REVOCATION_COMPLETE,
//   or REVOCATION_FAILED (nothing could be frozen).
//
// Steps, in order (each idempotent, each independently VERIFIED afterwards by re-reading the state, never by trusting
// the step's own return value):
//   FREEZE       membership status -> revoked | restricted. This is THE control: requireMembership() and every other
//                lookup accept only active memberships, so from this instant every Inaya API refuses the person, whatever
//                sessions or tokens they still hold. It runs first.
//   SESSIONS     Inaya sessions deleted (and unused login links). Sessions belong to an email, not to an organization, so by
//                default they are removed only if the person has no OTHER active membership; policy "always" removes them
//                regardless (compromise / incident).
//   CREDENTIALS  API keys, S3/Azure credentials and identity-integration credentials the person CREATED in this organization.
//   PERMISSIONS  roles and department scopes cleared, grants retired, project memberships and explicit document permissions removed.
//   SHARING      share links the person created are revoked.
//   BREAK_GLASS  the person's emergency-access rows are ended now.
// "restrict" (incident containment) performs FREEZE and SESSIONS only, so access can be restored later without rebuilding anything.
//
// Removal is never gated behind an approval or the 36-hour Controlled Action delay: delaying a revocation defeats its purpose.
// What this CANNOT do is recall tokens issued by an external identity provider; Inaya enforces its own authorization on every request.

import { emitIdentityEvent } from "./outbound.js";
import { toObjectId, getOrgCollections } from "../orgs.js";
import { getIdentityCollections } from "./db.js";
import { fail, nowIso, normEmail, IdentityError, classifyError } from "./common.js";
import { revokeGrants } from "./grants.js";

export const STEP_ORDER = ["FREEZE", "SESSIONS", "CREDENTIALS", "PERMISSIONS", "SHARING", "BREAK_GLASS"];
const RESTRICT_STEPS = ["FREEZE", "SESSIONS"];

let fault = null;
/** Test seam: makes one step fail `times` times with a transient error. Never used in production code. */
export function __setRevocationFault(step, times = 1) { fault = step ? { step, times } : null; }
const maybeFault = (step) => { if (fault && fault.step === step && fault.times > 0) { fault.times--; throw new IdentityError(`Injected ${step} failure.`, "TRANSIENT"); } };

const ROLE_FIELDS = ["financeRole", "hrRole", "supportRole", "storageRole", "escrowRole", "complianceRole", "managedDepartmentIds"];

async function otherActiveMemberships(orgId, email) {
  const { orgMembers } = await getOrgCollections();
  return orgMembers.countDocuments({ email, status: "active", orgId: { $ne: toObjectId(orgId) } });
}

// ------------------------------------------------------------------------------------------ the steps
const STEPS = {
  async FREEZE({ orgId, email, ctx }) {
    const { orgMembers } = await getOrgCollections();
    const m = await orgMembers.findOne({ orgId: toObjectId(orgId), email });
    const status = ctx.mode === "restrict" ? "restricted" : "revoked";
    await orgMembers.updateOne({ _id: m._id }, { $set: { status, identityFrozenAt: nowIso(), identityFrozenReason: ctx.reason || ctx.trigger, identityFrozenBy: ctx.actor, identityPreviousStatus: m.status === "active" ? "active" : m.identityPreviousStatus || m.status } });
    return { status };
  },
  async SESSIONS({ orgId, email, ctx }) {
    const { sessions, magicLinks } = await getOrgCollections();
    const others = await otherActiveMemberships(orgId, email);
    const always = ctx.policy.sessionRevocation === "always" || ctx.mode === "restrict" && ctx.trigger === "security";
    if (others > 0 && !always) return { skipped: "The person is an active member of another organization, so their sign-in sessions were kept. Access to this organization is already blocked by the membership freeze." };
    const r = await sessions.deleteMany({ email });
    await magicLinks.updateMany({ email, usedAt: null }, { $set: { usedAt: nowIso(), revokedByIdentity: true } });
    return { sessionsRemoved: r.deletedCount };
  },
  async CREDENTIALS({ orgId, email }) {
    const { apiKeys } = await getOrgCollections();
    const { db, identityCredentials } = await getIdentityCollections();
    const oid = toObjectId(orgId); const now = nowIso();
    const k = await apiKeys.updateMany({ orgId: oid, createdByEmail: email, revokedAt: null }, { $set: { revokedAt: now, revokedReason: "identity revocation" } });
    const s3 = await db.collection("s3_credentials").updateMany({ ownerType: "org", ownerId: String(orgId), createdByEmail: email, revokedAt: null }, { $set: { revokedAt: now, revokedReason: "identity revocation" } });
    const ic = await identityCredentials.updateMany({ $or: [{ orgId: oid }, { mspOrgId: oid }], createdBy: email, revokedAt: null }, { $set: { revokedAt: now, revokedReason: "identity revocation" } });
    return { apiKeysRevoked: k.modifiedCount, storageCredentialsRevoked: s3.modifiedCount, integrationCredentialsRevoked: ic.modifiedCount };
  },
  async PERMISSIONS({ orgId, email }) {
    const { orgMembers, projectMembers, documentPermissions } = await getOrgCollections();
    const oid = toObjectId(orgId);
    const g = await revokeGrants({ orgId, email, reason: "access revoked" });
    const m = await orgMembers.findOne({ orgId: oid, email });
    const unset = Object.fromEntries(ROLE_FIELDS.map((f) => [f, ""]));
    if (m.role !== "owner") await orgMembers.updateOne({ _id: m._id }, { $set: { role: "member", departmentIds: [], notifyOnApprovals: false }, $unset: unset });
    else await orgMembers.updateOne({ _id: m._id }, { $set: { role: "member", departmentIds: [], notifyOnApprovals: false }, $unset: unset }); // an owner who is revoked (another owner exists) is demoted as well
    const p = await projectMembers.deleteMany({ orgId: oid, email });
    const d = await documentPermissions.deleteMany({ orgId: oid, email });
    return { grantsRetired: g, projectMembershipsRemoved: p.deletedCount, documentPermissionsRemoved: d.deletedCount };
  },
  async SHARING({ orgId, email, ctx }) {
    if (!ctx.policy.revokeSharesCreatedByUser) return { skipped: "Policy keeps share links the person created." };
    const { documentShares } = await getOrgCollections();
    const r = await documentShares.updateMany({ orgId: toObjectId(orgId), createdByEmail: email, revokedAt: null }, { $set: { revokedAt: nowIso() } });
    return { sharesRevoked: r.modifiedCount };
  },
  async BREAK_GLASS({ orgId, email }) {
    const { healthCareTeamAssignments } = await getOrgCollections();
    const r = await healthCareTeamAssignments.updateMany({ orgId: toObjectId(orgId), email, breakGlass: true, expiresAt: { $gt: nowIso() } }, { $set: { expiresAt: nowIso(), endedByIdentity: true } });
    return { emergencyAccessEnded: r.modifiedCount };
  },
};

// ------------------------------------------------------------------------------------- verification
const VERIFY = {
  async FREEZE({ orgId, email }) {
    const { orgMembers } = await getOrgCollections();
    const active = await orgMembers.findOne({ orgId: toObjectId(orgId), email, status: "active" }); // the exact lookup getMembership() performs
    return active ? "The membership is still active." : null;
  },
  async SESSIONS({ email, result }) {
    if (result?.skipped) return null;
    const { sessions } = await getOrgCollections();
    return (await sessions.countDocuments({ email })) ? "Sessions still exist." : null;
  },
  async CREDENTIALS({ orgId, email }) {
    const { apiKeys } = await getOrgCollections(); const { db } = await getIdentityCollections();
    const a = await apiKeys.countDocuments({ orgId: toObjectId(orgId), createdByEmail: email, revokedAt: null });
    const b = await db.collection("s3_credentials").countDocuments({ ownerType: "org", ownerId: String(orgId), createdByEmail: email, revokedAt: null });
    return a || b ? "Credentials created by this person are still active." : null;
  },
  async PERMISSIONS({ orgId, email }) {
    const { orgMembers, projectMembers, documentPermissions } = await getOrgCollections(); const { identityGrants } = await getIdentityCollections();
    const oid = toObjectId(orgId);
    const m = await orgMembers.findOne({ orgId: oid, email });
    const left = m && ((m.departmentIds || []).length || ROLE_FIELDS.some((f) => (Array.isArray(m[f]) ? m[f].length : m[f])) || (m.role !== "member"));
    if (left) return "Roles or department scopes remain on the membership.";
    if (await projectMembers.countDocuments({ orgId: oid, email })) return "Project memberships remain.";
    if (await documentPermissions.countDocuments({ orgId: oid, email })) return "Explicit document permissions remain.";
    if (await identityGrants.countDocuments({ orgId: oid, email, status: { $in: ["ACTIVE", "PENDING_APPROVAL"] } })) return "Active grants remain in the ledger.";
    return null;
  },
  async SHARING({ orgId, email, result }) {
    if (result?.skipped) return null;
    const { documentShares } = await getOrgCollections();
    return (await documentShares.countDocuments({ orgId: toObjectId(orgId), createdByEmail: email, revokedAt: null })) ? "Share links created by this person are still active." : null;
  },
  async BREAK_GLASS({ orgId, email }) {
    const { healthCareTeamAssignments } = await getOrgCollections();
    return (await healthCareTeamAssignments.countDocuments({ orgId: toObjectId(orgId), email, breakGlass: true, expiresAt: { $gt: nowIso() } })) ? "Emergency access is still active." : null;
  },
};

const worst = (steps) => {
  const st = Object.values(steps);
  if (st.every((s) => s.status === "VERIFIED" || s.status === "SKIPPED")) return "REVOCATION_COMPLETE";
  if (steps.FREEZE?.status !== "VERIFIED") return "REVOCATION_FAILED";
  return "REVOCATION_PARTIAL";
};

/**
 * Revokes (or, with mode "restrict", contains) a person's access to one organization. Safe to call any number of times:
 * a revoked person stays revoked, a partial revocation resumes with only the steps that are not yet verified.
 * Returns { revocation } (state, per-step results, verification) or { error }.
 */
export async function revokeAccess({ orgId, email: rawEmail, trigger = "manual", reason = null, actor = "system", policy = {}, mode = "full", runId = null, correlationId = null, externalId = null }) {
  const email = normEmail(rawEmail);
  const { identityRevocations } = await getIdentityCollections();
  const { orgMembers } = await getOrgCollections();
  const oid = toObjectId(orgId);
  const m = await orgMembers.findOne({ orgId: oid, email });
  if (!m) return { revocation: { state: "REVOCATION_COMPLETE", noop: true, reason: "The person has no membership in this organization." } };

  if (m.role === "owner" && mode === "full") {
    const other = await orgMembers.countDocuments({ orgId: oid, role: "owner", status: "active", email: { $ne: email } });
    if (!other) return fail("This is the organization's only active owner. Revoking them would lock the organization out; add or promote another owner first.", 409, { reasonCode: "LAST_OWNER" });
  }

  const wanted = mode === "restrict" ? RESTRICT_STEPS : STEP_ORDER;
  let rev = await identityRevocations.findOne({ orgId: oid, email, mode, state: { $in: ["REVOCATION_PENDING", "REVOCATION_PARTIAL", "REVOCATION_FAILED"] } }, { sort: { createdAt: -1 } });
  const already = m.status === (mode === "restrict" ? "restricted" : "revoked");
  if (!rev) {
    if (already && m.identityFrozenAt) {
      const done = await identityRevocations.findOne({ orgId: oid, email, mode, state: "REVOCATION_COMPLETE" }, { sort: { createdAt: -1 } });
      if (done) return { revocation: { ...view(done), noop: true, reason: "Access was already revoked. Nothing further to do." } };
    }
    rev = { orgId: oid, email, mode, trigger, reason, actor, runId: runId ? String(runId) : null, correlationId, externalId, state: "REVOCATION_PENDING", steps: Object.fromEntries(wanted.map((s) => [s, { status: "PENDING" }])), before: { status: m.status, role: m.role, departmentIds: (m.departmentIds || []).map(String), roles: Object.fromEntries(ROLE_FIELDS.filter((f) => m[f]).map((f) => [f, m[f]])) }, attempts: 0, createdAt: nowIso() };
    rev._id = (await identityRevocations.insertOne(rev)).insertedId;
  }
  const ctx = { mode, trigger, reason, actor, policy: { sessionRevocation: "if_no_other_active_membership", revokeSharesCreatedByUser: true, ...policy } };
  rev.attempts = (rev.attempts || 0) + 1;

  for (const step of wanted) {
    const cur = rev.steps[step] || { status: "PENDING" };
    if (cur.status === "VERIFIED" || cur.status === "SKIPPED") continue;
    try {
      maybeFault(step);
      const result = await STEPS[step]({ orgId, email, ctx });
      const problem = await VERIFY[step]({ orgId, email, result });
      rev.steps[step] = problem ? { status: "FAILED", class: "PERMANENT", error: `Verification failed: ${problem}`, result } : { status: result?.skipped ? "SKIPPED" : "VERIFIED", result, verifiedAt: nowIso() };
    } catch (err) {
      rev.steps[step] = { status: "FAILED", class: classifyError(err), error: String(err.message).slice(0, 200) };
    }
  }
  rev.state = worst(rev.steps);
  rev.updatedAt = nowIso();
  if (rev.state === "REVOCATION_COMPLETE") rev.completedAt = nowIso();
  await identityRevocations.updateOne({ _id: rev._id }, { $set: { steps: rev.steps, state: rev.state, updatedAt: rev.updatedAt, completedAt: rev.completedAt || null, attempts: rev.attempts, trigger: rev.trigger, reason: rev.reason } });
  await emitIdentityEvent({ orgId, type: "access.revoked", subject: { email, externalId }, correlationId, data: { state: rev.state, mode, trigger, revocationId: String(rev._id), steps: Object.fromEntries(Object.entries(rev.steps).map(([k, v]) => [k, v.status])) } });
  return { revocation: view(rev) };
}

/** Re-runs only the steps that are not yet verified (manual retry or the worker). */
export async function retryRevocation({ orgId, email, policy = {}, actor = "system" }) {
  const { identityRevocations } = await getIdentityCollections();
  const rev = await identityRevocations.findOne({ orgId: toObjectId(orgId), email: normEmail(email), state: { $in: ["REVOCATION_PENDING", "REVOCATION_PARTIAL", "REVOCATION_FAILED"] } }, { sort: { createdAt: -1 } });
  if (!rev) return fail("There is no unfinished revocation for that person.", 404);
  return revokeAccess({ orgId, email, trigger: rev.trigger, reason: rev.reason, actor, policy, mode: rev.mode, runId: rev.runId });
}

export const view = (r) => ({ revocationId: String(r._id), email: r.email, mode: r.mode, state: r.state, trigger: r.trigger, reason: r.reason || null, steps: r.steps, attempts: r.attempts || 0, createdAt: r.createdAt, completedAt: r.completedAt || null, runId: r.runId || null, before: r.before });

export async function listRevocations({ orgId, state = null, limit = 50 }) {
  const { identityRevocations } = await getIdentityCollections();
  const q = { orgId: toObjectId(orgId) }; if (state) q.state = state;
  return { revocations: (await identityRevocations.find(q).sort({ createdAt: -1 }).limit(Math.min(200, limit)).toArray()).map(view) };
}
