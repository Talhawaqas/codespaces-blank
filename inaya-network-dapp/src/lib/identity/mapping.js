// src/lib/identity/mapping.js
//
// SOW §7, §17, §18: how an external identity is recognised, and which Inaya access it justifies.
//
// IDENTITY RESOLUTION, in this order (email is only ever a controlled fallback, never the primary identity):
//   1. provider tenant + immutable object id          (identity_external_users, unique per provider)
//   2. employee id, when the provider declares it authoritative and it identifies exactly one record
//   3. email, only when policy.emailLinking is "exact_unique" and exactly one existing membership has that email and
//      no other external identity already claims it
// Anything ambiguous or conflicting FAILS CLOSED: no grant, no revoke, a finding for an administrator.
//
// POLICIES are explicit, versioned mappings: an external GROUP or ATTRIBUTE -> Inaya grants. "owner" can never be a grant;
// "admin" (and any mapping marked privileged) is applied only through Controlled Actions (see approvals.js).

import { emitIdentityEvent } from "./outbound.js";
import { audit } from "./record.js";
import { ObjectId } from "mongodb";
import { toObjectId, getOrgCollections } from "../orgs.js";
import { getIdentityCollections, ensureIdentityIndexes } from "./db.js";
import { fail, nowIso, normEmail, lower, GRANT_KINDS } from "./common.js";
import { validateGrant, isPrivilegedGrant } from "./providers.js";

const oidOf = (id) => { try { return new ObjectId(String(id)); } catch { return null; } };
const HEX24 = /^[0-9a-f]{24}$/i;
const ATTRS = ["department", "jobTitle", "employeeType", "employmentStatus", "location", "businessUnit", "costCenter", "managerExternalId"];
const OPS = ["equals", "contains", "startsWith", "in"];

// ------------------------------------------------------------------------------------- policy CRUD
function validateMapping(b) {
  const errors = [];
  const m = b?.match;
  if (!m || !["group", "attribute"].includes(m.type)) errors.push("match.type must be group or attribute.");
  else if (m.type === "group") { if (typeof m.value !== "string" || !m.value.trim() || m.value.length > 200) errors.push("match.value (the external group name or id) is required."); }
  else {
    if (!ATTRS.includes(m.attribute)) errors.push(`match.attribute must be one of ${ATTRS.join(", ")}.`);
    if (!OPS.includes(m.op || "equals")) errors.push(`match.op must be one of ${OPS.join(", ")}.`);
    if (m.op === "in") { if (!Array.isArray(m.values) || !m.values.length || m.values.length > 50) errors.push("match.values must list 1-50 values for op \"in\"."); }
    else if (typeof m.value !== "string" || !m.value.trim()) errors.push("match.value is required.");
  }
  if (!Array.isArray(b?.grants) || !b.grants.length || b.grants.length > 20) errors.push("grants must list 1-20 grants.");
  else for (const g of b.grants) {
    errors.push(...validateGrant(g));
    if ((g.kind === "department" || g.kind === "project") && !(HEX24.test(g.value) || new RegExp(`^${g.kind === "department" ? "dept" : "project"}:.+`).test(g.value))) errors.push(`${g.kind} grant value must be an id or "${g.kind === "department" ? "dept" : "project"}:<name>".`);
  }
  return errors;
}

export async function createMapping({ orgId, providerId = null, body, actorEmail }) {
  await ensureIdentityIndexes();
  const errors = validateMapping(body);
  if (errors.length) return fail(errors[0], 400, { errors });
  const { identityMappings } = await getIdentityCollections();
  const grants = body.grants.map((g) => ({ kind: g.kind, value: String(g.value).trim(), privileged: isPrivilegedGrant(g) }));
  const doc = { orgId: toObjectId(orgId), providerId: providerId ? oidOf(providerId) : null, name: String(body.name || `${body.match.type}: ${body.match.value ?? body.match.attribute}`).slice(0, 100), description: String(body.description || "").slice(0, 300), match: { ...body.match, value: body.match.value !== undefined ? String(body.match.value).trim() : undefined, op: body.match.type === "attribute" ? body.match.op || "equals" : undefined }, grants, privileged: grants.some((g) => g.privileged), active: true, version: 1, history: [], createdBy: actorEmail, createdAt: nowIso(), updatedAt: nowIso(), expiresAt: body.expiresAt || null };
  doc._id = (await identityMappings.insertOne(doc)).insertedId;
  await audit({ orgId, action: "IDENTITY_MAPPING_CREATED", actorEmail, metadata: { mappingId: String(doc._id), name: doc.name, privileged: !!doc.privileged } });
  await emitIdentityEvent({ orgId, type: "organization.mapping_changed", data: { change: "created", mappingId: String(doc._id), name: doc.name } });
  return { mapping: mview(doc) };
}

