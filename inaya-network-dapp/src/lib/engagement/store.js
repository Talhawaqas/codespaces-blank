// src/lib/engagement/store.js
//
// Appointments & Campaigns SOW â€” storage, plan gate and roles.
//
// The Atlas cluster is at its collection limit, so the whole SOW lives in
// exactly two collections with a `kind` discriminator:
//   calendar_records : settings | type | availability | page | appointment | enquiry
//   marketing_records: settings | template | segment | campaign | send | suppression | sequence | enrollment
// Every document carries orgId; every query filters on { orgId, kind }.
//
// Plan: Business and Enterprise only (founder decision 2026-11-13). Orgs with
// no plan at all (legacy, unrestricted) keep access, as with every other module.
//
// Roles (optional fields on org_members, same pattern as financeRole/hrRole):
//   calendarRole : "manager" (all calendars, settings) | "staff" (own calendar; default for any member)
//   marketingRole: "manager" (everything) | "editor" (create/edit, submit for approval) | "approver" (approve/reject)
// Owner/admin are managers of both.

import { ObjectId } from "mongodb";
import { connectToDatabase } from "../mongodb.js";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { canManageOrg, canManageCalendar, canManageMarketing, canEditCampaigns, canApproveCampaigns, canViewCampaigns, CALENDAR_ROLES, MARKETING_ROLES } from "../orgGates.js";
export { canManageCalendar, canManageMarketing, canEditCampaigns, canApproveCampaigns, canViewCampaigns, CALENDAR_ROLES, MARKETING_ROLES };
import { getOrgPlan } from "../orgPlans.js";


// Monthly marketing-email allowance per plan (founder decision: Business 50k, Enterprise 250k).
export const MARKETING_MONTHLY_LIMITS = { business: 50000, enterprise: 250000, legacy: 50000 };

let indexesReady = null;

export async function engagementCollections() {
  const { db } = await connectToDatabase();
  return { calendar: db.collection("calendar_records"), marketing: db.collection("marketing_records") };
}

export async function ensureEngagementIndexes() {
  if (indexesReady) return indexesReady;
  indexesReady = (async () => {
    const { calendar, marketing } = await engagementCollections();
    await Promise.all([
      calendar.createIndex({ orgId: 1, kind: 1, staffEmail: 1, start: 1 }),
      calendar.createIndex({ orgId: 1, kind: 1, status: 1, start: 1 }),
      calendar.createIndex({ kind: 1, slug: 1 }, { unique: true, partialFilterExpression: { kind: "page" } }),
      calendar.createIndex({ kind: 1, manageTokenHash: 1 }, { partialFilterExpression: { kind: "appointment" } }),
      calendar.createIndex({ kind: 1, feedTokenHash: 1 }, { partialFilterExpression: { kind: "availability" } }),
      calendar.createIndex({ kind: 1, "reminders.dueAt": 1 }, { partialFilterExpression: { kind: "appointment" } }),
      calendar.createIndex({ orgId: 1, kind: 1, contactId: 1 }),
      marketing.createIndex({ orgId: 1, kind: 1, status: 1, updatedAt: -1 }),
      marketing.createIndex({ kind: 1, status: 1, scheduledAt: 1 }),
      marketing.createIndex({ orgId: 1, kind: 1, campaignId: 1, email: 1 }),
      marketing.createIndex({ kind: 1, providerId: 1 }, { partialFilterExpression: { kind: "send" } }),
      marketing.createIndex({ orgId: 1, kind: 1, email: 1 }, { unique: true, partialFilterExpression: { kind: "suppression" } }),
      marketing.createIndex({ kind: 1, status: 1, nextAt: 1 }, { partialFilterExpression: { kind: "enrollment" } }),
    ]);
  })().catch((e) => { indexesReady = null; throw e; });
  return indexesReady;
}

export const oid = (id) => { try { return toObjectId(id); } catch { return null; } };
export const isOid = (id) => typeof id === "string" ? ObjectId.isValid(id) && String(new ObjectId(id)) === id : id instanceof ObjectId;
export const nowIso = () => new Date().toISOString();
export const normEmail = (e) => (typeof e === "string" ? e.trim().toLowerCase() : "");
export const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normEmail(e));
export const fail = (error, status = 400) => ({ error, status });
export const clean = (s, max = 500) => (s === null || s === undefined ? "" : String(s).trim().slice(0, max));

/** Plan gate. Returns null when allowed, or a { error, status } to return. */
export async function engagementAccess(orgId, module = "appointments") {
  const { orgs } = await getOrgCollections();
  const org = await orgs.findOne({ _id: toObjectId(orgId) }, { projection: { plan: 1, extraUsers: 1, noPlanConfirmedAt: 1, name: 1 } });
  if (!org) return fail("Company not found.", 404);
  const plan = getOrgPlan(org);
  if (plan.id === null) return null; // legacy, unrestricted
  if (plan.id === "business" || plan.id === "enterprise") return null;
  const name = module === "campaigns" ? "Email campaigns" : "Appointments";
  return fail(`${name} are part of the Business and Enterprise packages. Upgrade in Settings â†’ Billing to turn them on.`, 402);
}

export async function orgPlanKey(orgId) {
  const { orgs } = await getOrgCollections();
  const org = await orgs.findOne({ _id: toObjectId(orgId) }, { projection: { plan: 1, noPlanConfirmedAt: 1 } });
  const plan = getOrgPlan(org);
  return plan.id === null ? "legacy" : plan.id;
}

// ---- calendar roles ----
/** Any active member can keep their own calendar and take bookings. */
export function canUseCalendar(m) { return !!m; }
/** May act on `staffEmail`'s calendar/appointments. */
export function canActForStaff(m, staffEmail) { return canManageCalendar(m) || normEmail(m?.email) === normEmail(staffEmail); }
/** Department view: department managers (via departmentIds) see that department's calendars. */
export function sharesDepartment(m, staffMembership) {
  const mine = new Set((m?.departmentIds || []).map(String));
  return (staffMembership?.departmentIds || []).some((d) => mine.has(String(d)));
}

// ---- marketing roles ----

/** Members of an org (email, role, roles, departments) for pickers and team views. */
export async function listOrgMembers(orgId) {
  const { orgMembers } = await getOrgCollections();
  return orgMembers.find({ orgId: toObjectId(orgId), status: "active" })
    .project({ email: 1, name: 1, role: 1, departmentIds: 1, calendarRole: 1, marketingRole: 1 }).limit(500).toArray();
}

export async function getMemberByEmail(orgId, email) {
  const { orgMembers } = await getOrgCollections();
  return orgMembers.findOne({ orgId: toObjectId(orgId), email: normEmail(email), status: "active" });
}

/** Sets calendarRole / marketingRole on a member (owner/admin only). */
export async function setEngagementRole({ orgId, membership, email, field, value }) {
  if (!canManageOrg(membership)) return fail("Only the company owner or an admin can change these roles.", 403);
  const allowed = field === "calendarRole" ? CALENDAR_ROLES : field === "marketingRole" ? MARKETING_ROLES : null;
  if (!allowed) return fail("Unknown role field.");
  if (value !== null && !allowed.includes(value)) return fail(`Role must be one of: ${allowed.join(", ")}.`);
  const { orgMembers } = await getOrgCollections();
  const r = await orgMembers.updateOne({ orgId: toObjectId(orgId), email: normEmail(email), status: "active" }, value === null ? { $unset: { [field]: "" } } : { $set: { [field]: value } });
  if (!r.matchedCount) return fail("That person isn't a member of this company.", 404);
  return { ok: true, email: normEmail(email), [field]: value };
}
