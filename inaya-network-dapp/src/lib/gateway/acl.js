// src/lib/gateway/acl.js
//
// Network folders and the NTFS/AD permission bridge (Competitive Expansion SOW workstream N, NETFOLDER-001).
//
// The gateway reads the access control list of each APPROVED FOLDER on the customer's own system (NTFS ACL through the operating system, POSIX mode bits
// on Linux/macOS) and the directory identities it can see (user and group principals, with group memberships). It sends those snapshots to Inaya. Inaya:
//   * maps directory principals to Inaya members (exact UPN/e-mail match automatically; anything fuzzier is only a SUGGESTION until an administrator confirms);
//   * evaluates what a member may do with NTFS semantics: explicit deny, then explicit allow, then inherited deny, then inherited allow, per right, and no match
//     means no access. A deny is never overridden by an allow of equal or lower precedence ("preserve deny semantics");
//   * refuses to list or serve a folder to a member whose effective permission lacks read, EVEN IF that member is an owner or admin (administrators manage the
//     connector through a separate, audited inventory view; they do not get a back door around the customer's ACL);
//   * keeps a mapping-health view and records every permission change it sees.
//
// HONEST LIMITS (also shown in the product): permissions are evaluated at the approved-folder level, not per file; Inaya sees only what the gateway reports and
// cannot see access that happens on the customer's own network, so traceability is limited to access made through Inaya (the record says so).

import { toObjectId } from "../orgs.js";
import { createHash } from "node:crypto";
import { gwCols, GatewayError, canManageGateways, statusOf, relativePath } from "./gateway.js";
import { logOrgActivity } from "../org-activity-log.js";
import { ObjectId } from "mongodb";

const fail = (status, message, extra) => { throw new GatewayError(status, message, extra); };
const nowIso = () => new Date().toISOString();
const lc = (v) => String(v ?? "").trim().toLowerCase();
export const RIGHTS = ["read", "write", "delete"];
const WELL_KNOWN = new Set(["everyone", "nt authority\\authenticated users", "authenticated users", "users", "builtin\\users"]);
export const isWellKnown = (p) => WELL_KNOWN.has(lc(p));

const EXPAND = { full: RIGHTS, modify: RIGHTS, write: ["write"], change: ["write"], read: ["read"], list: ["read"], readonly: ["read"], delete: ["delete"], execute: [], traverse: [] };
const rightsOf = (list) => [...new Set((Array.isArray(list) ? list : []).flatMap((r) => EXPAND[lc(r)] || []))];

