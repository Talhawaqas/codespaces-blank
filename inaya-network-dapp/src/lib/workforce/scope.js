// src/lib/workforce/scope.js -- Commerce Phase 6: BRANCH (location) scoping and the consolidated user administration.
//
// Branches are the company's inventory locations (`warehouses`). Each member may carry:
//   locationIds        branches they may work in ([] or missing = every branch, so existing companies are unchanged)
//   defaultLocationId  the branch their screens open on
// Owners and admins always see every branch. Enforcement is SERVER-SIDE (allowedLocation / scopeFilter), like tenant
// isolation: a cashier assigned to Lahore cannot read or act on Karachi data by URL or API.
//
// Plan limits (owner decision 22 Nov 2026, "Option A"): the Business + Commerce bundle includes up to 2 selling branches and
// 3 tills; Enterprise is unlimited; extra branches/tills are purchasable (org.commerceExtraBranches / commerceExtraTills).
import { getOrgCollections, toObjectId, canManageOrg } from "../orgs.js";
import { oid, sid, fail, nowIso, audit } from "../commerce/store.js";

export const ROLE_TEMPLATES = {
  cashier: { label: "Cashier", role: "member", commerceRole: "cashier", financeRole: null, hrRole: null },
  store_manager: { label: "Store manager", role: "member", commerceRole: "manager", financeRole: "staff", hrRole: "staff" },
  area_manager: { label: "Area manager", role: "member", commerceRole: "manager", financeRole: "staff", hrRole: "manager" },
  supervisor: { label: "Shift supervisor", role: "member", commerceRole: "supervisor", financeRole: null, hrRole: null },
  accountant: { label: "Accountant", role: "member", commerceRole: null, financeRole: "manager", hrRole: null },
  hr_officer: { label: "HR officer", role: "member", commerceRole: null, financeRole: null, hrRole: "manager" },
  staff: { label: "Staff (no special access)", role: "member", commerceRole: null, financeRole: null, hrRole: null },
};
const FIELDS = { role: ["member", "admin"], commerceRole: ["cashier", "supervisor", "manager"], financeRole: ["staff", "manager"], hrRole: ["staff", "manager"], supportRole: ["agent", "manager"] };
export const BRANCH_LIMITS = { business: { branches: 2, tills: 3 }, enterprise: { branches: null, tills: null } };

/** null = every branch; otherwise the list of branch ids (strings) this member may work in. */
export function memberLocations(m) {
  if (!m || canManageOrg(m)) return null;
  const ids = (m.locationIds || []).map(String).filter(Boolean);
  return ids.length ? ids : null;
}
export function allowedLocation(m, locationId) { const ids = memberLocations(m); return !ids || (locationId && ids.includes(String(locationId))); }
/** Mongo filter fragment restricting a query on `field` to the member's branches. */
export function scopeFilter(m, field = "warehouseId") { const ids = memberLocations(m); return ids ? { [field]: { $in: ids.map(oid).filter(Boolean) } } : {}; }
export const denyLocation = () => fail("You aren't assigned to that branch.", 403, "BRANCH_SCOPE");

export async function branchLimits(orgId) {
  const { orgs } = await getOrgCollections(); const org = await orgs.findOne({ _id: oid(orgId) }, { projection: { plan: 1, commerceExtraBranches: 1, commerceExtraTills: 1 } });
  const base = org?.plan === "enterprise" ? BRANCH_LIMITS.enterprise : BRANCH_LIMITS.business;
  return { plan: org?.plan || null, branches: base.branches === null ? null : base.branches + (Number(org?.commerceExtraBranches) || 0), tills: base.tills === null ? null : base.tills + (Number(org?.commerceExtraTills) || 0) };
}

/** The branches a person may pick in the "Working at" switcher. */
export async function myLocations({ orgId, membership }) {
  const { warehouses } = await getOrgCollections(); const ids = memberLocations(membership);
  const rows = await warehouses.find({ orgId: oid(orgId), ...(ids ? { _id: { $in: ids.map(oid) } } : {}) }, { projection: { name: 1, city: 1, address: 1 } }).sort({ name: 1 }).toArray();
  const def = membership?.defaultLocationId && rows.some((w) => sid(w._id) === String(membership.defaultLocationId)) ? String(membership.defaultLocationId) : rows[0] ? sid(rows[0]._id) : null;
  return { locations: rows.map((w) => ({ id: sid(w._id), name: w.name, city: w.city || null })), defaultLocationId: def, canSeeAll: !ids, email: membership?.email || null,
    canManageUsers: canManageOrg(membership), isManager: canManageOrg(membership) || membership?.hrRole === "manager" || membership?.commerceRole === "manager" };
}

// ---------------------------------------------------------------- consolidated user administration ("Manage users")
const view = (m, names) => ({ email: m.email, name: m.name || null, role: m.role, status: m.status, commerceRole: m.commerceRole || null, financeRole: m.financeRole || null, hrRole: m.hrRole || null, supportRole: m.supportRole || null,
  departmentIds: (m.departmentIds || []).map(String), locationIds: (m.locationIds || []).map(String), defaultLocationId: m.defaultLocationId ? String(m.defaultLocationId) : null, template: m.roleTemplate || null,
  locations: (m.locationIds || []).map((id) => names.get(String(id))).filter(Boolean), lastChangedAt: m.accessChangedAt || null });
