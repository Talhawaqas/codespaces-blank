// src/lib/governance/policies.js
//
// Governance policy model (Competitive Expansion SOW D4, GOV-002). One collection, `governance_policies`, one row per VERSION.
//   draft -> (pending_approval ->) published -> retired. A published version is IMMUTABLE: every write below filters on the status it allows,
//   so there is no code path that edits a published row. Changing a policy means creating a new draft version from it, which supersedes the
//   old one on publish. Publishing can require a second person (approvalRequired): the approver must differ from the submitter.
// Every transition is written to the org audit chain (recordType GOV_POLICY). Enforcement lives with the callers (dlp.js, uploads.js, shares).

import { ObjectId } from "mongodb";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { canManageOrg } from "../orgGates.js";
import { logOrgActivity } from "../org-activity-log.js";
import { isValidCidr } from "../net/cidr.js";
import { safePattern } from "./classifyRules.js";

export class GovError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); } }
const fail = (status, message, extra) => { throw new GovError(status, message, extra); };
const nowIso = () => new Date().toISOString();
const arr = (v) => (Array.isArray(v) ? v : []);
const strs = (v, max = 200) => arr(v).map((x) => String(x).trim()).filter(Boolean).slice(0, max);

export const DLP_DECISIONS = ["ALLOW", "DENY", "REQUIRE_APPROVAL", "REQUIRE_STRONGER_AUTH", "LOG_ONLY", "QUARANTINE"];
export const DLP_ACTIONS = ["upload", "download", "preview", "share_create", "share_open", "share_download", "delete", "external_share", "api_access", "export"];

const need = (cond, msg, e) => { if (!cond) e.push(msg); };
const num = (v, lo, hi) => Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi;
const cidrs = (list, label, e) => { for (const c of arr(list)) need(isValidCidr(c), `${label}: "${c}" is not a valid IP or CIDR.`, e); };