/** Pure. entries: [{ principal, type: "allow"|"deny", rights: [...], inherited?: boolean }]; principals: Set of lowercased names that apply to the person. */
export function evaluateAccess({ entries, principals, known = true }) {
  const out = { read: false, write: false, delete: false, reasons: {} };
  const applies = (e) => principals.has(lc(e.principal)) || (known && isWellKnown(e.principal));
  const order = (e) => (e.type === "deny" ? (e.inherited ? 2 : 0) : e.inherited ? 3 : 1);
  const mine = (entries || []).filter(applies).sort((a, b) => order(a) - order(b));
  for (const right of RIGHTS) {
    for (const e of mine) {
      if (!rightsOf(e.rights).includes(right)) continue;
      out[right] = e.type !== "deny"; out.reasons[right] = { decision: e.type === "deny" ? "deny" : "allow", by: e.principal, inherited: !!e.inherited }; break;
    }
    if (!out.reasons[right]) out.reasons[right] = { decision: "none", by: null, inherited: false };
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ snapshots and identities (from the gateway)
const normEntry = (e) => ({ principal: String(e?.principal || "").slice(0, 200), type: e?.type === "deny" ? "deny" : "allow", rights: rightsOf(e?.rights), inherited: !!e?.inherited });
const hashOf = (entries) => createHash("sha256").update(JSON.stringify(entries.map((e) => [lc(e.principal), e.type, [...e.rights].sort(), e.inherited]).sort())).digest("hex");

export async function recordAcl({ gateway, folderId, entries, principals = [], source = "ntfs", takenAt = null, failures = 0 }) {
  const c = await gwCols();
  const k = await c.connectors.findOne({ orgId: gateway.orgId, gatewayId: gateway._id, "folders.folderId": String(folderId) }); if (!k) fail(403, "That folder is not approved for this gateway.");
  if (!Array.isArray(entries) || entries.length > 500) fail(400, "entries must be a list of at most 500.");
  const list = entries.map(normEntry).filter((e) => e.principal); const hash = hashOf(list); const prev = await c.acl.findOne({ gatewayId: gateway._id, folderId: String(folderId) });
  const changed = !prev || prev.hash !== hash;
  await c.acl.updateOne({ gatewayId: gateway._id, folderId: String(folderId) }, { $set: { orgId: gateway.orgId, connectorId: k._id, entries: list, hash, source: ["ntfs", "posix", "smb", "other"].includes(source) ? source : "other", takenAt: takenAt ? new Date(takenAt).toISOString() : nowIso(), receivedAt: nowIso() } }, { upsert: true });
  if (changed && prev) {
    const before = new Set(prev.entries.map((e) => `${lc(e.principal)}|${e.type}|${[...e.rights].sort().join(",")}`)); const after = new Set(list.map((e) => `${lc(e.principal)}|${e.type}|${[...e.rights].sort().join(",")}`));
    const added = [...after].filter((x) => !before.has(x)).length, removed = [...before].filter((x) => !after.has(x)).length;
    await c.aclEvents.insertOne({ orgId: gateway.orgId, gatewayId: gateway._id, folderId: String(folderId), at: nowIso(), kind: "ACL_CHANGED", added, removed });
    logOrgActivity({ orgId: gateway.orgId, recordType: "GATEWAY", recordId: gateway._id, actorEmail: "gateway:" + String(gateway._id), action: "PERMISSIONS_CHANGED", previousState: null, newState: null, metadata: { folderId: String(folderId), added, removed } }).catch(() => {});
  }
  const { orgMembers } = await import("../orgs.js").then((m) => m.getOrgCollections());
  let auto = 0;
  for (const p of (Array.isArray(principals) ? principals : []).slice(0, 2000)) {
    const principal = lc(p?.principal); if (!principal) continue;
    const doc = { orgId: gateway.orgId, gatewayId: gateway._id, principal, kind: p.kind === "group" ? "group" : "user", upn: p.upn ? lc(p.upn) : null, memberOf: (Array.isArray(p.memberOf) ? p.memberOf : []).slice(0, 200).map(lc), updatedAt: nowIso() };
    await c.principals.updateOne({ gatewayId: gateway._id, principal }, { $set: doc }, { upsert: true });
    if (doc.kind === "user" && doc.upn && !(await c.idmap.findOne({ orgId: gateway.orgId, principal }))) {
      const m = await orgMembers.findOne({ orgId: gateway.orgId, email: doc.upn, status: "active" }, { projection: { email: 1 } });
      if (m) { await c.idmap.updateOne({ orgId: gateway.orgId, principal }, { $setOnInsert: { orgId: gateway.orgId, principal, email: m.email, source: "auto", createdAt: nowIso() } }, { upsert: true }); auto++; }
    }
  }
  return { changed, autoMapped: auto };
}

// ------------------------------------------------------------------------------------------------ identity mapping (administrators)
export async function setMapping({ orgId, membership, actorEmail, principal, email }) {
  if (!canManageGateways(membership)) fail(403, "Only an administrator can change identity mappings.");
  const c = await gwCols(); const p = lc(principal); if (!p) fail(400, "principal is required.");
  if (email === null || email === undefined || email === "") { await c.idmap.deleteOne({ orgId: toObjectId(orgId), principal: p }); await logOrgActivity({ orgId, recordType: "GATEWAY", recordId: new ObjectId(), actorEmail, action: "MAPPING_REMOVED", previousState: null, newState: null, metadata: { principal: p } }).catch(() => {}); return { removed: true }; }
  const { orgMembers } = await import("../orgs.js").then((m) => m.getOrgCollections()); const e = lc(email);
  if (!(await orgMembers.findOne({ orgId: toObjectId(orgId), email: e, status: "active" }))) fail(404, "That person is not an active member of this organization.");
  await c.idmap.updateOne({ orgId: toObjectId(orgId), principal: p }, { $set: { email: e, source: "manual", createdAt: nowIso(), by: actorEmail } }, { upsert: true });
  await logOrgActivity({ orgId, recordType: "GATEWAY", recordId: new ObjectId(), actorEmail, action: "MAPPING_SET", previousState: null, newState: null, metadata: { principal: p, email: e } }).catch(() => {});
  return { principal: p, email: e, source: "manual" };
}

/** Everything the person is, as far as the customer's directory is concerned: mapped accounts plus every group those accounts belong to (transitively). */
export async function principalsFor({ orgId, email }) {
  const c = await gwCols(); const mapped = (await c.idmap.find({ orgId: toObjectId(orgId), email: lc(email) }).toArray()).map((m) => m.principal);
  const set = new Set(mapped); if (!set.size) return { principals: set, known: false };
  const docs = await c.principals.find({ orgId: toObjectId(orgId) }).project({ principal: 1, memberOf: 1 }).toArray(); const groupsOf = new Map(docs.map((d) => [d.principal, d.memberOf || []]));
  const queue = [...mapped]; while (queue.length) { const cur = queue.pop(); for (const g of groupsOf.get(cur) || []) if (!set.has(g)) { set.add(g); queue.push(g); } }
  return { principals: set, known: true };
}

// ------------------------------------------------------------------------------------------------ enforced access
async function locateFolder({ orgId, folderId }) {
  const c = await gwCols(); const k = await c.connectors.findOne({ orgId: toObjectId(orgId), "folders.folderId": String(folderId) }); if (!k) fail(404, "Folder not found.");
  const g = await c.gateways.findOne({ _id: k.gatewayId, orgId: toObjectId(orgId) }); if (!g || g.status !== "active") fail(409, "The gateway for this folder is not active.", { code: "GATEWAY_INACTIVE" });
  return { c, k, g, folder: k.folders.find((f) => f.folderId === String(folderId)) };
}
export async function effectiveAccess({ orgId, folderId, email }) {
  const { c, g, folder } = await locateFolder({ orgId, folderId }); const snap = await c.acl.findOne({ gatewayId: g._id, folderId: String(folderId) });
  const me = await principalsFor({ orgId, email });
  if (!snap) return { read: false, write: false, delete: false, reasons: {}, why: "NO_ACL_SNAPSHOT", folder: { folderId: folder.folderId, label: folder.label }, snapshotAt: null };
  if (!me.known) return { read: false, write: false, delete: false, reasons: {}, why: "NOT_MAPPED", folder: { folderId: folder.folderId, label: folder.label }, snapshotAt: snap.takenAt };
  const r = evaluateAccess({ entries: snap.entries, principals: me.principals, known: true });
  return { ...r, why: r.read ? "ALLOWED" : "NO_READ_PERMISSION", folder: { folderId: folder.folderId, label: folder.label }, snapshotAt: snap.takenAt, source: snap.source, mappedAs: [...me.principals].slice(0, 20) };
}

const denied = (orgId, folderId, email, why) => logOrgActivity({ orgId, recordType: "GATEWAY", recordId: new ObjectId(), actorEmail: email, action: "ACCESS_DENIED", previousState: null, newState: null, metadata: { folderId: String(folderId), why } }).catch(() => {});
export async function browseFolder({ orgId, folderId, email, prefix = "", limit = 200 }) {
  const eff = await effectiveAccess({ orgId, folderId, email });
  if (!eff.read) { await denied(orgId, folderId, email, eff.why); fail(403, eff.why === "NOT_MAPPED" ? "Your account is not mapped to a directory identity for this folder." : eff.why === "NO_ACL_SNAPSHOT" ? "Permissions for this folder have not been read yet, so access is refused." : "Your permissions on the customer's system do not allow reading this folder.", { code: eff.why }); }
  const { c, k } = await locateFolder({ orgId, folderId }); const q = { orgId: toObjectId(orgId), connectorId: k._id, folderId: String(folderId) };
  const pre = prefix ? relativePath(prefix) : null; if (prefix && !pre) fail(400, "prefix is not valid."); if (pre) q.path = { $regex: `^${pre.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|$)` };
  const rows = await c.inventory.find(q).sort({ path: 1 }).limit(Math.min(Number(limit) || 200, 500)).toArray();
  logOrgActivity({ orgId, recordType: "GATEWAY", recordId: k._id, actorEmail: email, action: "FOLDER_BROWSED", previousState: null, newState: null, metadata: { folderId: String(folderId), count: rows.length } }).catch(() => {});
  return { effective: { read: eff.read, write: eff.write, delete: eff.delete }, traceability: "Access made through Inaya is recorded here. Access made directly on the customer's network is not visible to Inaya.", items: rows.map((r) => ({ path: r.path, name: r.name, size: r.size, mtime: r.mtime, isDir: r.isDir, classification: r.classification })) };
}
/** Folders the person may read, across active gateways. Others are simply absent. */
export async function visibleFolders({ orgId, email }) {
  const c = await gwCols(); const gs = await c.gateways.find({ orgId: toObjectId(orgId), status: "active" }).toArray(); const out = [];
  for (const g of gs) for (const k of await c.connectors.find({ orgId: g.orgId, gatewayId: g._id, enabled: { $ne: false } }).toArray()) for (const f of k.folders || []) {
    const e = await effectiveAccess({ orgId, folderId: f.folderId, email }).catch(() => null);
    if (e?.read) out.push({ folderId: f.folderId, label: f.label, connector: k.name, gateway: g.label, gatewayStatus: statusOf(g), write: e.write, snapshotAt: e.snapshotAt });
  }
  return { folders: out };
}

// ------------------------------------------------------------------------------------------------ administrator views: permissions, health, conflicts
export async function folderPermissions({ orgId, membership, folderId, email = null }) {
  if (!canManageGateways(membership, { read: true })) fail(403, "Only an administrator or auditor can read folder permissions.");
  const { c, g, folder } = await locateFolder({ orgId, folderId }); const snap = await c.acl.findOne({ gatewayId: g._id, folderId: String(folderId) });
  const idmap = await c.idmap.find({ orgId: toObjectId(orgId) }).toArray(); const byPrincipal = new Map(idmap.map((m) => [m.principal, m])); const groups = await groupSet(c, orgId);
  const diag = diagnose(snap, byPrincipal, Date.now(), groups);
  const effective = email ? await effectiveAccess({ orgId, folderId, email }) : null;
  return { folder: { folderId: folder.folderId, label: folder.label }, snapshotAt: snap?.takenAt || null, source: snap?.source || null, entries: (snap?.entries || []).map((e) => ({ ...e, mappedTo: byPrincipal.get(lc(e.principal))?.email || null, wellKnown: isWellKnown(e.principal) })), diagnostics: diag, effective };
}
export function diagnose(snap, byPrincipal, now = Date.now(), groups = new Set()) {
  const out = []; if (!snap) return [{ code: "NO_SNAPSHOT", level: "warning", detail: "Permissions for this folder have not been read yet." }];
  if (now - new Date(snap.takenAt).getTime() > 24 * 3600_000) out.push({ code: "STALE_SNAPSHOT", level: "warning", detail: "The permission snapshot is more than 24 hours old." });
  const seen = new Map();
  for (const e of snap.entries) {
    const key = `${lc(e.principal)}|${e.inherited ? "i" : "e"}`; const prior = seen.get(key) || { allow: new Set(), deny: new Set() }; for (const r of e.rights) prior[e.type].add(r); seen.set(key, prior);
    if (!isWellKnown(e.principal) && !byPrincipal.has(lc(e.principal)) && !groups.has(lc(e.principal))) out.push({ code: "UNMAPPED_PRINCIPAL", level: "info", principal: e.principal, detail: `${e.principal} is not mapped to an Inaya member, so it gives no one access through Inaya.` });
  }
  for (const [key, v] of seen) { const both = [...v.allow].filter((r) => v.deny.has(r)); if (both.length) out.push({ code: "ALLOW_DENY_CONFLICT", level: "warning", principal: key.split("|")[0], detail: `${key.split("|")[0]} is both allowed and denied ${both.join(", ")} at the same level. The deny wins.` }); }
  return [...new Map(out.map((d) => [`${d.code}|${d.principal || ""}|${d.detail}`, d])).values()];
}

/** Directory groups the gateway has reported. A group is not mapped to one person: it applies through its members. */
async function groupSet(c, orgId) { return new Set((await c.principals.find({ orgId: toObjectId(orgId), kind: "group" }).project({ principal: 1 }).toArray()).map((p) => p.principal)); }
export async function mappingHealth({ orgId, membership }) {
  if (!canManageGateways(membership, { read: true })) fail(403, "Only an administrator or auditor can read mapping health.");
  const c = await gwCols(); const oid = toObjectId(orgId); const idmap = await c.idmap.find({ orgId: oid }).toArray(); const byP = new Map(idmap.map((m) => [m.principal, m]));
  const groups = await groupSet(c, orgId); const snaps = await c.acl.find({ orgId: oid }).toArray(); const gateways = await c.gateways.find({ orgId: oid, status: "active" }).toArray();
  const principals = new Set(); let stale = 0; const conflicts = []; for (const s of snaps) { for (const e of s.entries) if (!isWellKnown(e.principal)) principals.add(lc(e.principal)); const d = diagnose(s, byP, Date.now(), groups); if (d.some((x) => x.code === "STALE_SNAPSHOT")) stale++; for (const x of d) if (x.code === "ALLOW_DENY_CONFLICT") conflicts.push({ folderId: s.folderId, principal: x.principal }); }
  const groupsSeen = [...principals].filter((p) => groups.has(p) && !byP.has(p)); const userPrincipals = [...principals].filter((p) => !groups.has(p) || byP.has(p)); const unmapped = userPrincipals.filter((p) => !byP.has(p)); const { orgMembers } = await import("../orgs.js").then((m) => m.getOrgCollections());
  const nonMembers = []; for (const m of idmap) if (!(await orgMembers.findOne({ orgId: oid, email: m.email, status: "active" }))) nonMembers.push(m.principal);
  const failures = gateways.reduce((n, g) => n + (g.health?.aclFailures || 0), 0); const recentChanges = await c.aclEvents.countDocuments({ orgId: oid, at: { $gt: new Date(Date.now() - 7 * 86400_000).toISOString() } });
  const state = !snaps.length ? "NO_DATA" : unmapped.length || nonMembers.length || conflicts.length || stale || failures ? "ATTENTION" : "OK";
  return { state, folders: snaps.length, principals: userPrincipals.length, groups: groupsSeen.length, mapped: userPrincipals.length - unmapped.length, unmapped: unmapped.slice(0, 50), mappedToNonMembers: nonMembers.slice(0, 50), conflicts: conflicts.slice(0, 50), staleSnapshots: stale, permissionSyncFailures: failures, permissionChanges7d: recentChanges, suggestions: await suggest({ c, oid, unmapped }) };
}
async function suggest({ c, oid, unmapped }) {
  if (!unmapped.length) return []; const { orgMembers } = await import("../orgs.js").then((m) => m.getOrgCollections()); const members = await orgMembers.find({ orgId: oid, status: "active" }).project({ email: 1 }).toArray(); const out = [];
  for (const p of unmapped.slice(0, 50)) { const account = p.includes("\\") ? p.split("\\").pop() : p.split("@")[0]; const m = members.filter((x) => lc(x.email).split("@")[0] === account); if (m.length === 1) out.push({ principal: p, email: m[0].email, basis: "account name matches the start of the e-mail address", confirmed: false }); }
  return out;
}
export async function listMappings({ orgId, membership }) {
  if (!canManageGateways(membership, { read: true })) fail(403, "Only an administrator or auditor can read identity mappings.");
  const c = await gwCols(); return { mappings: (await c.idmap.find({ orgId: toObjectId(orgId) }).sort({ principal: 1 }).limit(500).toArray()).map((m) => ({ principal: m.principal, email: m.email, source: m.source, createdAt: m.createdAt })) };
}
export async function permissionChanges({ orgId, membership, limit = 50 }) {
  if (!canManageGateways(membership, { read: true })) fail(403, "Only an administrator or auditor can read permission changes.");
  const c = await gwCols(); return { changes: (await c.aclEvents.find({ orgId: toObjectId(orgId) }).sort({ at: -1 }).limit(Math.min(Number(limit) || 50, 200)).toArray()).map((e) => ({ folderId: e.folderId, at: e.at, kind: e.kind, added: e.added, removed: e.removed })) };
}
