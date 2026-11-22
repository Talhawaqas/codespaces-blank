// src/lib/growth/assistant.js -- Inaya Commerce Phase 4 (Master SOW 8.12): the AI growth assistant.
//
// Permission-aware and non-autonomous: everything here READS what the person may already see and returns suggestions
// with references to the records behind them (sale numbers, customer ids, campaign ids). Nothing is sent, granted or
// changed: drafting a campaign returns text for a person to put into the normal campaign editor and approval flow.
// Analysis is deterministic (so it can be checked against the data); only campaign drafting calls a model, through the
// same gated path as the support AI (input/output security checks, prompt-injection filtering, PII minimised -- the
// model sees aggregates, never customer names or emails).
import { getOrgCollections, toObjectId } from "../orgs.js";
import { fail, sid, fromMinor, commerceAccess, getSettings } from "../commerce/store.js";
import { isAtRisk } from "../engagement/segments.js";
import { ccol } from "../commerce/store.js";

const DAY = 86400000;

/** Customers at risk of not coming back, with why, value and a suggested action. */
export async function atRiskCustomers({ orgId, membership, limit = 50 }) {
  const denied = await commerceAccess({ orgId, membership, need: "supervise" }); if (denied) return denied;
  const { crmContacts } = await getOrgCollections();
  const rows = (await crmContacts.find({ orgId: toObjectId(orgId), deletedAt: null, mergedInto: { $exists: false }, "commerce.purchaseCount": { $gte: 2 } }, { projection: { name: 1, commerce: 1, email: 1 } }).limit(20000).toArray()).filter((c) => isAtRisk(c.commerce));
  const out = rows.map((c) => { const gap = (Date.parse(c.commerce.lastPurchaseAt) - Date.parse(c.commerce.firstPurchaseAt)) / (c.commerce.purchaseCount - 1) / DAY; const silent = (Date.now() - Date.parse(c.commerce.lastPurchaseAt)) / DAY;
    return { customerId: sid(c._id), name: c.name, purchases: c.commerce.purchaseCount, spend: fromMinor(c.commerce.spendMinor || 0), usualGapDays: Math.round(gap), silentDays: Math.round(silent), canEmail: !!c.email,
      why: `Usually buys every ~${Math.round(gap)} days; nothing for ${Math.round(silent)} days.`, suggestion: c.email ? "Add to a win-back email (needs consent) or call them." : "No email on file: call or message them directly.", ref: { customerId: sid(c._id) } }; })
    .sort((a, b) => b.spend - a.spend).slice(0, limit);
  return { customers: out, rule: "A repeat customer silent for more than twice their usual gap (and over 30 days)." };
}

/** What to offer one customer next: popular items in their favourite categories that they haven't bought. */
export async function nextBestProducts({ orgId, membership, customerId }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  const { salesOrders, products } = await getOrgCollections(); const o = toObjectId(orgId);
  const mine = await salesOrders.find({ orgId: o, contactId: toObjectId(customerId), channel: "POS", status: { $ne: "VOIDED" } }, { projection: { lines: 1, saleNumber: 1 } }).toArray();
  if (!mine.length) return { suggestions: [], note: "No purchases yet." };
  const owned = new Set(); const cat = new Map();
  for (const s of mine) for (const l of s.lines) { owned.add(String(l.productId)); if (l.category) cat.set(l.category, (cat.get(l.category) || 0) + l.grossMinor); }
  const top = [...cat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k);
  if (!top.length) return { suggestions: [], note: "Their purchases have no categories to compare." };
  const since = new Date(Date.now() - 180 * DAY).toISOString();
  const pop = await salesOrders.aggregate([{ $match: { orgId: o, channel: "POS", status: { $ne: "VOIDED" }, completedAt: { $gte: since } } }, { $unwind: "$lines" }, { $match: { "lines.category": { $in: top } } }, { $group: { _id: "$lines.productId", n: { $sum: "$lines.quantity" }, name: { $first: "$lines.name" }, category: { $first: "$lines.category" } } }, { $sort: { n: -1 } }, { $limit: 30 }]).toArray();
  const active = new Set((await products.find({ orgId: o, _id: { $in: pop.map((p) => p._id) }, status: "ACTIVE", deletedAt: null }, { projection: { _id: 1 } }).toArray()).map((p) => String(p._id)));
  return { suggestions: pop.filter((p) => !owned.has(String(p._id)) && active.has(String(p._id))).slice(0, 5).map((p) => ({ productId: sid(p._id), name: p.name, category: p.category, why: `Popular in ${p.category} (${p.n} sold in 180 days), which this customer buys most.`, ref: { productId: sid(p._id) } })), basedOn: mine.slice(0, 10).map((s) => s.saleNumber) };
}