/** type -> { label, validate(config, errors) }. A type with no enforcement point yet still validates and stores, so the policy set is complete. */
export const POLICY_TYPES = {
  dlp: { label: "Data loss prevention", validate: (c, e) => {
    need(Array.isArray(c.rules) && c.rules.length >= 1 && c.rules.length <= 100, "A DLP policy needs 1 to 100 rules.", e);
    for (const [i, r] of arr(c.rules).entries()) {
      need(DLP_DECISIONS.includes(r.action), `Rule ${i + 1}: action must be one of ${DLP_DECISIONS.join(", ")}.`, e);
      need(r.when && typeof r.when === "object", `Rule ${i + 1}: "when" is required.`, e);
      cidrs(r.when?.ipIn, `Rule ${i + 1} ipIn`, e); cidrs(r.when?.ipNotIn, `Rule ${i + 1} ipNotIn`, e);
      for (const a of arr(r.when?.actions)) need(DLP_ACTIONS.includes(a), `Rule ${i + 1}: unknown action "${a}".`, e);
    }
  } },
  external_sharing: { label: "External sharing", validate: (c, e) => { need(typeof c.allowed === "boolean", "allowed (true/false) is required.", e); if (c.maxExpiryHours != null) need(num(c.maxExpiryHours, 1, 8760), "maxExpiryHours must be 1 to 8760.", e); } },
  public_links: { label: "Public links", validate: (c, e) => { need(typeof c.allowed === "boolean", "allowed (true/false) is required.", e); if (c.maxExpiryHours != null) need(num(c.maxExpiryHours, 1, 8760), "maxExpiryHours must be 1 to 8760.", e); } },
  download_limits: { label: "Download limits", validate: (c, e) => { for (const k of ["maxPerShare", "maxPerUserPerDay"]) if (c[k] != null) need(num(c[k], 1, 1_000_000), `${k} must be 1 to 1000000.`, e); } },
  upload_types: { label: "Upload restrictions", validate: (c, e) => {
    if (c.maxBytes != null) need(num(c.maxBytes, 1, 5 * 1024 ** 3), "maxBytes must be 1 byte to 5 GiB.", e);
    if (c.maxFilesPerHour != null) need(num(c.maxFilesPerHour, 1, 100_000), "maxFilesPerHour must be 1 to 100000.", e);
    for (const k of ["denyExtensions", "allowExtensions"]) if (c[k] != null) need(Array.isArray(c[k]) && c[k].every((x) => /^.?[a-z0-9]{1,12}$/i.test(String(x))), `${k} must be a list of file extensions.`, e);
    if (c.requireScan != null) need(["none", "static", "engine_required"].includes(c.requireScan), "requireScan must be none, static or engine_required.", e);
    for (const h of arr(c.blockedSha256)) need(/^[0-9a-f]{64}$/i.test(h), `"${h}" is not a SHA-256 hex digest.`, e);
    for (const k of ["maxArchiveDepth", "maxArchiveEntries"]) if (c[k] != null) need(num(c[k], 1, 100_000), `${k} is out of range.`, e);
    if (c.maxArchiveRatio != null) need(num(c.maxArchiveRatio, 2, 10_000), "maxArchiveRatio must be 2 to 10000.", e);
  } },
  classification: { label: "Classification rules", validate: (c, e) => {
    need(Array.isArray(c.rules) && c.rules.length >= 1 && c.rules.length <= 200, "A classification policy needs 1 to 200 rules.", e);
    for (const [i, r] of arr(c.rules).entries()) {
      need(typeof r.id === "string" && /^[a-z0-9_-]{1,40}$/i.test(r.id), `Rule ${i + 1}: id is required (letters, digits, - or _).`, e);
      need(typeof r.level === "string" && r.level.length > 0, `Rule ${i + 1}: level is required.`, e);
      need(r.apply === undefined || ["suggest", "apply"].includes(r.apply), `Rule ${i + 1}: apply must be suggest or apply.`, e);
      need(r.confidence === undefined || num(r.confidence, 0, 1), `Rule ${i + 1}: confidence must be 0 to 1.`, e);
      const w = r.when || {}; need(Object.keys(w).length > 0, `Rule ${i + 1}: "when" needs at least one condition.`, e);
      for (const src of [...arr(w.contentPatterns), ...(w.filenameRegex ? [w.filenameRegex] : [])]) need(safePattern(src), `Rule ${i + 1}: "${String(src).slice(0, 40)}" is not an allowed pattern (too long, invalid, or could run away).`, e);
    }
  } },
  classification_required: { label: "Classification required", validate: (c, e) => { need(typeof c.required === "boolean", "required (true/false) is required.", e); } },
  retention: { label: "Retention", validate: (c, e) => { need(num(c.days, 1, 36500), "days must be 1 to 36500.", e); need(["archive", "delete", "review"].includes(c.afterAction), "afterAction must be archive, delete or review.", e); } },
  archival: { label: "Archival", validate: (c, e) => { need(num(c.afterDaysInactive, 1, 36500), "afterDaysInactive must be 1 to 36500.", e); } },
  deletion: { label: "Deletion", validate: (c, e) => { need(typeof c.requireApproval === "boolean", "requireApproval (true/false) is required.", e); if (c.trashDays != null) need(num(c.trashDays, 0, 3650), "trashDays must be 0 to 3650.", e); } },
  legal_hold: { label: "Legal hold", validate: (c, e) => { need(typeof c.blockDeletion === "boolean", "blockDeletion (true/false) is required.", e); } },
  device_access: { label: "Device access", validate: (c, e) => { need(typeof c.requireTrustedDevice === "boolean", "requireTrustedDevice (true/false) is required.", e); } },
  versioning: { label: "File versioning", validate: (c, e) => { need(num(c.keepVersions, 1, 10_000), "keepVersions must be 1 to 10000.", e); } },
  file_locking: { label: "File locking", validate: (c, e) => { need(num(c.maxLeaseMinutes, 1, 480), "maxLeaseMinutes must be 1 to 480.", e); } },
  residency: { label: "Region / residency", validate: (c, e) => { need(strs(c.allowedRegions).length >= 1, "allowedRegions needs at least one region.", e); } },
  external_domain: { label: "External domains", validate: (c, e) => { need(strs(c.allowedDomains).length + strs(c.blockedDomains).length >= 1, "List allowedDomains and/or blockedDomains.", e); } },
  guest_restrictions: { label: "Guest users", validate: (c, e) => { need(typeof c.allowGuests === "boolean", "allowGuests (true/false) is required.", e); } },
};