export async function updateMapping({ orgId, mappingId, patch, actorEmail }) {
  const id = oidOf(mappingId); if (!id) return fail("Mapping not found.", 404);
  const { identityMappings } = await getIdentityCollections();
  const cur = await identityMappings.findOne({ _id: id, orgId: toObjectId(orgId) });
  if (!cur) return fail("Mapping not found.", 404);
  const next = { name: patch.name ?? cur.name, description: patch.description ?? cur.description, match: patch.match ?? cur.match, grants: patch.grants ?? cur.grants };
  const errors = validateMapping(next);
  if (errors.length) return fail(errors[0], 400, { errors });
  const grants = next.grants.map((g) => ({ kind: g.kind, value: String(g.value).trim(), privileged: isPrivilegedGrant(g) }));
  await identityMappings.updateOne({ _id: id }, { $set: { name: String(next.name).slice(0, 100), description: String(next.description || "").slice(0, 300), match: next.match, grants, privileged: grants.some((g) => g.privileged), active: patch.active ?? cur.active, expiresAt: patch.expiresAt !== undefined ? patch.expiresAt : cur.expiresAt, updatedAt: nowIso(), version: cur.version + 1 }, $push: { history: { $each: [{ version: cur.version, match: cur.match, grants: cur.grants, active: cur.active, by: actorEmail, at: nowIso() }], $slice: -50 } } });
  await audit({ orgId, action: "IDENTITY_MAPPING_UPDATED", actorEmail, metadata: { mappingId: String(id) } });
  await emitIdentityEvent({ orgId, type: "organization.mapping_changed", data: { change: "updated", mappingId: String(id) } });
  return { mapping: mview(await identityMappings.findOne({ _id: id })) };
}

export async function listMappings({ orgId, providerId = null }) {
  const { identityMappings } = await getIdentityCollections();
  const q = { orgId: toObjectId(orgId) }; if (providerId) q.$or = [{ providerId: oidOf(providerId) }, { providerId: null }];
  return { mappings: (await identityMappings.find(q).sort({ createdAt: 1 }).toArray()).map(mview) };
}
export async function deleteMapping({ orgId, mappingId, actor = "system" }) {
  const id = oidOf(mappingId); if (!id) return fail("Mapping not found.", 404);
  const { identityMappings } = await getIdentityCollections();
  const r = await identityMappings.updateOne({ _id: id, orgId: toObjectId(orgId) }, { $set: { active: false, updatedAt: nowIso() } });
  if (r.matchedCount) { await audit({ orgId, action: "IDENTITY_MAPPING_DEACTIVATED", actorEmail: actor, metadata: { mappingId: String(id) } }); await emitIdentityEvent({ orgId, type: "organization.mapping_changed", data: { change: "deactivated", mappingId: String(id) } }); }
  return r.matchedCount ? { deactivated: true } : fail("Mapping not found.", 404);
}
const mview = (m) => ({ mappingId: String(m._id), providerId: m.providerId ? String(m.providerId) : null, name: m.name, description: m.description, match: m.match, grants: m.grants, privileged: !!m.privileged, active: m.active !== false, version: m.version, createdBy: m.createdBy, createdAt: m.createdAt, updatedAt: m.updatedAt, expiresAt: m.expiresAt || null, history: (m.history || []).map((h) => ({ version: h.version, by: h.by, at: h.at })) });

// -------------------------------------------------------------------------------------- evaluation
function attrValue(subject, attr) { return attr in subject ? subject[attr] : subject.attributes?.[attr]; }
export function mappingMatches(m, subject) {
  if (m.active === false) return false;
  if (m.expiresAt && Date.parse(m.expiresAt) <= Date.now()) return false;
  const x = m.match;
  if (x.type === "group") return (subject.groups || []).some((g) => lower(g) === lower(x.value));
  const v = lower(attrValue(subject, x.attribute)); if (!v) return false;
  if (x.op === "in") return (x.values || []).some((y) => lower(y) === v);
  if (x.op === "contains") return v.includes(lower(x.value));
  if (x.op === "startsWith") return v.startsWith(lower(x.value));
  return v === lower(x.value);
}