/** Unusual refund or loyalty patterns worth a look (never an accusation: a list to review). */
export async function unusualPatterns({ orgId, membership }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const { salesOrders } = await getOrgCollections(); const o = toObjectId(orgId); const since = new Date(Date.now() - 90 * DAY).toISOString(); const c = await ccol();
  const refunders = await salesOrders.aggregate([{ $match: { orgId: o, channel: "POS", contactId: { $ne: null }, completedAt: { $gte: since } } }, { $group: { _id: "$contactId", bought: { $sum: "$totals.totalMinor" }, refunded: { $sum: { $ifNull: ["$refundedMinor", 0] } }, refunds: { $sum: { $size: { $ifNull: ["$refunds", []] } } } } }, { $match: { refunds: { $gte: 3 } } }]).toArray();
  const staffRefunds = await salesOrders.aggregate([{ $match: { orgId: o, channel: "POS", "refunds.createdAt": { $gte: since } } }, { $unwind: "$refunds" }, { $group: { _id: "$refunds.processedBy", n: { $sum: 1 }, value: { $sum: "$refunds.totalMinor" }, noReceiptCustomer: { $sum: { $cond: [{ $eq: ["$contactId", null] }, 1, 0] } } } }, { $sort: { value: -1 } }]).toArray();
  const avgStaff = staffRefunds.length ? staffRefunds.reduce((s, x) => s + x.value, 0) / staffRefunds.length : 0;
  const adjust = await c.aggregate([{ $match: { orgId: o, kind: "g_points", type: "ADJUST", at: { $gte: since } } }, { $group: { _id: "$by", n: { $sum: 1 }, points: { $sum: "$points" } } }, { $match: { points: { $gt: 0 } } }, { $sort: { points: -1 } }]).toArray();
  return {
    customers: refunders.filter((r) => r.bought && r.refunded / r.bought >= 0.3).map((r) => ({ customerId: sid(r._id), refunds: r.refunds, refundRate: Math.round((r.refunded / r.bought) * 100), note: "Returned 30%+ of what they bought in 90 days.", ref: { customerId: sid(r._id) } })),
    staff: staffRefunds.filter((s) => staffRefunds.length >= 3 && s.value > avgStaff * 2).map((s) => ({ staff: s._id, refunds: s.n, value: fromMinor(s.value), note: "Refunds more than twice the team average in 90 days." })),
    pointsAdjustments: adjust.filter((a) => a.points >= 1000).map((a) => ({ by: a._id, adjustments: a.n, points: a.points, note: "Large manual points additions in 90 days." })),
    disclaimer: "Patterns to review, not conclusions. Check the underlying records before acting.",
  };
}

/** A short relationship summary for one customer, built from the 360 view (deterministic, with references). */
export async function relationshipSummary({ orgId, membership, customerId }) {
  const { intelligence } = await import("./customer360.js"); const i = await intelligence({ orgId, membership, customerId }); if (i.error) return i;
  if (!i.hasHistory) return { summary: "No purchases yet. Start with a welcome offer if they've agreed to marketing.", refs: [] };
  const s = [`${i.rfm.label} customer: ${i.orders} purchase(s), ${i.currency} ${i.totalSpend.toLocaleString()} spent, average ${i.currency} ${i.aov}.`,
    `Last bought ${i.recencyDays} day(s) ago${i.atRisk ? " (later than usual: at risk)" : ""}.`, i.affinity.length ? `Mostly buys ${i.affinity.map((a) => a.category).join(", ")}.` : null,
    i.refundRate >= 20 ? `Returns are high (${i.refundRate}% of purchases).` : null].filter(Boolean).join(" ");
  const action = i.atRisk ? "Suggested: a personal win-back message or offer." : i.rfm.label === "Champion" ? "Suggested: thank them; consider a loyalty tier or early-access offer." : i.rfm.label === "New" ? "Suggested: a welcome follow-up and a review request." : "Suggested: a relevant product suggestion (see Next products).";
  return { summary: s, action, refs: [{ customerId }], definitions: i.definitions };
}

