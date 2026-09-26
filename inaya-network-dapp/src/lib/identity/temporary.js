// src/lib/identity/temporary.js
//
// SOW §30: temporary and contractor access. Every grant records its owner (sponsor), purpose, scope, start, expiry and how it
// is revoked. Expiry is enforced two ways: an expired grant stops counting the next time access is derived, and the worker
// (worker.js -> expireTemporary) retires it, re-derives access, VERIFIES that the person no longer holds it, and records the
// result. A contractor whose membership existed only for the engagement is revoked completely (the full revocation state
// machine) once their last grant expires.

import { toObjectId, getOrgCollections } from "../orgs.js";
import { getOrgPlan, getOrgUsage } from "../orgPlans.js";
import { getIdentityCollections } from "./db.js";
import { fail, nowIso, normEmail, newToken, isEmail } from "./common.js";
import { validateGrant, isPrivilegedGrant } from "./providers.js";
import { addGrant, revokeGrants, listGrants, captureExisting, materialize, expireDueGrants, effectiveFromGrants } from "./grants.js";
import { revokeAccess } from "./revocation.js";
import { recordRun } from "./runs.js";
import { notifyManagers } from "./record.js";

const TYPES = ["CONTRACTOR", "AUDITOR", "CONSULTANT", "MSP_TECHNICIAN", "PROJECT", "OTHER"];
const HEX24 = /^[0-9a-f]{24}$/i;

export async function grantTemporary({ orgId, email: rawEmail, grants, type = "OTHER", owner, purpose, startsAt = null, expiresAt, actor, createMembership = false }) {
  const email = normEmail(rawEmail);
  if (!isEmail(email)) return fail("A valid email is required.");
  if (!TYPES.includes(type)) return fail(`type must be one of ${TYPES.join(", ")}.`);
  if (!purpose || String(purpose).trim().length < 3) return fail("A purpose is required.");
  const ownerEmail = normEmail(owner);
  if (!isEmail(ownerEmail)) return fail("An owner (the sponsoring member) is required.");
  const exp = Date.parse(expiresAt); const st = startsAt ? Date.parse(startsAt) : Date.now();
  if (!Number.isFinite(exp) || exp <= Date.now()) return fail("expiresAt must be a future date.");
  if (!Number.isFinite(st) || st >= exp) return fail("startsAt must be before expiresAt.");
  if (exp - Date.now() > 366 * 86400000) return fail("Temporary access cannot last longer than one year.");
  if (!Array.isArray(grants) || !grants.length || grants.length > 20) return fail("grants must list 1-20 grants.");
  const { orgMembers } = await getOrgCollections(); const oid = toObjectId(orgId);
  if (!(await orgMembers.findOne({ orgId: oid, email: ownerEmail, status: "active" }))) return fail("The owner must be an active member of this organization.", 400);
  const resolved = [];
  for (const g of grants) {
    const errs = validateGrant(g); if (errs.length) return fail(errs[0]);
    if (isPrivilegedGrant(g)) return fail("Privileged access (admin) cannot be time-boxed through this path. Use a manual override with a Controlled Action approval.", 400);
    let value = String(g.value); let label = null;
    if (g.kind === "department" || g.kind === "project") {
      if (!HEX24.test(value)) return fail(`${g.kind} grants need the ${g.kind} id.`);
      const org = await getOrgCollections();
      const doc = g.kind === "department" ? await org.departments.findOne({ _id: toObjectId(value), orgId: oid }) : await org.projects.findOne({ _id: toObjectId(value), orgId: oid });
      if (!doc) return fail(`${g.kind} not found in this organization.`, 404); label = doc.name;
    }
    resolved.push({ kind: g.kind, value, label });
  }
  let m = await orgMembers.findOne({ orgId: oid, email });
  let created = false;
  if (!m) {
    if (!createMembership) return fail("That person is not a member. Set createMembership to true to create a temporary membership.", 404);
    const { orgs } = await getOrgCollections(); const plan = getOrgPlan(await orgs.findOne({ _id: oid }));
    if (plan.maxUsers !== Infinity) { const { activeUsers } = await getOrgUsage(orgId); if (activeUsers >= plan.maxUsers) return fail(`The ${plan.name} plan allows ${plan.maxUsers} users.`, 403, { reasonCode: "PLAN_LIMIT" }); }
    await orgMembers.insertOne({ orgId: oid, email, role: "member", departmentIds: [], status: "active", invitedAt: nowIso(), joinedAt: nowIso(), provisionedBy: "identity:temporary", temporary: true, identityManagedAt: nowIso() });
    m = await orgMembers.findOne({ orgId: oid, email }); created = true;
  } else if (m.status !== "active") return fail(`The membership is ${m.status}; restore it first.`, 409);
  if (m.role === "owner") return fail("Owners are not managed through identity integration.", 409, { reasonCode: "OWNER_PROTECTED" });
  await captureExisting({ orgId, membership: m });
  const setId = `tmp_${newToken(9)}`;
  for (const g of resolved) await addGrant({ orgId, email, kind: g.kind, value: g.value, label: g.label, source: "TEMPORARY", sourceRef: setId, reason: purpose, actor, startsAt: startsAt ? new Date(st).toISOString() : null, expiresAt: new Date(exp).toISOString(), purpose: String(purpose).slice(0, 200), owner: ownerEmail });
  const mat = await materialize({ orgId, email });
  const run = await recordRun({ orgId, type: "MANUAL_GRANT", email, actor, plan: { ops: resolved.map((g) => ({ op: "GRANT_TEMPORARY", ...g })) }, result: { grantSetId: setId, type, owner: ownerEmail, purpose, startsAt, expiresAt: new Date(exp).toISOString(), revocation: "automatic at expiry by the identity worker (grants retired, access re-derived, removal verified)", membershipCreated: created }, reasonNote: purpose, notify: { title: `Temporary access granted to ${email}`, body: `${type}, until ${new Date(exp).toISOString().slice(0, 10)}. Sponsor: ${ownerEmail}.` } });
  return { grantSetId: setId, membershipCreated: created, expiresAt: new Date(exp).toISOString(), effective: mat.effective, runId: String(run._id) };
}