let indexed = false;
async function col() {
  const c = await getOrgCollections();
  const policies = c.db.collection("governance_policies");
  if (!indexed) { await Promise.all([policies.createIndex({ orgId: 1, policyKey: 1, version: 1 }, { unique: true }), policies.createIndex({ orgId: 1, type: 1, status: 1, precedence: 1 })]); indexed = true; }
  return policies;
}
const audit = (orgId, p, actor, action, metadata = {}) => logOrgActivity({ orgId, recordType: "GOV_POLICY", recordId: p._id, actorEmail: actor, action, previousState: null, newState: null, metadata: { type: p.type, policyKey: p.policyKey, version: p.version, ...metadata } }).catch(() => {});
const view = (p) => p && ({ policyId: String(p._id), policyKey: p.policyKey, version: p.version, status: p.status, type: p.type, name: p.name, description: p.description, scope: p.scope, precedence: p.precedence, priority: p.priority, effectiveAt: p.effectiveAt, expiresAt: p.expiresAt, approvalRequired: p.approvalRequired, config: p.config, createdBy: p.createdBy, createdAt: p.createdAt, submittedBy: p.submittedBy || null, publishedBy: p.publishedBy || null, publishedAt: p.publishedAt || null, approvedBy: p.approvedBy || null, retiredAt: p.retiredAt || null, note: p.note || null });

function clean(input, type) {
  const spec = POLICY_TYPES[type]; if (!spec) fail(400, `Unknown policy type "${type}".`);
  const config = input.config && typeof input.config === "object" ? input.config : {};
  const errors = []; spec.validate(config, errors); if (errors.length) fail(400, errors[0], { errors });
  const eff = input.effectiveAt ? new Date(input.effectiveAt) : null; const exp = input.expiresAt ? new Date(input.expiresAt) : null;
  if ((eff && isNaN(eff)) || (exp && isNaN(exp))) fail(400, "effectiveAt/expiresAt must be valid dates.");
  if (eff && exp && exp <= eff) fail(400, "expiresAt must be after effectiveAt.");
  const sc = input.scope || {};
  return {
    type, name: String(input.name || spec.label).trim().slice(0, 120), description: String(input.description || "").slice(0, 500),
    scope: { departmentIds: strs(sc.departmentIds, 50), pathPrefix: sc.pathPrefix ? String(sc.pathPrefix).slice(0, 300) : null, roles: strs(sc.roles, 20), emails: strs(sc.emails, 100).map((x) => x.toLowerCase()), groupIds: strs(sc.groupIds, 50) },
    precedence: Number.isInteger(input.precedence) ? Math.min(Math.max(input.precedence, 0), 10_000) : 100, priority: Number.isInteger(input.priority) ? Math.min(Math.max(input.priority, 0), 10_000) : 100,
    effectiveAt: eff ? eff.toISOString() : null, expiresAt: exp ? exp.toISOString() : null, approvalRequired: !!input.approvalRequired, config,
  };
}
const mustManage = (m) => { if (!canManageOrg(m)) fail(403, "Only an owner or admin can manage governance policies."); };
const id = (v) => { if (!/^[0-9a-f]{24}$/.test(String(v))) fail(404, "Policy not found."); return new ObjectId(v); };

