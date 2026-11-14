// src/lib/engagement/segments.js
//
// Mass Marketing Email SOW — audience segmentation over the CRM. A segment is
// a saved set of rules evaluated at send time against crm_contacts (so it is
// always current), with the CRM activity log and appointments available as
// signals ("no contact in 90 days" for re-engagement, "has booked before").
// Suppressed addresses are always removed; "consented only" narrows to people
// who opted in through a booking page or enquiry form.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { engagementCollections, ensureEngagementIndexes, oid, nowIso, normEmail, isEmail, fail, clean, canEditCampaigns, canViewCampaigns } from "./store.js";
import { suppressedAmong, consentedAmong } from "./suppression.js";

const MAX_AUDIENCE = 250000;

/** Normalises segment rules. Returns { rules } or { error }. */
export function normalizeRules(input = {}) {
  const r = {};
  if (input.contactTypes !== undefined) {
    const t = (Array.isArray(input.contactTypes) ? input.contactTypes : []).filter((x) => ["LEAD", "CUSTOMER"].includes(x));
    if (t.length) r.contactTypes = t;
  }
  if (Array.isArray(input.departmentIds) && input.departmentIds.length) r.departmentIds = input.departmentIds.map(String).filter((x) => /^[0-9a-f]{24}$/.test(x)).slice(0, 50);
  if (input.companyContains) r.companyContains = clean(input.companyContains, 80);
  if (input.emailDomain) { const d = clean(input.emailDomain, 120).toLowerCase().replace(/^@/, ""); if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return { error: "Email domain should look like example.com." }; r.emailDomain = d; }
  const days = (k, max = 3650) => { if (input[k] === undefined || input[k] === null || input[k] === "") return null; const n = Number(input[k]); if (!Number.isInteger(n) || n < 1 || n > max) return `${k} must be a whole number of days (1-${max}).`; r[k] = n; return null; };
  const err = days("createdWithinDays") || days("inactiveDays") || days("completedWithinDays");
  if (err) return { error: err };
  if (input.appointment !== undefined && input.appointment !== null && input.appointment !== "") {
    if (!["booked_any", "never_booked", "completed_recently"].includes(input.appointment)) return { error: "appointment must be booked_any, never_booked or completed_recently." };
    r.appointment = input.appointment;
    if (r.appointment === "completed_recently" && !r.completedWithinDays) r.completedWithinDays = 30;
  }
  if (input.consentedOnly === true) r.consentedOnly = true;
  return { rules: r };
}

/** Plain-English description for the Review step. */
export function describeRules(r = {}) {
  const parts = [];
  parts.push(r.contactTypes?.length === 1 ? (r.contactTypes[0] === "LEAD" ? "Leads" : "Customers") : "All CRM contacts");
  if (r.departmentIds?.length) parts.push(`in ${r.departmentIds.length} department${r.departmentIds.length > 1 ? "s" : ""}`);
  if (r.companyContains) parts.push(`at companies matching "${r.companyContains}"`);
  if (r.emailDomain) parts.push(`with @${r.emailDomain} addresses`);
  if (r.createdWithinDays) parts.push(`added in the last ${r.createdWithinDays} days`);
  if (r.inactiveDays) parts.push(`with no CRM activity in ${r.inactiveDays} days`);
  if (r.appointment === "booked_any") parts.push("who have booked an appointment");
  if (r.appointment === "never_booked") parts.push("who have never booked");
  if (r.appointment === "completed_recently") parts.push(`who had a meeting in the last ${r.completedWithinDays} days`);
  if (r.consentedOnly) parts.push("who opted in to emails");
  return `${parts.join(", ")}. Unsubscribed, bounced and complained addresses are always left out.`;
}