async function resolveNamed(orgId, kind, value) {
  const org = await getOrgCollections(); const oid = toObjectId(orgId);
  if (HEX24.test(value)) {
    const doc = kind === "department" ? await org.departments.findOne({ _id: new ObjectId(value), orgId: oid }) : await org.projects.findOne({ _id: new ObjectId(value), orgId: oid });
    return doc ? { id: String(doc._id), label: doc.name } : null;
  }
  const name = value.replace(/^(dept|project):/, "");
  const rx = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  const docs = kind === "department" ? await org.departments.find({ orgId: oid, name: rx, isSystem: { $ne: true } }).limit(2).toArray() : await org.projects.find({ orgId: oid, name: rx }).limit(2).toArray();
  return docs.length === 1 ? { id: String(docs[0]._id), label: docs[0].name } : null; // zero or several: unresolved, never guessed
}

/**
 * What access this external subject justifies. Returns { grants: [{kind,value,label,mappingId,privileged}], unresolved: [...], matched: [mappingId] }.
 * Grants that name a department/project are resolved to ids; a name that matches none (or several) is reported, never guessed or created.
 */
export async function evaluateDesired({ orgId, provider, subject }) {
  const { identityMappings } = await getIdentityCollections();
  const maps = await identityMappings.find({ orgId: toObjectId(orgId), active: { $ne: false }, $or: [{ providerId: provider._id }, { providerId: null }] }).toArray();
  const raw = []; const matched = [];
  for (const g of provider.policy.defaultGrants || []) raw.push({ ...g, mappingId: "default" });
  // a subject that is disabled justifies nothing
  if (subject.accountEnabled === false || ["TERMINATED", "DISABLED", "INACTIVE"].includes(subject.employmentStatus)) return { grants: [], unresolved: [], matched: [], disabled: true };
  for (const m of maps) if (mappingMatches(m, subject)) { matched.push(String(m._id)); for (const g of m.grants) raw.push({ ...g, mappingId: String(m._id) }); }
  const grants = []; const unresolved = [];
  for (const g of raw) {
    if (g.kind === "department" || g.kind === "project") {
      const r = await resolveNamed(orgId, g.kind, g.value);
      if (!r) { unresolved.push({ kind: g.kind, value: g.value, reason: "No single matching " + g.kind + "." }); continue; }
      grants.push({ kind: g.kind, value: r.id, label: r.label, mappingId: g.mappingId, privileged: !!g.privileged });
    } else grants.push({ kind: g.kind, value: g.value, label: null, mappingId: g.mappingId, privileged: isPrivilegedGrant(g) });
  }
  const seen = new Set(); const dedup = grants.filter((g) => { const k = `${g.kind}:${g.value}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { grants: dedup, unresolved, matched };
}

// -------------------------------------------------------------------------------- identity resolution
/**
 * Finds who an external subject is. Returns one of:
 *   { status: "LINKED", ext }                         known by immutable id
 *   { status: "LINKABLE", membership, via }           not yet known; exactly one membership can be linked (employee id / email)
 *   { status: "NEW" }                                 nobody matches: a joiner
 *   { status: "AMBIGUOUS" | "CONFLICT", reason }      fail closed
 */
export async function resolveIdentity({ provider, subject }) {
  const { identityExternalUsers } = await getIdentityCollections();
  const { orgMembers } = await getOrgCollections();
  const oid = provider.orgId;
  const byId = await identityExternalUsers.findOne({ providerId: provider._id, externalObjectId: subject.externalId });
  if (byId) return { status: "LINKED", ext: byId, via: "external_id" };

  if (provider.policy.employeeIdAuthoritative && subject.employeeId) {
    const rows = await identityExternalUsers.find({ orgId: oid, providerId: provider._id, employeeId: subject.employeeId }).limit(2).toArray();
    if (rows.length > 1) return { status: "AMBIGUOUS", reason: "Several external identities share this employee id." };
    if (rows.length === 1) return { status: "CONFLICT", reason: "This employee id already belongs to a different external object id (a directory migration or rehire needs an administrator to relink it).", other: rows[0] };
  }
  const email = normEmail(subject.email || subject.upn);
  if (provider.policy.emailLinking === "exact_unique" && email) {
    const claimed = await identityExternalUsers.find({ orgId: oid, inayaEmail: email }).limit(2).toArray();
    if (claimed.length) return { status: "CONFLICT", reason: "Another external identity is already linked to this email address.", other: claimed[0] };
    const members = await orgMembers.find({ orgId: oid, email }).limit(2).toArray();
    if (members.length === 1) return { status: "LINKABLE", membership: members[0], via: "email" };
    if (members.length > 1) return { status: "AMBIGUOUS", reason: "More than one membership matches this email." };
  }
  return { status: "NEW" };
}