export async function createPolicy({ orgId, actorEmail, membership, ...input }) {
  mustManage(membership); const policies = await col(); const body = clean(input, input.type);
  const doc = { _id: new ObjectId(), orgId: toObjectId(orgId), policyKey: new ObjectId().toHexString(), version: 1, status: "draft", ...body, createdBy: actorEmail, createdAt: nowIso() };
  await policies.insertOne(doc); await audit(orgId, doc, actorEmail, "CREATED"); return view(doc);
}
/** Only a DRAFT can be edited. Published and retired versions are never modified. */
export async function updateDraft({ orgId, policyId, actorEmail, membership, ...input }) {
  mustManage(membership); const policies = await col(); const cur = await policies.findOne({ _id: id(policyId), orgId: toObjectId(orgId) });
  if (!cur) fail(404, "Policy not found."); if (cur.status !== "draft") fail(409, "A published policy cannot be edited. Create a new version instead.");
  const body = clean({ ...cur, ...input, scope: input.scope ?? cur.scope, config: input.config ?? cur.config }, cur.type); delete body.type;
  const r = await policies.findOneAndUpdate({ _id: cur._id, status: "draft" }, { $set: { ...body, updatedAt: nowIso() } }, { returnDocument: "after" });
  const out = r?.value ?? r; if (!out) fail(409, "The policy changed. Reload."); await audit(orgId, out, actorEmail, "EDITED"); return view(out);
}
async function doPublish(policies, cur, orgId, actorEmail, approvedBy = null) {
  const at = nowIso();
  await policies.updateMany({ orgId: cur.orgId, policyKey: cur.policyKey, status: "published", version: { $lt: cur.version } }, { $set: { status: "retired", retiredAt: at, note: `Superseded by version ${cur.version}` } });
  const r = await policies.findOneAndUpdate({ _id: cur._id, status: { $in: ["draft", "pending_approval"] } }, { $set: { status: "published", publishedAt: at, publishedBy: actorEmail, ...(approvedBy ? { approvedBy } : {}) } }, { returnDocument: "after" });
  const out = r?.value ?? r; if (!out) fail(409, "The policy changed. Reload.");
  await audit(orgId, out, actorEmail, "PUBLISHED", approvedBy ? { approvedBy } : {}); return view(out);
}
export async function publishPolicy({ orgId, policyId, actorEmail, membership }) {
  mustManage(membership); const policies = await col(); const cur = await policies.findOne({ _id: id(policyId), orgId: toObjectId(orgId) });
  if (!cur) fail(404, "Policy not found."); if (cur.status !== "draft") fail(409, "Only a draft can be published.");
  if (cur.approvalRequired) {
    const r = await policies.findOneAndUpdate({ _id: cur._id, status: "draft" }, { $set: { status: "pending_approval", submittedBy: actorEmail, submittedAt: nowIso() } }, { returnDocument: "after" });
    const out = r?.value ?? r; await audit(orgId, out, actorEmail, "SUBMITTED"); return view(out);
  }
  return doPublish(policies, cur, orgId, actorEmail);
}
export async function decideApproval({ orgId, policyId, actorEmail, membership, approve, note }) {
  mustManage(membership); const policies = await col(); const cur = await policies.findOne({ _id: id(policyId), orgId: toObjectId(orgId) });
  if (!cur || cur.status !== "pending_approval") fail(409, "That policy is not waiting for approval.");
  if (String(cur.submittedBy).toLowerCase() === String(actorEmail).toLowerCase()) fail(403, "A different admin must approve it.");
  if (!approve) { const r = await policies.findOneAndUpdate({ _id: cur._id, status: "pending_approval" }, { $set: { status: "draft", note: String(note || "").slice(0, 300) || "Rejected" } }, { returnDocument: "after" }); await audit(orgId, r?.value ?? r, actorEmail, "REJECTED"); return view(r?.value ?? r); }
  return doPublish(policies, cur, orgId, actorEmail, actorEmail);
}
/** A new draft (next version number) copied from the newest version of a policy. */
export async function newVersion({ orgId, policyKey, actorEmail, membership }) {
  mustManage(membership); const policies = await col();
  const latest = await policies.find({ orgId: toObjectId(orgId), policyKey }).sort({ version: -1 }).limit(1).next();
  if (!latest) fail(404, "Policy not found."); if (latest.status === "draft" || latest.status === "pending_approval") fail(409, "There is already a version in progress.");
  const doc = { ...latest, _id: new ObjectId(), version: latest.version + 1, status: "draft", createdBy: actorEmail, createdAt: nowIso(), note: null };
  for (const k of ["publishedAt", "publishedBy", "approvedBy", "submittedBy", "submittedAt", "retiredAt", "updatedAt"]) delete doc[k];
  await policies.insertOne(doc); await audit(orgId, doc, actorEmail, "NEW_VERSION", { from: latest.version }); return view(doc);
}
export async function retirePolicy({ orgId, policyId, actorEmail, membership, reason }) {
  mustManage(membership); const policies = await col();
  const r = await policies.findOneAndUpdate({ _id: id(policyId), orgId: toObjectId(orgId), status: "published" }, { $set: { status: "retired", retiredAt: nowIso(), note: String(reason || "").slice(0, 300) || "Retired" } }, { returnDocument: "after" });
  const out = r?.value ?? r; if (!out) fail(409, "Only a published policy can be retired."); await audit(orgId, out, actorEmail, "RETIRED"); return view(out);
}
export async function deleteDraft({ orgId, policyId, actorEmail, membership }) {
  mustManage(membership); const policies = await col();
  const r = await policies.deleteOne({ _id: id(policyId), orgId: toObjectId(orgId), status: "draft" }); if (!r.deletedCount) fail(409, "Only a draft can be deleted.");
  return { ok: true };
}
export async function listPolicies({ orgId, membership, type = null, status = null }) {
  mustManage(membership); const policies = await col(); const q = { orgId: toObjectId(orgId) }; if (type) q.type = type; if (status) q.status = status;
  return (await policies.find(q).sort({ type: 1, policyKey: 1, version: -1 }).limit(500).toArray()).map(view);
}
export async function getPolicy({ orgId, policyId, membership }) {
  mustManage(membership); const policies = await col(); const p = await policies.findOne({ _id: id(policyId), orgId: toObjectId(orgId) }); if (!p) fail(404, "Policy not found."); return view(p);
}