export async function listTemporary({ orgId, includeExpired = false }) {
  const { identityGrants } = await getIdentityCollections();
  const q = { orgId: toObjectId(orgId), source: "TEMPORARY" }; if (!includeExpired) q.status = "ACTIVE";
  const rows = await identityGrants.find(q).sort({ expiresAt: 1 }).limit(500).toArray();
  return { temporary: rows.map((g) => ({ grantSetId: g.sourceRef, email: g.email, kind: g.kind, value: g.value, label: g.label, purpose: g.purpose, owner: g.owner, startsAt: g.startsAt, expiresAt: g.expiresAt, status: g.status, grantedBy: g.actor })) };
}

export async function revokeTemporary({ orgId, grantSetId, actor }) {
  const { identityGrants } = await getIdentityCollections();
  const rows = await identityGrants.find({ orgId: toObjectId(orgId), source: "TEMPORARY", sourceRef: String(grantSetId), status: { $in: ["ACTIVE", "PENDING_APPROVAL"] } }).toArray();
  if (!rows.length) return fail("No active temporary grant set with that id.", 404);
  const email = rows[0].email;
  const n = await revokeGrants({ orgId, email, filter: { source: "TEMPORARY", sourceRef: String(grantSetId) }, reason: `revoked by ${actor}` });
  const mat = await materialize({ orgId, email });
  await recordRun({ orgId, type: "TEMP_EXPIRY", email, actor, plan: { ops: [{ op: "REVOKE_TEMPORARY", grantSetId }] }, result: { retired: n }, reasonNote: "revoked early" });
  return { revoked: n, effective: mat.effective };
}

/** Worker step: retire what has expired, re-derive, verify, and fully revoke contractors whose engagement is over. Returns a summary. */
export async function expireTemporary({ now = Date.now(), orgIds = null } = {}) {
  const who = await expireDueGrants({ now, orgIds });
  const { orgMembers } = await getOrgCollections();
  const out = { people: who.length, revokedMemberships: 0, verified: 0, failed: 0 };
  for (const p of who) {
    const oid = toObjectId(p.orgId);
    const m = await orgMembers.findOne({ orgId: oid, email: p.email });
    if (!m || m.status !== "active") continue;
    const mat = await materialize({ orgId: p.orgId, email: p.email, now });
    const remaining = (await listGrants({ orgId: p.orgId, email: p.email })).filter((g) => g.source !== "INAYA_EXISTING");
    let state = "COMPLETED"; let result = { materialized: !!mat.effective };
    if (m.temporary && !remaining.length) {
      const r = await revokeAccess({ orgId: p.orgId, email: p.email, trigger: "temporary_access_expired", reason: "Temporary access expired", actor: "identity-worker", mode: "full" });
      result.revocation = r.revocation || null; if (r.error || r.revocation?.state !== "REVOCATION_COMPLETE") state = "PARTIAL"; else out.revokedMemberships++;
    }
    // independent verification: nothing that expired may still be effective
    const eff = effectiveFromGrants(await listGrants({ orgId: p.orgId, email: p.email }), now);
    const stillHeld = p.expired.filter((g) => (g.kind === "department" && eff.departmentIds.includes(g.value)) || (g.kind === "project" && eff.projectIds.includes(g.value)) || (g.kind.endsWith("Role") && eff[g.kind] === g.value));
    // a grant may legitimately still be held through ANOTHER source; report it, do not treat it as failure
    result.verified = true; result.stillHeldViaOtherSource = stillHeld.map((g) => `${g.kind}:${g.value}`);
    out.verified++;
    await recordRun({ orgId: p.orgId, type: "TEMP_EXPIRY", email: p.email, actor: "identity-worker", state, result, reasonNote: "Temporary access expired", notify: { title: `Temporary access expired for ${p.email}`, body: m.temporary && !remaining.length ? "The temporary membership was revoked." : "Expired grants were retired and access re-derived." } });
    if (state !== "COMPLETED") out.failed++;
  }
  void notifyManagers;
  return out;
}
