// src/lib/identity/scim.js
//
// SOW §19 (SCIM if absent). A SCIM 2.0 SERVER so an identity provider that speaks SCIM (Entra provisioning, Okta, and so on) can push
// users and groups to Inaya without a custom webhook. Implemented from RFC 7643/7644 and covered by tests that speak the protocol; it has NOT
// been exercised by a real Entra or Okta provisioning job (label: PARTIAL, see docs).
//
// It is a front door, not a second engine: every write becomes a canonical lifecycle event and goes through processEvent(), so tenant
// binding, immutable-id identity resolution, ordering, mapping, approvals for privileged access, verified revocation, audit and evidence
// all apply exactly as for webhooks. Consequences worth stating:
//   * DELETE /Users/{id} DEACTIVATES (a leaver). Inaya never deletes a person's records because a directory said so.
//   * `active:false` is a leaver; `active:true` after a revocation is a RESTORE governed by the provider's restoreOnEnable policy.
//   * Groups are virtual: a group is the set of users carrying that group name; membership changes are user.group_changed events, and it is
//     the group->role mapping (not SCIM) that decides what a group means. A group can never carry a privileged role on its own.
//   * SCIM has no source timestamp, so events are ordered by arrival (the request clock). A disable still wins on a tie.
//   * Unsupported (reported honestly): bulk, sort, etag, password change, group rename.

import { randomBytes } from "node:crypto";
import { toObjectId } from "../orgs.js";
import { getIdentityCollections } from "./db.js";
import { normEmail } from "./common.js";
import { getProviderById } from "./providers.js";
import { processEvent } from "./engine.js";

const U = "urn:ietf:params:scim:schemas:core:2.0:User";
const G = "urn:ietf:params:scim:schemas:core:2.0:Group";
const ENT = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
const LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERR = "urn:ietf:params:scim:api:messages:2.0:Error";
const PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const MAX_COUNT = 100; const MAX_MEMBERS = 500;

const err = (status, detail, scimType) => ({ status, body: { schemas: [ERR], status: String(status), ...(scimType ? { scimType } : {}), detail } });
const gid = (name) => `g_${Buffer.from(name, "utf8").toString("base64url")}`;
const gname = (id) => { try { return Buffer.from(String(id).replace(/^g_/, ""), "base64url").toString("utf8"); } catch { return null; } };
const evId = () => `scim:${Date.now()}:${randomBytes(5).toString("hex")}`;

function userResource(ext, base) {
  const email = ext.email || ext.upn || null;
  return {
    schemas: [U, ENT], id: String(ext._id), externalId: ext.externalObjectId, userName: ext.upn || email || ext.externalObjectId,
    name: ext.displayName ? { formatted: ext.displayName } : undefined, displayName: ext.displayName || undefined,
    title: ext.jobTitle || undefined, active: ext.accountEnabled !== false && !["DISABLED", "REVOKED"].includes(ext.lifecycleState),
    emails: email ? [{ value: email, primary: true, type: "work" }] : [],
    groups: (ext.groups || []).map((n) => ({ value: gid(n), display: n })),
    [ENT]: { ...(ext.employeeId ? { employeeNumber: ext.employeeId } : {}), ...(ext.department ? { department: ext.department } : {}), ...(ext.managerExternalId ? { manager: { value: ext.managerExternalId } } : {}) },
    meta: { resourceType: "User", created: ext.createdAt, lastModified: ext.updatedAt || ext.createdAt, location: `${base}/Users/${ext._id}` },
  };
}