/** Pure: does this policy's scope cover the context? Empty scope fields mean "everyone". */
export function scopeMatches(scope, ctx) {
  const s = scope || {};
  if (arr(s.departmentIds).length && !arr(s.departmentIds).includes(String(ctx.departmentId ?? ""))) return false;
  if (s.pathPrefix && !String(ctx.path ?? "").startsWith(s.pathPrefix)) return false;
  if (arr(s.roles).length && !arr(s.roles).includes(ctx.role)) return false;
  if (arr(s.emails).length && !arr(s.emails).includes(String(ctx.email ?? "").toLowerCase())) return false;
  if (arr(s.groupIds).length && !arr(ctx.groupIds).some((g) => s.groupIds.includes(String(g)))) return false;
  return true;
}
/** Published, in-effect, in-scope policies of one type, ordered by precedence then priority. Reads only: callers decide what to enforce. */
export async function effectivePolicies({ orgId, type, ctx = {}, now = new Date() }) {
  const policies = await col(); const iso = now.toISOString();
  const rows = await policies.find({ orgId: toObjectId(orgId), type, status: "published", $and: [{ $or: [{ effectiveAt: null }, { effectiveAt: { $lte: iso } }] }, { $or: [{ expiresAt: null }, { expiresAt: { $gt: iso } }] }] }).sort({ precedence: 1, priority: 1, createdAt: 1 }).toArray();
  return rows.filter((p) => scopeMatches(p.scope, ctx));
}