export async function listUsers({ orgId, membership }) {
  if (!canManageOrg(membership)) return fail("Only the owner or an admin can manage users.", 403);
  const { orgMembers, warehouses, departments } = await getOrgCollections();
  const ws = await warehouses.find({ orgId: oid(orgId) }, { projection: { name: 1, city: 1 } }).sort({ name: 1 }).toArray();
  const names = new Map(ws.map((w) => [sid(w._id), w.name]));
  const rows = await orgMembers.find({ orgId: oid(orgId), status: { $ne: "removed" } }).sort({ email: 1 }).toArray();
  const depts = await departments.find({ orgId: oid(orgId) }, { projection: { name: 1 } }).toArray();
  return { users: rows.map((m) => view(m, names)), locations: ws.map((w) => ({ id: sid(w._id), name: w.name, city: w.city || null })), departments: depts.map((d) => ({ id: sid(d._id), name: d.name })), templates: Object.entries(ROLE_TEMPLATES).map(([k, v]) => ({ key: k, label: v.label })), limits: await branchLimits(orgId) };
}
/** Owner/admin sets a member's role, module permissions, branches and status. Nobody can change their own access, the owner's
 *  access can't be changed here, and every change is audited with before/after. */
export async function updateUser({ orgId, membership, actorEmail, email, input = {} }) {
  if (!canManageOrg(membership)) return fail("Only the owner or an admin can manage users.", 403);
  const target = String(email || "").trim().toLowerCase();
  if (target === String(actorEmail || "").toLowerCase()) return fail("You can't change your own access. Ask another admin.", 403, "SELF_CHANGE");
  const { orgMembers, warehouses, departments } = await getOrgCollections();
  const m = await orgMembers.findOne({ orgId: oid(orgId), email: target, status: { $ne: "removed" } }); if (!m) return fail("User not found.", 404);
  if (m.role === "owner") return fail("The owner's access can't be changed here.", 403);
  const set = {}; const tpl = input.template ? ROLE_TEMPLATES[input.template] : null; if (input.template && !tpl) return fail("Unknown role template.");
  const src = { ...(tpl || {}), ...input };
  for (const [k, allowed] of Object.entries(FIELDS)) if (src[k] !== undefined) { if (src[k] !== null && src[k] !== "" && !allowed.includes(src[k])) return fail(`${k} must be one of ${allowed.join(", ")}.`); set[k] = src[k] || (k === "role" ? "member" : null); }
  if (set.role === "admin" && membership.role !== "owner") return fail("Only the owner can make someone an admin.", 403);
  if (input.departmentIds !== undefined) { const ids = (Array.isArray(input.departmentIds) ? input.departmentIds : []).map(oid).filter(Boolean); if (ids.length !== await departments.countDocuments({ orgId: oid(orgId), _id: { $in: ids } })) return fail("A department was not found.", 404); set.departmentIds = ids; }
  if (input.locationIds !== undefined) { const ids = (Array.isArray(input.locationIds) ? input.locationIds : []).map(oid).filter(Boolean); if (ids.length !== await warehouses.countDocuments({ orgId: oid(orgId), _id: { $in: ids } })) return fail("A branch was not found.", 404); set.locationIds = ids; }
  if (input.defaultLocationId !== undefined) { const d = input.defaultLocationId ? oid(input.defaultLocationId) : null; const locs = (set.locationIds || m.locationIds || []).map(String); if (d && locs.length && !locs.includes(String(d))) return fail("The default branch must be one of the user's branches."); set.defaultLocationId = d; }
  if (input.status !== undefined) { if (!["active", "suspended"].includes(input.status)) return fail("Status is active or suspended."); set.status = input.status; }
  if (tpl) set.roleTemplate = input.template;
  if (!Object.keys(set).length) return fail("Nothing to change.");
  set.accessChangedAt = nowIso(); set.accessChangedBy = actorEmail;
  const before = Object.fromEntries(Object.keys(set).map((k) => [k, m[k] ?? null]));
  await orgMembers.updateOne({ _id: m._id }, { $set: set });
  await audit({ orgId, actorEmail, recordType: "ORG_MEMBER", recordId: m._id, action: "MEMBER_ACCESS_CHANGED", previousState: null, newState: null, metadata: { email: target, before: JSON.parse(JSON.stringify(before)), after: JSON.parse(JSON.stringify(set)) } });
  const ws = await warehouses.find({ orgId: oid(orgId) }, { projection: { name: 1 } }).toArray();
  return { user: view(await orgMembers.findOne({ _id: m._id }), new Map(ws.map((w) => [sid(w._id), w.name]))) };
}

/** Branch creation respects the plan's branch limit (Option A) -- ONLY when the new Commerce pricing is switched on
 *  (COMMERCE_PLAN_LIMITS=1) AND the company is on that pricing (org.commercePricingVersion >= 2). Until then it is inert,
 *  and existing companies are never blocked on warehouses they already use. */
export async function canAddBranch(orgId) {
  if (process.env.COMMERCE_PLAN_LIMITS !== "1") return null;
  const { orgs } = await getOrgCollections(); const org = await orgs.findOne({ _id: oid(orgId) }, { projection: { commercePricingVersion: 1 } });
  if (!(Number(org?.commercePricingVersion) >= 2)) return null;
  const lim = await branchLimits(orgId); if (lim.branches === null) return null;
  const { warehouses } = await getOrgCollections(); const n = await warehouses.countDocuments({ orgId: oid(orgId), kind: { $ne: "quarantine" } });
  return n >= lim.branches ? fail(`Your plan includes ${lim.branches} branches. Add an extra branch, or move to Enterprise for unlimited branches.`, 403, "BRANCH_LIMIT") : null;
}
export { toObjectId };
