// src/lib/identity/overrides.js
//
// SOW §13, §21 (assignRole / removeRole / assignDepartment / removeDepartment / assignProject / removeProject):
// a person's (or an automation's) explicit, reasoned, optionally time-limited decision about someone's access. It is recorded in
// the grant ledger with source INAYA_MANUAL_OVERRIDE, so it survives directory changes and is shown as such.
//
//   * a reason is mandatory, an expiry is optional;
//   * "owner" can never be granted; a privileged grant (admin) requested by an AUTOMATION goes through Controlled Actions,
//     while the same grant made by a signed-in owner/admin is that person's own decision and applies at once;
//   * removing access retires the override / existing / temporary grants that match. Access that comes from the external
//     directory baseline is changed in the directory or in the mapping, not here (the response says so), because the next
//     directory event would put it back and pretend nothing happened.

import { toObjectId, getOrgCollections } from "../orgs.js";
import { getIdentityCollections } from "./db.js";
import { fail, nowIso, normEmail } from "./common.js";
import { validateGrant, isPrivilegedGrant } from "./providers.js";
import { addGrant, revokeGrants, listGrants, captureExisting, materialize, explainAccess } from "./grants.js";
import { proposePrivilegedGrant } from "./approvals.js";
import { recordRun } from "./runs.js";

const HEX24 = /^[0-9a-f]{24}$/i;

async function resolveValue(orgId, kind, value) {
  if (kind !== "department" && kind !== "project") return { value: String(value), label: null };
  const org = await getOrgCollections(); const oid = toObjectId(orgId);
  if (!HEX24.test(String(value))) return null;
  const doc = kind === "department" ? await org.departments.findOne({ _id: toObjectId(value), orgId: oid }) : await org.projects.findOne({ _id: toObjectId(value), orgId: oid });
  return doc ? { value: String(doc._id), label: doc.name } : null;
}

/** op: "add" | "remove". actorType: "human" (signed-in owner/admin) or "automation" (service credential). */
export async function applyOverride({ orgId, email: rawEmail, op, kind, value, reason, expiresAt = null, actor, actorType = "automation" }) {
  const email = normEmail(rawEmail);
  if (!["add", "remove"].includes(op)) return fail("op must be add or remove.");
  const errs = validateGrant({ kind, value }); if (errs.length) return fail(errs[0]);
  if (!reason || String(reason).trim().length < 3) return fail("A reason is required for a manual override.");
  if (expiresAt !== null && (Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) return fail("expiresAt must be a future date.");
  const { orgMembers } = await getOrgCollections();
  const m = await orgMembers.findOne({ orgId: toObjectId(orgId), email });
  if (!m) return fail("That person has no membership in this organization.", 404);
  if (m.status !== "active") return fail(`The membership is ${m.status}; restore it first.`, 409);
  if (m.role === "owner") return fail("An owner's access is managed by Inaya ownership rules, not by identity integration.", 409, { reasonCode: "OWNER_PROTECTED" });
  const rv = await resolveValue(orgId, kind, value);
  if (!rv) return fail(`${kind} "${value}" was not found in this organization.`, 404);
  await captureExisting({ orgId, membership: m });

  if (op === "remove") {
    const n = await revokeGrants({ orgId, email, filter: { kind, value: rv.value, source: { $in: ["INAYA_MANUAL_OVERRIDE", "INAYA_EXISTING", "TEMPORARY"] } }, reason: `removed by ${actor}: ${reason}` });
    const still = (await listGrants({ orgId, email })).filter((g) => g.kind === kind && g.value === rv.value);
    const mat = await materialize({ orgId, email });
    const run = await recordRun({ orgId, type: "MANUAL_GRANT", email, actor, plan: { ops: [{ op: "REMOVE_OVERRIDE", kind, value: rv.value }] }, result: { removed: n, remainingFromDirectory: still.map((g) => g.source) }, reasonNote: reason });
    return { removed: n, remainingFromDirectory: still.length ? still.map((g) => ({ source: g.source, note: "This access comes from the directory baseline. Change the group or mapping in the source system to remove it." })) : [], effective: mat.effective, runId: String(run._id) };
  }
  const priv = isPrivilegedGrant({ kind, value });
  const needsApproval = priv && actorType !== "human";
  const { grant, created } = await addGrant({ orgId, email, kind, value: rv.value, label: rv.label, source: "INAYA_MANUAL_OVERRIDE", reason, actor, expiresAt, status: needsApproval ? "PENDING_APPROVAL" : "ACTIVE" });
  let request = null;
  if (needsApproval && !grant.requestId) { const p = await proposePrivilegedGrant({ orgId, email, grant, runId: grant._id, providerId: null, actorLabel: actor }); if (p.error) return p; request = p.requestId; }
  const mat = needsApproval ? null : await materialize({ orgId, email });
  const run = await recordRun({ orgId, type: "MANUAL_GRANT", email, actor, state: needsApproval ? "AWAITING_APPROVAL" : "COMPLETED", plan: { ops: [{ op: needsApproval ? "PROPOSE_PRIVILEGED_GRANT" : "GRANT", kind, value: rv.value, label: rv.label }] }, result: { created, requestId: request }, reasonNote: reason });
  return { granted: !needsApproval, pendingApproval: needsApproval ? { requestId: request } : null, created, effective: mat?.effective || null, runId: String(run._id) };
}

export { explainAccess };
export const nowStamp = nowIso;
void getIdentityCollections;
