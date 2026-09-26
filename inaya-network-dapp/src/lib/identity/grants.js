// src/lib/identity/grants.js
//
// SOW §13, §17, §30: "External baseline + Inaya local override = effective access."
//
// Every reason a person has access is a row in the grant LEDGER with a SOURCE (ENTRA / AD / HR / PSA / RMM / SCIM /
// GENERIC for the external baseline, INAYA_MANUAL_OVERRIDE for a person's decision, INAYA_EXISTING for access that
// was already there before the integration took over, TEMPORARY for time-boxed access). The effective access is DERIVED
// from the active rows and written to the existing membership fields (role, departmentIds, the *Role fields,
// project_members), which remain what Inaya's authorization reads on every request. So this is not a second RBAC:
// it only decides what those fields should contain and remembers why.
//
// Rules that matter:
//   * a mover loses only grants of ITS OWN source that the new state no longer justifies; manual overrides, existing
//     access and other sources are preserved;
//   * "owner" is never granted, changed or removed by the ledger;
//   * a grant can start in the future and expire; expired grants stop counting the next time access is derived.

import { ObjectId } from "mongodb";
import { toObjectId } from "../orgs.js";
import { getIdentityCollections } from "./db.js";
import { nowIso, normEmail, GRANT_KINDS, RANK, EXTERNAL_SOURCES, uniq } from "./common.js";
import { getOrgCollections } from "../orgs.js";

const ROLE_FIELDS = ["financeRole", "hrRole", "supportRole", "storageRole", "escrowRole", "complianceRole"];
export const SOURCE_LABEL = { ENTRA: "ENTRA", AD: "AD", HR: "HR", PSA: "PSA", RMM: "RMM", SCIM: "SCIM", GENERIC: "EXTERNAL", INAYA_MANUAL_OVERRIDE: "INAYA MANUAL OVERRIDE", INAYA_EXISTING: "INAYA (existing)", TEMPORARY: "TEMPORARY" };

const key = (g) => `${g.kind}:${g.value}`;

export async function addGrant({ orgId, email, kind, value, label = null, source, sourceRef = null, reason = null, actor = null, startsAt = null, expiresAt = null, status = "ACTIVE", requestId = null, purpose = null, owner = null }) {
  if (!GRANT_KINDS.includes(kind)) throw new Error(`Unknown grant kind ${kind}.`);
  const { identityGrants } = await getIdentityCollections();
  const q = { orgId: toObjectId(orgId), email: normEmail(email), kind, value: String(value), source, sourceRef: sourceRef ? String(sourceRef) : null, status: { $in: ["ACTIVE", "PENDING_APPROVAL"] } };
  const now = nowIso();
  const existing = await identityGrants.findOne(q);
  if (existing) {
    if (existing.status === "PENDING_APPROVAL" && status === "ACTIVE") await identityGrants.updateOne({ _id: existing._id }, { $set: { status: "ACTIVE", activatedAt: now } });
    if (expiresAt !== undefined && expiresAt !== existing.expiresAt) await identityGrants.updateOne({ _id: existing._id }, { $set: { expiresAt } });
    return { grant: { ...existing, status: status === "ACTIVE" ? "ACTIVE" : existing.status }, created: false };
  }
  const doc = { ...q, status, label, reason, actor, createdAt: now, startsAt, expiresAt, revokedAt: null, requestId, purpose, owner };
  doc._id = (await identityGrants.insertOne(doc)).insertedId;
  return { grant: doc, created: true };
}

export async function revokeGrants({ orgId, email, filter = {}, reason = "revoked", status = "REVOKED" }) {
  const { identityGrants } = await getIdentityCollections();
  const r = await identityGrants.updateMany({ orgId: toObjectId(orgId), email: normEmail(email), status: { $in: ["ACTIVE", "PENDING_APPROVAL"] }, ...filter }, { $set: { status, revokedAt: nowIso(), revokedReason: reason } });
  return r.modifiedCount;
}

export async function listGrants({ orgId, email, statuses = ["ACTIVE", "PENDING_APPROVAL"] }) {
  const { identityGrants } = await getIdentityCollections();
  return identityGrants.find({ orgId: toObjectId(orgId), email: normEmail(email), status: { $in: statuses } }).sort({ createdAt: 1 }).toArray();
}

/** Which of a person's grants count right now. */
export const isEffective = (g, now = Date.now()) => g.status === "ACTIVE" && (!g.startsAt || Date.parse(g.startsAt) <= now) && (!g.expiresAt || Date.parse(g.expiresAt) > now);

/** Pure: grants -> the field values they justify. */
export function effectiveFromGrants(grants, now = Date.now()) {
  const eff = grants.filter((g) => isEffective(g, now));
  const out = { role: eff.some((g) => g.kind === "role" && g.value === "admin") ? "admin" : "member", departmentIds: uniq(eff.filter((g) => g.kind === "department").map((g) => g.value)), projectIds: uniq(eff.filter((g) => g.kind === "project").map((g) => g.value)) };
  for (const f of ROLE_FIELDS) {
    const vals = eff.filter((g) => g.kind === f).map((g) => g.value);
    out[f] = vals.length ? vals.sort((a, b) => (RANK[b] || 0) - (RANK[a] || 0))[0] : null;
  }
  return out;
}