/** SCIM User body -> canonical subject fields (only the ones the body actually carries, so PUT/PATCH merge cleanly). */
function subjectFromScim(b, prev = {}) {
  const email = (b.emails || []).find((e) => e.primary)?.value || (b.emails || [])[0]?.value;
  const ent = b[ENT] || {};
  const s = { ...prev };
  if (b.userName) s.upn = String(b.userName);
  if (email) s.email = normEmail(email); else if (b.userName && String(b.userName).includes("@") && !prev.email) s.email = normEmail(b.userName);
  if (b.displayName || b.name?.formatted) s.displayName = b.displayName || b.name.formatted;
  else if (b.name?.givenName || b.name?.familyName) s.displayName = [b.name.givenName, b.name.familyName].filter(Boolean).join(" ");
  if (b.title !== undefined) s.jobTitle = b.title;
  if (ent.department !== undefined) s.department = ent.department;
  if (ent.employeeNumber !== undefined) s.employeeId = String(ent.employeeNumber);
  if (ent.manager?.value) s.managerExternalId = ent.manager.value;
  if (b.active !== undefined) s.accountEnabled = b.active === true || b.active === "true" || b.active === "True";
  return s;
}
const subjectFromExt = (ext) => ({ externalId: ext.externalObjectId, upn: ext.upn || undefined, email: ext.email || undefined, employeeId: ext.employeeId || undefined, displayName: ext.displayName || undefined, department: ext.department || undefined, jobTitle: ext.jobTitle || undefined, managerExternalId: ext.managerExternalId || undefined, groups: ext.groups || [], accountEnabled: ext.accountEnabled !== false && !["DISABLED", "REVOKED"].includes(ext.lifecycleState), employmentStatus: ext.employmentStatus || undefined, employeeType: ext.employeeType || undefined });

async function emit(provider, type, subject, actor) {
  return processEvent({ provider, event: { eventId: evId(), type, tenantId: provider.providerTenantId, occurredAt: new Date().toISOString(), time: Date.now(), sequence: null, version: 1, correlationId: null, subject }, actor, origin: "scim" });
}
const outcomeError = (r) => (r.status === "REJECTED" || r.status === "FAILED") ? err(r.status === "REJECTED" && r.reasonCode === "TENANT_MISMATCH" ? 403 : 409, r.reason || r.failure?.message || "The change could not be applied.", r.reasonCode === "IDENTITY_CONFLICT" ? "uniqueness" : undefined) : null;