/** Resolves rules to recipients [{ email, name, company, contactId, type }], de-duplicated, suppression removed. */
export async function resolveAudience(orgId, rules = {}, { limit = MAX_AUDIENCE } = {}) {
  const { crmContacts, crmActivities } = await getOrgCollections();
  const org = toObjectId(orgId);
  const q = { orgId: org, deletedAt: null, email: { $type: "string", $ne: "" } };
  if (rules.contactTypes?.length) q.type = { $in: rules.contactTypes };
  if (rules.departmentIds?.length) q.departmentId = { $in: rules.departmentIds.map((d) => toObjectId(d)) };
  if (rules.companyContains) q.company = { $regex: rules.companyContains.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  if (rules.emailDomain) q.email = { $regex: `@${rules.emailDomain.replace(/\./g, "\\.")}$`, $options: "i" };
  if (rules.createdWithinDays) q.createdAt = { $gte: new Date(Date.now() - rules.createdWithinDays * 86400000).toISOString() };
  let contacts = await crmContacts.find(q).project({ email: 1, name: 1, company: 1, type: 1, createdAt: 1 }).limit(limit + 1000).toArray();

  if (rules.inactiveDays) {
    const cutoff = new Date(Date.now() - rules.inactiveDays * 86400000);
    const active = new Set((await crmActivities.distinct("contactId", { orgId: org, $or: [{ at: { $gte: cutoff.toISOString() } }, { at: { $gte: cutoff } }] })).map(String));
    contacts = contacts.filter((c) => !active.has(String(c._id)) && (!c.createdAt || new Date(c.createdAt) < cutoff));
  }
  if (rules.appointment) {
    const { calendar } = await engagementCollections();
    const aq = { orgId: org, kind: "appointment", status: rules.appointment === "completed_recently" ? "COMPLETED" : { $ne: "CANCELLED" } };
    if (rules.appointment === "completed_recently") aq.start = { $gte: new Date(Date.now() - rules.completedWithinDays * 86400000) };
    const booked = new Set((await calendar.distinct("customer.email", aq)).map(normEmail));
    contacts = contacts.filter((c) => (rules.appointment === "never_booked" ? !booked.has(normEmail(c.email)) : booked.has(normEmail(c.email))));
  }
  const seen = new Map();
  for (const c of contacts) { const e = normEmail(c.email); if (isEmail(e) && !seen.has(e)) seen.set(e, { email: e, name: c.name || "", company: c.company || "", contactId: c._id, type: c.type }); }
  let out = [...seen.values()];
  const emails = out.map((x) => x.email);
  const suppressed = new Set();
  for (let i = 0; i < emails.length; i += 5000) for (const e of await suppressedAmong(orgId, emails.slice(i, i + 5000))) suppressed.add(e);
  out = out.filter((x) => !suppressed.has(x.email));
  if (rules.consentedOnly) {
    const ok = new Set();
    for (let i = 0; i < out.length; i += 5000) for (const e of await consentedAmong(orgId, out.slice(i, i + 5000).map((x) => x.email))) ok.add(e);
    out = out.filter((x) => ok.has(x.email));
  }
  return { recipients: out.slice(0, limit), suppressedCount: suppressed.size, truncated: out.length > limit };
}

function segmentView(s) { const { orgId, kind, ...rest } = s; return { ...rest, id: String(s._id), description: describeRules(s.rules) }; }

export async function listSegments({ orgId, membership }) {
  if (!canViewCampaigns(membership)) return fail("You need a marketing role to see segments.", 403);
  await ensureEngagementIndexes();
  const { marketing } = await engagementCollections();
  return { segments: (await marketing.find({ orgId: toObjectId(orgId), kind: "segment", archived: { $ne: true } }).sort({ name: 1 }).limit(200).toArray()).map(segmentView) };
}

export async function saveSegment({ orgId, membership, actorEmail, segmentId, name, rules, archived }) {
  if (!canEditCampaigns(membership)) return fail("You need the marketing editor or manager role to save segments.", 403);
  const { marketing } = await engagementCollections();
  if (segmentId && archived !== undefined) {
    const r = oid(segmentId) && await marketing.updateOne({ _id: oid(segmentId), orgId: toObjectId(orgId), kind: "segment" }, { $set: { archived: archived === true, updatedAt: nowIso() } });
    return r?.matchedCount ? { ok: true } : fail("Segment not found.", 404);
  }
  const n = clean(name, 100); if (!n) return fail("Name the segment.");
  const v = normalizeRules(rules); if (v.error) return fail(v.error);
  if (segmentId) {
    const r = oid(segmentId) && await marketing.updateOne({ _id: oid(segmentId), orgId: toObjectId(orgId), kind: "segment" }, { $set: { name: n, rules: v.rules, updatedAt: nowIso(), updatedBy: actorEmail } });
    if (!r?.matchedCount) return fail("Segment not found.", 404);
    return { segment: segmentView(await marketing.findOne({ _id: oid(segmentId) })) };
  }
  const doc = { orgId: toObjectId(orgId), kind: "segment", name: n, rules: v.rules, archived: false, createdBy: actorEmail, createdAt: nowIso(), updatedAt: nowIso() };
  const r = await marketing.insertOne(doc);
  return { segment: segmentView({ ...doc, _id: r.insertedId }) };
}

/** Count + a 10-person sample for the Audience step (rules or a saved segment). */
export async function previewAudience({ orgId, membership, rules, segmentId }) {
  if (!canViewCampaigns(membership)) return fail("You need a marketing role to preview audiences.", 403);
  let r = rules;
  if (segmentId) { const { marketing } = await engagementCollections(); const s = oid(segmentId) && await marketing.findOne({ _id: oid(segmentId), orgId: toObjectId(orgId), kind: "segment" }); if (!s) return fail("Segment not found.", 404); r = s.rules; }
  const v = normalizeRules(r || {}); if (v.error) return fail(v.error);
  const a = await resolveAudience(orgId, v.rules);
  return { count: a.recipients.length, suppressedCount: a.suppressedCount, sample: a.recipients.slice(0, 10).map(({ email, name, company, type }) => ({ email, name, company, type })), description: describeRules(v.rules), truncated: a.truncated };
}
