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
  if (input.guestVisit !== undefined && input.guestVisit !== null && input.guestVisit !== "") {
    if (!["visited_recently", "not_visited_recently", "never_visited"].includes(input.guestVisit)) return { error: "guestVisit must be visited_recently, not_visited_recently or never_visited." };
    r.guestVisit = input.guestVisit;
    if (r.guestVisit !== "never_visited") { const n = input.visitDays === undefined || input.visitDays === "" || input.visitDays === null ? 60 : Number(input.visitDays); if (!Number.isInteger(n) || n < 1 || n > 3650) return { error: "visitDays must be a whole number of days between 1 and 3650." }; r.visitDays = n; }
  }
  if (input.consentedOnly === true) r.consentedOnly = true;
  // Commerce rules (Inaya Commerce Phase 4, Master SOW 8.6): purchase recency, spend, orders, category affinity, branch,
  // loyalty tier, customer type, at-risk, campaign engagement; static segments list their members explicitly.
  const dn = (k) => { if (input[k] === undefined || input[k] === null || input[k] === "") return null; const n = Number(input[k]); if (!Number.isInteger(n) || n < 1 || n > 3650) return `${k} must be 1-3650 days.`; r[k] = n; return null; };
  const e2 = dn("purchasedWithinDays") || dn("notPurchasedDays") || dn("categoryWithinDays") || dn("engagedWithinDays"); if (e2) return { error: e2 };
  if (input.minSpend !== undefined && input.minSpend !== null && input.minSpend !== "") { const v = Number(input.minSpend); if (!(v >= 0)) return { error: "minSpend must be zero or more." }; r.minSpendMinor = Math.round(v * 100); }
  if (input.minOrders !== undefined && input.minOrders !== null && input.minOrders !== "") { const v = Number(input.minOrders); if (!Number.isInteger(v) || v < 1) return { error: "minOrders must be a whole number." }; r.minOrders = v; }
  if (input.boughtCategory) r.boughtCategory = clean(input.boughtCategory, 80);
  if (input.branchId) { if (!/^[0-9a-f]{24}$/.test(String(input.branchId))) return { error: "branchId is not valid." }; r.branchId = String(input.branchId); }
  if (input.loyaltyTier) r.loyaltyTier = clean(input.loyaltyTier, 30);
  if (input.customerType) { if (!["INDIVIDUAL", "BUSINESS"].includes(input.customerType)) return { error: "customerType must be INDIVIDUAL or BUSINESS." }; r.customerType = input.customerType; }
  if (input.atRisk === true) r.atRisk = true;
  if (input.engagement) { if (!["opened", "clicked", "not_opened"].includes(input.engagement)) return { error: "engagement must be opened, clicked or not_opened." }; r.engagement = input.engagement; if (!r.engagedWithinDays) r.engagedWithinDays = 90; }
  if (Array.isArray(input.staticContactIds)) { const ids = input.staticContactIds.map(String).filter((x) => /^[0-9a-f]{24}$/.test(x)); if (ids.length > 50000) return { error: "A static segment holds up to 50,000 people." }; r.staticContactIds = [...new Set(ids)]; }
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
  if (r.guestVisit === "visited_recently") parts.push(`who visited in the last ${r.visitDays} days`);
  if (r.guestVisit === "not_visited_recently") parts.push(`who have visited before but not in the last ${r.visitDays} days`);
  if (r.guestVisit === "never_visited") parts.push("who have never completed a visit");
  if (r.consentedOnly) parts.push("who opted in to emails");
  if (r.staticContactIds) parts.push(`(a fixed list of ${r.staticContactIds.length})`);
  if (r.purchasedWithinDays) parts.push(`who bought in the last ${r.purchasedWithinDays} days`);
  if (r.notPurchasedDays) parts.push(`who haven't bought for ${r.notPurchasedDays} days`);
  if (r.minSpendMinor) parts.push(`who have spent at least ${r.minSpendMinor / 100}`);
  if (r.minOrders) parts.push(`with at least ${r.minOrders} purchases`);
  if (r.boughtCategory) parts.push(`who bought ${r.boughtCategory}${r.categoryWithinDays ? ` in the last ${r.categoryWithinDays} days` : ""}`);
  if (r.branchId) parts.push("who bought at the chosen branch");
  if (r.loyaltyTier) parts.push(`in the ${r.loyaltyTier} tier`);
  if (r.customerType) parts.push(r.customerType === "BUSINESS" ? "(business customers)" : "(individual customers)");
  if (r.atRisk) parts.push("who look at risk of not coming back");
  if (r.engagement) parts.push(r.engagement === "not_opened" ? `who haven't opened an email in ${r.engagedWithinDays} days` : `who ${r.engagement} an email in the last ${r.engagedWithinDays} days`);
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
  // Guest visits come from the Hospitality workspace, which stamps hospitality.lastVisitAt on the CRM contact.
  if (rules.guestVisit) {
    const cutoff = new Date(Date.now() - (rules.visitDays || 0) * 86400000).toISOString();
    if (rules.guestVisit === "visited_recently") q["hospitality.lastVisitAt"] = { $gte: cutoff };
    else if (rules.guestVisit === "not_visited_recently") q["hospitality.lastVisitAt"] = { $lt: cutoff };
    else q["hospitality.lastVisitAt"] = { $exists: false };
  }
  // commerce rules on the contact's purchase summary (kept on the contact by the till, exactly once per sale)
  const DAYMS = 86400000;
  if (rules.staticContactIds) q._id = { $in: rules.staticContactIds.map((x) => toObjectId(x)) };
  if (rules.purchasedWithinDays) q["commerce.lastPurchaseAt"] = { $gte: new Date(Date.now() - rules.purchasedWithinDays * DAYMS).toISOString() };
  if (rules.notPurchasedDays) q["commerce.lastPurchaseAt"] = { ...(q["commerce.lastPurchaseAt"] || {}), $lt: new Date(Date.now() - rules.notPurchasedDays * DAYMS).toISOString() };
  if (rules.minSpendMinor) q["commerce.spendMinor"] = { $gte: rules.minSpendMinor };
  if (rules.minOrders) q["commerce.purchaseCount"] = { $gte: rules.minOrders };
  if (rules.loyaltyTier) q["loyalty.tier"] = rules.loyaltyTier;
  if (rules.customerType) q.customerType = rules.customerType === "INDIVIDUAL" ? { $in: ["INDIVIDUAL", null] } : "BUSINESS";
  q.mergedInto = { $exists: false };
  let contacts = await crmContacts.find(q).project({ email: 1, name: 1, company: 1, type: 1, createdAt: 1, commerce: 1 }).limit(limit + 1000).toArray();
  if (rules.boughtCategory || rules.branchId) {
    const { salesOrders } = await getOrgCollections();
    const sq = { orgId: org, channel: "POS", status: { $ne: "VOIDED" }, contactId: { $ne: null } };
    if (rules.boughtCategory) { sq["lines.category"] = rules.boughtCategory; if (rules.categoryWithinDays) sq.completedAt = { $gte: new Date(Date.now() - rules.categoryWithinDays * DAYMS).toISOString() }; }
    if (rules.branchId) sq.warehouseId = toObjectId(rules.branchId);
    const buyers = new Set((await salesOrders.distinct("contactId", sq)).map(String));
    contacts = contacts.filter((c) => buyers.has(String(c._id)));
  }
  if (rules.atRisk) contacts = contacts.filter((c) => isAtRisk(c.commerce));
  if (rules.engagement) {
    const { marketing } = await engagementCollections(); const since = new Date(Date.now() - rules.engagedWithinDays * DAYMS).toISOString();
    const field = rules.engagement === "clicked" ? "clickedAt" : "openedAt";
    const engaged = new Set((await marketing.distinct("email", { orgId: org, kind: "send", [field]: { $gte: since } })).map(normEmail));
    contacts = contacts.filter((c) => (rules.engagement === "not_opened" ? !engaged.has(normEmail(c.email)) : engaged.has(normEmail(c.email))));
  }

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

/** At risk of not coming back: a repeat customer whose silence is now more than twice their usual gap (and 30+ days). */
export function isAtRisk(c, now = Date.now()) {
  if (!c?.lastPurchaseAt || !c.firstPurchaseAt || !(c.purchaseCount >= 2)) return false;
  const gap = (Date.parse(c.lastPurchaseAt) - Date.parse(c.firstPurchaseAt)) / (c.purchaseCount - 1); const since = now - Date.parse(c.lastPurchaseAt);
  return since > Math.max(2 * gap, 30 * 86400000);
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
    const before = oid(segmentId) && await marketing.findOne({ _id: oid(segmentId), orgId: toObjectId(orgId), kind: "segment" });
    const r = before && await marketing.updateOne({ _id: before._id }, { $set: { name: n, rules: v.rules, updatedAt: nowIso(), updatedBy: actorEmail }, $push: { history: { $each: [{ version: (before.history?.length || 0) + 1, name: before.name, rules: before.rules, replacedAt: nowIso(), by: actorEmail }], $slice: -50 } } });
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