// ---- filters: only the forms IdPs actually send. `attr eq "value"` (and `and` of them) ------------------------------------------------
function parseFilter(f) {
  if (!f) return { ok: true, conds: [] };
  const parts = String(f).split(/\s+and\s+/i); const conds = [];
  for (const p of parts) {
    const m = /^\s*([A-Za-z0-9_.:\[\]-]+)\s+eq\s+(?:"((?:[^"\\]|\\.)*)"|(true|false))\s*$/i.exec(p);
    if (!m) return { ok: false };
    conds.push({ attr: m[1].toLowerCase(), value: m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3].toLowerCase() === "true" });
  }
  return { ok: true, conds };
}
function condToQuery(c) {
  const rx = (v) => new RegExp(`^${String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  switch (c.attr) {
    case "username": return { upn: rx(c.value) };
    case "externalid": return { externalObjectId: String(c.value) };
    case "emails.value": case "emails[type eq \"work\"].value": return { email: normEmail(c.value) };
    case "displayname": return { displayName: rx(c.value) };
    case "active": return c.value ? { lifecycleState: "ACTIVE" } : { lifecycleState: { $in: ["DISABLED", "REVOKED"] } };
    case "id": try { return { _id: toObjectId(c.value) }; } catch { return { _id: null }; }
    default: return undefined;
  }
}

async function loadUser(provider, id) { let oid; try { oid = toObjectId(id); } catch { return null; } const { identityExternalUsers } = await getIdentityCollections(); return identityExternalUsers.findOne({ _id: oid, providerId: provider._id }); }

const SCHEMAS = [
  { id: U, name: "User", description: "User Account", attributes: ["userName", "externalId", "displayName", "title", "active", "emails", "groups"].map((n) => ({ name: n, type: n === "active" ? "boolean" : n === "emails" || n === "groups" ? "complex" : "string", multiValued: n === "emails" || n === "groups", required: n === "userName", mutability: n === "groups" ? "readOnly" : "readWrite" })) },
  { id: ENT, name: "EnterpriseUser", description: "Enterprise User", attributes: ["employeeNumber", "department", "manager"].map((n) => ({ name: n, type: n === "manager" ? "complex" : "string", multiValued: false, required: false, mutability: "readWrite" })) },
  { id: G, name: "Group", description: "Group (virtual: the users that carry this group name)", attributes: [{ name: "displayName", type: "string", multiValued: false, required: true, mutability: "readWrite" }, { name: "members", type: "complex", multiValued: true, required: false, mutability: "readWrite" }] },
];

/** ctx: { orgId, providerId, actor } from authenticateCredential (scope identity:scim). */
export async function handleScim({ method, path, query, body, ctx, base }) {
  if (!ctx.providerId) return err(403, "This credential is not bound to a SCIM provider.");
  const provider = await getProviderById(ctx.providerId);
  if (!provider || String(provider.orgId) !== String(ctx.orgId)) return err(403, "The provider is not part of this organization.");
  if (provider.kind !== "scim") return err(403, "The credential's provider is not a SCIM provider.");
  if (provider.status !== "ACTIVE") return err(403, "The provider is disabled.");
  const { identityExternalUsers } = await getIdentityCollections();
  const [res, id, extra] = path; const actor = ctx.actor;

  if (res === "ServiceProviderConfig") return { status: 200, body: { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"], patch: { supported: true }, bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 }, filter: { supported: true, maxResults: MAX_COUNT }, changePassword: { supported: false }, sort: { supported: false }, etag: { supported: false }, authenticationSchemes: [{ type: "oauthbearertoken", name: "Bearer token", description: "An Inaya identity service credential with the identity:scim scope" }] } };
  if (res === "ResourceTypes") return { status: 200, body: { schemas: [LIST], totalResults: 2, Resources: [{ schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "User", name: "User", endpoint: "/Users", schema: U, schemaExtensions: [{ schema: ENT, required: false }] }, { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "Group", name: "Group", endpoint: "/Groups", schema: G }] } };
  if (res === "Schemas") return { status: 200, body: { schemas: [LIST], totalResults: SCHEMAS.length, Resources: SCHEMAS } };

  // --------------------------------------------------------------------------------------------------------------------- Users
  if (res === "Users") {
    if (!id && method === "GET") {
      const f = parseFilter(query.get("filter")); if (!f.ok) return err(400, "Only `attribute eq value` filters (joined by `and`) are supported.", "invalidFilter");
      const q = { orgId: provider.orgId, providerId: provider._id };
      for (const c of f.conds) { const part = condToQuery(c); if (!part) return err(400, `Filtering on "${c.attr}" is not supported.`, "invalidFilter"); Object.assign(q, part); }
      const start = Math.max(1, parseInt(query.get("startIndex") || "1", 10) || 1); const count = Math.min(MAX_COUNT, Math.max(0, parseInt(query.get("count") || "50", 10) || 0));
      const total = await identityExternalUsers.countDocuments(q);
      const rows = count ? await identityExternalUsers.find(q).sort({ createdAt: 1, _id: 1 }).skip(start - 1).limit(count).toArray() : [];
      return { status: 200, body: { schemas: [LIST], totalResults: total, startIndex: start, itemsPerPage: rows.length, Resources: rows.map((r) => userResource(r, base)) } };
    }
    if (!id && method === "POST") {
      if (!body || typeof body !== "object") return err(400, "A JSON body is required.", "invalidSyntax");
      if (!body.userName) return err(400, "userName is required.", "invalidValue");
      const externalId = String(body.externalId || `scim:${String(body.userName).toLowerCase()}`).slice(0, 128);
      if (await identityExternalUsers.findOne({ providerId: provider._id, externalObjectId: externalId })) return err(409, "A user with that externalId already exists.", "uniqueness");
      const subject = { ...subjectFromScim(body), externalId }; if (subject.accountEnabled === undefined) subject.accountEnabled = true;
      const r = await emit(provider, subject.accountEnabled === false ? "user.disabled" : "user.created", subject, actor);
      const e = outcomeError(r); if (e) return e;
      const ext = await identityExternalUsers.findOne({ providerId: provider._id, externalObjectId: externalId });
      if (!ext) return err(409, r.reason || "The user could not be linked to an Inaya identity without ambiguity.", "uniqueness");
      return { status: 201, body: userResource(ext, base), headers: { Location: `${base}/Users/${ext._id}` } };
    }
    if (id && !extra) {
      const ext = await loadUser(provider, id); if (!ext) return err(404, "User not found.");
      if (method === "GET") return { status: 200, body: userResource(ext, base) };
      if (method === "PUT") {
        if (!body || typeof body !== "object") return err(400, "A JSON body is required.", "invalidSyntax");
        const s = { ...subjectFromScim(body, { ...subjectFromExt(ext), groups: ext.groups || [] }), externalId: ext.externalObjectId };
        const turnedOff = ext.accountEnabled !== false && s.accountEnabled === false; const turnedOn = (ext.accountEnabled === false || ["DISABLED", "REVOKED"].includes(ext.lifecycleState)) && s.accountEnabled === true;
        const r = await emit(provider, turnedOff ? "user.disabled" : turnedOn ? "user.enabled" : "user.updated", s, actor);
        const e = outcomeError(r); if (e) return e;
        return { status: 200, body: userResource(await loadUser(provider, id), base) };
      }
      if (method === "PATCH") {
        if (!body || !Array.isArray(body.Operations) || !body.schemas?.includes(PATCH_OP)) return err(400, "A SCIM PatchOp body with Operations is required.", "invalidSyntax");
        if (body.Operations.length > 50) return err(400, "Too many operations.", "tooMany");
        const patch = {};
        for (const op of body.Operations) {
          const verb = String(op.op || "").toLowerCase(); if (!["add", "replace", "remove"].includes(verb)) return err(400, `Unsupported operation "${op.op}".`, "invalidSyntax");
          const path = String(op.path || "").trim();
          if (!path) { if (verb === "remove" || typeof op.value !== "object") return err(400, "A value object is required when no path is given.", "invalidSyntax"); Object.assign(patch, op.value); continue; }
          const p = path.toLowerCase();
          if (verb === "remove") { if (p === "title") patch.title = ""; else if (p.startsWith("groups")) return err(400, "Group membership is changed through /Groups.", "mutability"); continue; }
          if (p === "active" || p === "username" || p === "displayname" || p === "title" || p === "externalid") { if (p === "externalid") return err(400, "externalId is immutable.", "mutability"); patch[p === "username" ? "userName" : p === "displayname" ? "displayName" : p] = op.value; }
          else if (p === "name.formatted") patch.displayName = op.value;
          else if (p.startsWith("emails")) patch.emails = Array.isArray(op.value) ? op.value : [{ value: op.value, primary: true }];
          else if (p.startsWith(ENT.toLowerCase())) { const attr = path.slice(ENT.length + 1); patch[ENT] = { ...(patch[ENT] || {}), [attr]: op.value }; }
          else if (p === "groups") return err(400, "Group membership is changed through /Groups.", "mutability");
          else return err(400, `Patching "${path}" is not supported.`, "invalidPath");
        }
        const s = { ...subjectFromScim(patch, { ...subjectFromExt(ext) }), externalId: ext.externalObjectId };
        const wasOn = ext.accountEnabled !== false && !["DISABLED", "REVOKED"].includes(ext.lifecycleState);
        const type = wasOn && s.accountEnabled === false ? "user.disabled" : !wasOn && s.accountEnabled === true ? "user.enabled" : "user.updated";
        const r = await emit(provider, type, s, actor);
        const e = outcomeError(r); if (e) return e;
        return { status: 200, body: userResource(await loadUser(provider, id), base) };
      }
      if (method === "DELETE") {
        // Deactivate, never delete: Inaya keeps the person's records, audit trail and evidence.
        const r = await emit(provider, "user.disabled", { ...subjectFromExt(ext), accountEnabled: false }, actor);
        const e = outcomeError(r); if (e) return e;
        return { status: 204, body: null };
      }
    }
    return err(405, "Method not allowed.");
  }

  // -------------------------------------------------------------------------------------------------------------------- Groups
  if (res === "Groups") {
    const groupNames = async () => (await identityExternalUsers.aggregate([{ $match: { orgId: provider.orgId, providerId: provider._id } }, { $unwind: "$groups" }, { $group: { _id: "$groups", n: { $sum: 1 } } }, { $sort: { _id: 1 } }]).toArray());
    const members = async (name) => identityExternalUsers.find({ orgId: provider.orgId, providerId: provider._id, groups: name }).limit(MAX_MEMBERS + 1).toArray();
    const groupResource = async (name) => { const m = await members(name); return { schemas: [G], id: gid(name), displayName: name, members: m.slice(0, MAX_MEMBERS).map((u) => ({ value: String(u._id), display: u.displayName || u.upn || u.email, $ref: `${base}/Users/${u._id}` })), meta: { resourceType: "Group", location: `${base}/Groups/${gid(name)}` } }; };
    const setMembership = async (name, addIds, removeIds) => {
      for (const [ids, add] of [[addIds, true], [removeIds, false]]) for (const uid of ids) {
        const u = await loadUser(provider, uid); if (!u) { if (add) return err(400, `Member ${uid} does not exist.`, "invalidValue"); continue; }
        const has = (u.groups || []).includes(name); if (add === has) continue;
        const groups = add ? [...(u.groups || []), name] : (u.groups || []).filter((g) => g !== name);
        const r = await emit(provider, "user.group_changed", { ...subjectFromExt(u), groups }, actor); const e = outcomeError(r); if (e) return e;
      }
      return null;
    };
    if (!id && method === "GET") {
      const f = parseFilter(query.get("filter")); if (!f.ok || f.conds.some((c) => c.attr !== "displayname")) return err(400, "Only `displayName eq \"value\"` is supported for groups.", "invalidFilter");
      let names = (await groupNames()).map((g) => g._id); if (f.conds[0]) names = names.filter((n) => n.toLowerCase() === String(f.conds[0].value).toLowerCase());
      const start = Math.max(1, parseInt(query.get("startIndex") || "1", 10) || 1); const count = Math.min(MAX_COUNT, Math.max(0, parseInt(query.get("count") || "50", 10) || 0));
      const page = names.slice(start - 1, start - 1 + count);
      return { status: 200, body: { schemas: [LIST], totalResults: names.length, startIndex: start, itemsPerPage: page.length, Resources: await Promise.all(page.map(groupResource)) } };
    }
    if (!id && method === "POST") {
      const name = String(body?.displayName || "").trim().slice(0, 200); if (!name) return err(400, "displayName is required.", "invalidValue");
      const ids = (body.members || []).map((m) => m.value).filter(Boolean); if (ids.length > MAX_MEMBERS) return err(400, `A group can be set with at most ${MAX_MEMBERS} members per request.`, "tooMany");
      const e = await setMembership(name, ids, []); if (e) return e;
      return { status: 201, body: await groupResource(name), headers: { Location: `${base}/Groups/${gid(name)}` } };
    }
    if (id && !extra) {
      const name = gname(id); if (!name) return err(404, "Group not found.");
      const current = await members(name);
      if (method === "GET") { if (!current.length) return err(404, "Group not found."); return { status: 200, body: await groupResource(name) }; }
      if (method === "PUT") {
        const want = new Set((body?.members || []).map((m) => m.value)); if (want.size > MAX_MEMBERS) return err(400, "Too many members.", "tooMany");
        if (body?.displayName && body.displayName !== name) return err(400, "Renaming a group is not supported.", "mutability");
        const e = await setMembership(name, [...want].filter((x) => !current.some((c) => String(c._id) === x)), current.filter((c) => !want.has(String(c._id))).map((c) => String(c._id))); if (e) return e;
        return { status: 200, body: await groupResource(name) };
      }
      if (method === "PATCH") {
        if (!Array.isArray(body?.Operations)) return err(400, "A SCIM PatchOp body with Operations is required.", "invalidSyntax");
        const add = []; const rem = [];
        for (const op of body.Operations) {
          const verb = String(op.op || "").toLowerCase(); const p = String(op.path || "members").toLowerCase();
          if (p.startsWith("members")) {
            if (verb === "remove") { const m = /value eq "([^"]+)"/i.exec(op.path || ""); if (m) rem.push(m[1]); else if (Array.isArray(op.value)) rem.push(...op.value.map((v) => v.value)); else rem.push(...current.map((c) => String(c._id))); }
            else if (verb === "add" || verb === "replace") { const vals = (Array.isArray(op.value) ? op.value : []).map((v) => v.value); if (verb === "replace") rem.push(...current.map((c) => String(c._id)).filter((x) => !vals.includes(x))); add.push(...vals); }
          } else if (p === "displayname") return err(400, "Renaming a group is not supported.", "mutability");
          else return err(400, `Patching "${op.path}" is not supported.`, "invalidPath");
        }
        if (add.length + rem.length > MAX_MEMBERS) return err(400, "Too many members in one request.", "tooMany");
        const e = await setMembership(name, add, rem); if (e) return e;
        return { status: 200, body: await groupResource(name) };
      }
      if (method === "DELETE") { const e = await setMembership(name, [], current.map((c) => String(c._id))); if (e) return e; return { status: 204, body: null }; }
    }
    return err(405, "Method not allowed.");
  }
  return err(404, "Unknown SCIM resource.");
}