/** Ledger diff for one source+ref: what to add and what to retire so the ACTIVE set equals `desired`. */
export function diffGrants(current, desired) {
  const cur = new Map(current.map((g) => [key(g), g])); const want = new Map(desired.map((g) => [key(g), g]));
  return { add: desired.filter((g) => !cur.has(key(g))), remove: current.filter((g) => !want.has(key(g))), keep: current.filter((g) => want.has(key(g))) };
}

/**
 * The first time the integration manages a member, what they ALREADY have becomes INAYA_EXISTING grants so deriving access
 * from the ledger can never silently remove it. Returns the number of grants captured.
 */
export async function captureExisting({ orgId, membership }) {
  if (!membership || membership.identityManagedAt) return 0;
  const { orgMembers, projectMembers } = await getOrgCollections();
  let n = 0;
  const add = async (kind, value, label) => { const r = await addGrant({ orgId, email: membership.email, kind, value, label, source: "INAYA_EXISTING", reason: "Present before identity integration", actor: "system" }); if (r.created) n++; };
  if (membership.role === "admin") await add("role", "admin");
  for (const d of membership.departmentIds || []) await add("department", String(d));
  for (const f of ROLE_FIELDS) if (membership[f]) await add(f, membership[f]);
  const projects = await projectMembers.find({ orgId: toObjectId(orgId), email: normEmail(membership.email) }).toArray();
  for (const p of projects) if (!p.identityManaged) await add("project", String(p.projectId));
  await orgMembers.updateOne({ _id: membership._id }, { $set: { identityManagedAt: nowIso() } });
  return n;
}

/**
 * Derives access from the ledger and writes it to the membership (and project_members). Idempotent. Owners are never touched.
 * Returns { changed, effective } or { skipped }.
 */
export async function materialize({ orgId, email, now = Date.now() }) {
  const { orgMembers, projectMembers } = await getOrgCollections();
  const oid = toObjectId(orgId); const e = normEmail(email);
  const m = await orgMembers.findOne({ orgId: oid, email: e });
  if (!m) return { skipped: "no_membership" };
  if (m.role === "owner") return { skipped: "owner" };
  const grants = await listGrants({ orgId, email: e });
  const eff = effectiveFromGrants(grants, now);
  const set = { role: eff.role, departmentIds: eff.departmentIds.map((d) => new ObjectId(d)), identityManagedAt: m.identityManagedAt || nowIso(), identityMaterializedAt: nowIso() };
  const unset = {};
  for (const f of ROLE_FIELDS) { if (eff[f]) set[f] = eff[f]; else unset[f] = ""; }
  const upd = { $set: set }; if (Object.keys(unset).length) upd.$unset = unset;
  await orgMembers.updateOne({ _id: m._id }, upd);
  // projects: add missing rows; remove only rows this integration created
  const want = new Set(eff.projectIds);
  for (const pid of want) await projectMembers.updateOne({ orgId: oid, projectId: new ObjectId(pid), email: e }, { $setOnInsert: { orgId: oid, projectId: new ObjectId(pid), email: e, addedAt: nowIso(), addedByEmail: "identity-integration", identityManaged: true } }, { upsert: true });
  const rows = await projectMembers.find({ orgId: oid, email: e, identityManaged: true }).toArray();
  for (const r of rows) if (!want.has(String(r.projectId))) await projectMembers.deleteOne({ _id: r._id });
  return { changed: true, effective: eff };
}

/** Grants whose time is up: marks them EXPIRED and returns the affected people. */
export async function expireDueGrants({ now = Date.now(), orgIds = null, limit = 500 } = {}) {
  const { identityGrants } = await getIdentityCollections();
  const q = { status: "ACTIVE", expiresAt: { $ne: null, $lte: new Date(now).toISOString() } };
  if (orgIds) q.orgId = { $in: orgIds.map((o) => toObjectId(o)) };
  const due = await identityGrants.find(q).limit(limit).toArray();
  const who = new Map();
  for (const g of due) {
    const r = await identityGrants.updateOne({ _id: g._id, status: "ACTIVE" }, { $set: { status: "EXPIRED", revokedAt: nowIso(), revokedReason: "expired" } });
    if (r.modifiedCount) { const k = `${g.orgId}:${g.email}`; if (!who.has(k)) who.set(k, { orgId: String(g.orgId), email: g.email, temporary: !!g.purpose, expired: [] }); who.get(k).expired.push({ kind: g.kind, value: g.value }); }
  }
  return [...who.values()];
}

export async function explainAccess({ orgId, email }) {
  const grants = await listGrants({ orgId, email, statuses: ["ACTIVE", "PENDING_APPROVAL", "EXPIRED", "REVOKED"] });
  const now = Date.now();
  const { orgMembers } = await getOrgCollections();
  const m = await orgMembers.findOne({ orgId: toObjectId(orgId), email: normEmail(email) });
  return {
    email: normEmail(email), membershipStatus: m?.status || null, role: m?.role || null,
    effective: effectiveFromGrants(grants, now),
    grants: grants.map((g) => ({ id: String(g._id), kind: g.kind, value: g.value, label: g.label || null, source: g.source, sourceLabel: SOURCE_LABEL[g.source] || g.source, sourceRef: g.sourceRef, status: isEffective(g, now) || g.status !== "ACTIVE" ? g.status : "SCHEDULED", reason: g.reason, actor: g.actor, since: g.createdAt, startsAt: g.startsAt || null, until: g.expiresAt || null, purpose: g.purpose || null, revokedAt: g.revokedAt || null })),
    externalSources: EXTERNAL_SOURCES,
  };
}