/** Segment summary: size, spend, recency, top categories -- for a saved segment the person can see. */
export async function summarizeSegment({ orgId, membership, segmentId }) {
  const { canViewCampaigns, engagementCollections } = await import("../engagement/store.js");
  if (!canViewCampaigns(membership)) return fail("You need a marketing role to see segments.", 403);
  const { marketing } = await engagementCollections(); const seg = await marketing.findOne({ _id: toObjectId(segmentId), orgId: toObjectId(orgId), kind: "segment" }); if (!seg) return fail("Segment not found.", 404);
  const { resolveAudience } = await import("../engagement/segments.js"); const a = await resolveAudience(orgId, seg.rules || {}, { limit: 20000 });
  const { crmContacts } = await getOrgCollections(); const people = await crmContacts.find({ _id: { $in: a.recipients.map((r) => r.contactId) } }, { projection: { commerce: 1 } }).toArray();
  const buyers = people.filter((p) => p.commerce?.purchaseCount > 0); const spend = buyers.reduce((s, p) => s + (p.commerce.spendMinor || 0), 0);
  const rec = buyers.map((p) => (Date.now() - Date.parse(p.commerce.lastPurchaseAt)) / DAY).sort((x, y) => x - y);
  return { segment: seg.name, people: a.recipients.length, suppressedExcluded: a.suppressedCount, buyers: buyers.length, totalSpend: fromMinor(spend), averageSpend: buyers.length ? fromMinor(Math.round(spend / buyers.length)) : 0, medianDaysSinceLastPurchase: rec.length ? Math.round(rec[Math.floor(rec.length / 2)]) : null, atRisk: buyers.filter((p) => isAtRisk(p.commerce)).length };
}

/** Explains a campaign's results in plain words, from the campaign report (numbers cited). */
export async function explainCampaign({ orgId, membership, campaignId }) {
  const { campaignReport } = await import("../engagement/campaigns.js"); const r = await campaignReport({ orgId, membership, campaignId }); if (r.error) return r;
  const t = r.totals || r.report || r; const sent = t.sent ?? t.delivered ?? 0; const open = sent ? Math.round(((t.opened ?? t.opens ?? 0) / sent) * 100) : 0; const click = sent ? Math.round(((t.clicked ?? t.clicks ?? 0) / sent) * 100) : 0;
  const { attribution } = await import("./triggers.js"); const at = await attribution({ orgId, membership, days: 90 }); const mine = at.byCampaign?.find((x) => x.id === String(campaignId));
  return { explanation: `${sent} delivered; ${open}% opened and ${click}% clicked.${t.bounced ? ` ${t.bounced} bounced.` : ""}${t.unsubscribed ? ` ${t.unsubscribed} unsubscribed.` : ""}${mine ? ` ${mine.sales} till sale(s) worth ${mine.revenue} followed a click within 7 days.` : " No attributed till sales yet."}`, numbers: { sent, openRate: open, clickRate: click, attributed: mine || null }, ref: { campaignId } };
}

/** Drafts campaign text for a person to review in the campaign editor. Gated model call; aggregates only. */
export async function draftCampaign({ orgId, membership, actorEmail, goal, segmentId = null }) {
  const { canEditCampaigns } = await import("../engagement/store.js"); if (!canEditCampaigns(membership)) return fail("You need the marketing editor role to draft campaigns.", 403);
  const g = String(goal || "").trim().slice(0, 300); if (g.length < 5) return fail("Describe the goal of the campaign.");
  const settings = await getSettings(orgId);
  const facts = segmentId ? await summarizeSegment({ orgId, membership, segmentId }) : null;
  const { gatedJson } = await import("../support/ai.js");
  const schema = { type: "OBJECT", properties: { subject: { type: "STRING" }, preheader: { type: "STRING" }, body: { type: "STRING" }, notes: { type: "ARRAY", items: { type: "STRING" } } }, required: ["subject", "body"] };
  const r = await gatedJson({ orgId, actorEmail, sessionId: `growth-draft-${Date.now()}`, screenText: g, system: "You draft short, honest marketing emails for a small business. Never invent discounts, prices, dates or facts not given. Use {{name}} for the first name. Plain language, no pressure tactics. Return JSON only.",
    contents: [{ role: "user", parts: [{ text: `Goal: ${g}\nCurrency: ${settings.currency}\n${facts && !facts.error ? `Audience facts: ${facts.people} people, ${facts.buyers} have bought, average spend ${facts.averageSpend}, ${facts.atRisk} at risk.` : "No audience facts."}` }] }],
    schema, validate: (j) => (typeof j.subject === "string" && j.subject.trim() && typeof j.body === "string" && j.body.trim() ? { ok: true, value: { subject: j.subject.slice(0, 120), preheader: String(j.preheader || "").slice(0, 160), body: j.body.slice(0, 4000), notes: (j.notes || []).slice(0, 5).map((n) => String(n).slice(0, 200)) } } : { ok: false, error: "subject and body are required" }) });
  if (!r.ok) return fail(r.code === "BLOCKED" ? r.reason : "The assistant couldn't draft this right now. Try again or write it yourself.", r.code === "BLOCKED" ? 403 : 503, r.code);
  return { draft: r.value, basedOn: facts && !facts.error ? { segment: facts.segment, people: facts.people } : null, note: "A draft only. Paste it into a campaign, check every claim, and send it through the normal approval." };
}
