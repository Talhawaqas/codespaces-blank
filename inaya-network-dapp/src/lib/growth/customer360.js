// src/lib/growth/customer360.js -- Inaya Commerce Phase 4 (Master SOW 8.2 - 8.5): customer profile, timeline, intelligence,
// duplicates and merge.
//
// The CRM contact is the customer's identity (one id across POS, orders, invoices, support, bookings, loyalty, cards).
// The TIMELINE is a read model over the authorized sources -- nothing is copied -- and each source is shown only to people
// who may see it (CRM department access; invoices/payments need finance access; campaign engagement needs a marketing
// role). Contact details in the timeline are minimized (no card data; codes never; amounts and references only).
//
// INTELLIGENCE definitions (shown in the UI; company currency; refunds netted; voided sales excluded):
//   total spend      POS sales - refunds + invoices issued to the customer (sales orders become invoices, so orders are
//                    not counted twice)
//   orders           POS sales + invoices;  AOV = total spend / orders
//   frequency        orders per month over the customer's active span (first to last purchase, at least one month)
//   recency          days since the last purchase
//   RFM              R: <=30d 5, <=60d 4, <=120d 3, <=240d 2, else 1;  F: purchases in 12 months >=12 5, >=6 4, >=3 3, 2 2, 1 1;
//                    M: the company's customer spend quintiles over 12 months. Labels: Champion, Loyal, At risk, New,
//                    Hibernating, Promising.
//   lifetime value   historical (what they have spent). A forward estimate is shown ONLY with 3+ purchases over 90+ days:
//                    AOV x purchases per year x 3 years, labelled an estimate; otherwise "not enough history" -- never a
//                    fabricated number.
//   repeat / refunds repeat = 2+ purchases; refund rate = refunded / bought;  affinity = top categories by spend
//   at risk          a repeat customer silent for more than twice their usual gap (and 30+ days)
//   channel          where purchases came from (till, orders/invoices, online when Phase 5 is live) + the contact's source
//
// DUPLICATES: candidates share a normalized email or phone, or a very similar name AND company/address; a weak name match
// alone is never a candidate. MERGE: owner/admin only, preview first, same company only; the duplicate is kept (status
// MERGED, mergedInto) and every reference that pointed at it is moved to the survivor; the moved ids are recorded so the
// merge can be UNDONE. Storage: calendar_records kind g_merge.
import { getOrgCollections, toObjectId, canAccessDepartment, canAccessFinance, canManageOrg } from "../orgs.js";
import { ccol, ensureCommerceIndexes, fail, clean, nowIso, oid, sid, fromMinor, getSettings } from "../commerce/store.js";
import { logOrgActivity } from "../org-activity-log.js";
import { isAtRisk } from "../engagement/segments.js";

const DAY = 86400000; const r2 = (n) => Math.round(n * 100) / 100;
export const MERGE_KIND = "g_merge";
const normPhone = (p) => { const d = String(p || "").replace(/\D/g, ""); return d.length >= 9 ? d.slice(-9) : null; };
const normEmail = (e) => String(e || "").trim().toLowerCase() || null;
const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
function sim(a, b) { const A = new Set(normName(a).split(" ").filter(Boolean)), B = new Set(normName(b).split(" ").filter(Boolean)); if (!A.size || !B.size) return 0; let n = 0; for (const t of A) if (B.has(t)) n++; return n / Math.max(A.size, B.size); }

async function loadContact(orgId, membership, customerId) {
  const { crmContacts } = await getOrgCollections();
  const c = await crmContacts.findOne({ _id: toObjectId(customerId), orgId: toObjectId(orgId), deletedAt: null });
  if (!c || !canAccessDepartment(membership, c.departmentId)) return null; return c;
}

// ---------------------------------------------------------------- profile (8.2)
export const PROFILE_FIELDS = ["customerType", "contactPreferences", "accountStatus", "accountManagerEmail", "creditLimit", "birthday", "tags", "sourceChannel"];
export async function updateProfile({ orgId, membership, actorEmail, customerId, input }) {
  const c = await loadContact(orgId, membership, customerId); if (!c) return fail("Customer not found.", 404);
  const set = {};
  if (input.customerType !== undefined) { if (!["INDIVIDUAL", "BUSINESS"].includes(input.customerType)) return fail("customerType must be INDIVIDUAL or BUSINESS."); set.customerType = input.customerType; }
  if (input.contactPreferences !== undefined) { const p = input.contactPreferences || {}; set.contactPreferences = { email: p.email !== false, sms: p.sms === true, phone: p.phone !== false, post: p.post === true }; }
  if (input.accountStatus !== undefined) { if (!["ACTIVE", "ON_HOLD", "CLOSED"].includes(input.accountStatus)) return fail("accountStatus must be ACTIVE, ON_HOLD or CLOSED."); set.accountStatus = input.accountStatus; }
  if (input.accountManagerEmail !== undefined) set.accountManagerEmail = input.accountManagerEmail ? normEmail(input.accountManagerEmail) : null;
  if (input.creditLimit !== undefined) { if (input.creditLimit !== null && !(Number(input.creditLimit) >= 0)) return fail("creditLimit must be zero or more."); if (!canAccessFinance(membership)) return fail("Credit limits need finance access.", 403); set.creditLimitMinor = input.creditLimit === null ? null : Math.round(Number(input.creditLimit) * 100); }
  if (input.birthday !== undefined) { if (input.birthday !== null && !/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(String(input.birthday))) return fail("birthday is MM-DD (no year is stored)."); set.birthday = input.birthday || null; }
  if (input.tags !== undefined) { if (!Array.isArray(input.tags) || input.tags.length > 30) return fail("Up to 30 tags."); set.tags = [...new Set(input.tags.map((t) => clean(t, 40).toLowerCase()).filter(Boolean))]; }
  if (input.sourceChannel !== undefined) set.sourceChannel = clean(input.sourceChannel, 60) || null;
  if (!Object.keys(set).length) return fail("Nothing to change.");
  const { crmContacts } = await getOrgCollections();
  await crmContacts.updateOne({ _id: c._id }, { $set: { ...set, updatedAt: nowIso() } });
  await logOrgActivity({ orgId: toObjectId(orgId), recordType: "CRM_CONTACT", recordId: c._id, actorEmail, action: "CUSTOMER_PROFILE_UPDATED", previousState: Object.fromEntries(Object.keys(set).map((k) => [k, c[k] ?? null])), newState: set, metadata: {} }).catch(() => {});
  return { profile: profileView({ ...c, ...set }) };
}
export const profileView = (c) => ({ id: sid(c._id), name: c.name, company: c.company || null, email: c.email || null, phone: c.phone || null, type: c.type, customerType: c.customerType || (c.company ? "BUSINESS" : "INDIVIDUAL"),
  billingAddress: c.billingAddress || null, shippingAddress: c.shippingAddress || null, taxId: c.taxId || null, paymentTerms: c.paymentTerms || null, contactPreferences: c.contactPreferences || { email: true, sms: false, phone: true, post: false },
  accountStatus: c.accountStatus || "ACTIVE", accountManagerEmail: c.accountManagerEmail || null, creditLimit: c.creditLimitMinor == null ? null : fromMinor(c.creditLimitMinor), birthday: c.birthday || null, tags: c.tags || [],
  sourceChannel: c.sourceChannel || null, loyaltyTier: c.loyalty?.tier || null, mergedInto: sid(c.mergedInto), createdAt: c.createdAt, updatedAt: c.updatedAt || null });

// ---------------------------------------------------------------- timeline (8.4)
export async function timeline({ orgId, membership, customerId, limit = 200 }) {
  const c = await loadContact(orgId, membership, customerId); if (!c) return fail("Customer not found.", 404);
  const o = toObjectId(orgId); const { salesOrders, invoices, crmActivities, supportTickets, db } = await getOrgCollections(); const cc = await ccol();
  const ev = []; const push = (e) => ev.push({ ...e, at: e.at || null });
  for (const s of await salesOrders.find({ orgId: o, contactId: c._id }).sort({ createdAt: -1 }).limit(200).toArray()) {
    if (s.channel === "POS") {
      push({ type: s.status === "VOIDED" ? "void" : "sale", at: s.completedAt, title: `${s.status === "VOIDED" ? "Voided sale" : "Purchase"} ${s.saleNumber}`, amount: fromMinor(s.totals.totalMinor), currency: s.currency, ref: { saleId: sid(s._id) } });
      for (const r of s.refunds || []) push({ type: "refund", at: r.createdAt, title: `Refund ${r.refundNumber} (${s.saleNumber})`, amount: -fromMinor(r.totalMinor), currency: s.currency, detail: r.reason, ref: { saleId: sid(s._id) } });
    } else {
      push({ type: s.status === "QUOTE" ? "quote" : "order", at: s.createdAt, title: `${s.status === "QUOTE" ? "Quote" : "Order"} ${s.orderNumber} · ${String(s.status).toLowerCase()}${s.stage ? ` / ${String(s.stage).toLowerCase().replaceAll("_", " ")}` : ""}`, amount: s.total ?? s.subtotal, currency: s.currency, ref: { orderId: sid(s._id) } });
      for (const p of s.payments || []) push({ type: p.kind === "REFUND" ? "refund" : "payment", at: p.at, title: `${p.kind === "REFUND" ? "Deposit refunded" : p.kind === "DEPOSIT" ? "Deposit" : "Payment"} on ${s.orderNumber}`, amount: (p.kind === "REFUND" ? -1 : 1) * p.amountMinor / 100, currency: s.currency, ref: { orderId: sid(s._id) } });
      for (const r of s.returns || []) push({ type: "return", at: r.at, title: `Return ${r.no} on ${s.orderNumber}`, detail: r.reason, ref: { orderId: sid(s._id) } });
    }
  }
  if (canAccessFinance(membership)) for (const i of await invoices.find({ orgId: o, contactId: c._id, deletedAt: null }).sort({ issueDate: -1 }).limit(100).toArray()) {
    push({ type: "invoice", at: i.issueDate, title: `Invoice ${i.invoiceNumber} · ${String(i.status).toLowerCase()}`, amount: i.total, currency: i.currency, ref: { invoiceId: sid(i._id) } });
    if (i.status === "PAID") push({ type: "payment", at: i.paidAt || i.updatedAt, title: `Invoice ${i.invoiceNumber} paid`, amount: i.total, currency: i.currency, ref: { invoiceId: sid(i._id) } });
  }
  for (const t of await supportTickets.find({ orgId: o, $or: [{ "requester.contactId": c._id }, ...(c.email ? [{ "requester.email": normEmail(c.email) }] : [])], deletedAt: null }).sort({ createdAt: -1 }).limit(50).project({ number: 1, subject: 1, status: 1, createdAt: 1 }).toArray())
    push({ type: "support", at: t.createdAt, title: `Support #${t.number ?? ""} · ${String(t.status).toLowerCase()}`, detail: t.subject, ref: { ticketId: sid(t._id) } });
  if (c.email) for (const a of await db.collection("calendar_records").find({ orgId: o, kind: "appointment", "customer.email": normEmail(c.email) }).sort({ start: -1 }).limit(50).toArray())
    push({ type: "booking", at: a.start instanceof Date ? a.start.toISOString() : a.start, title: `Booking · ${String(a.status || "").toLowerCase()}`, detail: a.title || a.serviceName || null });
  for (const p of await cc.find({ orgId: o, kind: "g_points", customerId: c._id }).sort({ at: -1 }).limit(100).toArray())
    push({ type: "loyalty", at: p.at, title: `${p.points > 0 ? "+" : ""}${p.points} points · ${p.type.toLowerCase().replaceAll("_", " ")}`, detail: p.reason || null });
  for (const k of await cc.find({ orgId: o, kind: "g_card", customerId: c._id }).toArray())
    push({ type: "giftcard", at: k.createdAt, title: `${k.type === "STORE_CREDIT" ? "Store credit" : "Gift card"} ••${k.last4} · ${k.status.toLowerCase()}`, amount: fromMinor(k.balanceMinor), currency: k.currency });
  const { canViewCampaigns } = await import("../engagement/store.js");
  if (c.email && canViewCampaigns(membership)) for (const s of await db.collection("marketing_records").find({ orgId: o, kind: "send", email: normEmail(c.email) }).sort({ createdAt: -1 }).limit(50).project({ status: 1, openedAt: 1, clickedAt: 1, createdAt: 1, campaignId: 1 }).toArray())
    push({ type: "campaign", at: s.createdAt, title: `Email ${s.clickedAt ? "clicked" : s.openedAt ? "opened" : String(s.status)}`, ref: { campaignId: sid(s.campaignId) } });
  for (const a of await crmActivities.find({ orgId: o, contactId: c._id }).sort({ at: -1 }).limit(100).toArray())
    push({ type: a.type === "TASK" ? "task" : "note", at: a.at instanceof Date ? a.at.toISOString() : a.at, title: a.type ? String(a.type).toLowerCase() : "note", detail: clean(a.text || a.summary || a.subject || "", 200) || null });
  ev.sort((x, y) => String(y.at || "").localeCompare(String(x.at || "")));
  return { customer: profileView(c), events: ev.slice(0, Math.min(500, limit)) };
}

// ---------------------------------------------------------------- intelligence (8.5)
export async function intelligence({ orgId, membership, customerId }) {
  const c = await loadContact(orgId, membership, customerId); if (!c) return fail("Customer not found.", 404);
  const o = toObjectId(orgId); const { salesOrders, invoices } = await getOrgCollections(); const settings = await getSettings(orgId); const cur = settings.currency;
  const sales = await salesOrders.find({ orgId: o, contactId: c._id, channel: "POS", status: { $ne: "VOIDED" } }).toArray();
  const invs = canAccessFinance(membership) ? await invoices.find({ orgId: o, contactId: c._id, deletedAt: null, status: { $in: ["SENT", "OVERDUE", "PAID"] } }).toArray() : [];
  const buys = [...sales.map((s) => ({ at: s.completedAt, valueMinor: s.totals.totalMinor - (s.refundedMinor || 0), boughtMinor: s.totals.totalMinor, refundedMinor: s.refundedMinor || 0, channel: "till", lines: s.lines, currency: s.currency })),
    ...invs.map((i) => ({ at: i.issueDate, valueMinor: Math.round(i.total * 100), boughtMinor: Math.round(i.total * 100), refundedMinor: 0, channel: "orders/invoices", lines: [], currency: i.currency }))].filter((b) => b.currency === cur).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const excludedOtherCurrency = sales.length + invs.length - buys.length;
  if (!buys.length) return { customerId: sid(c._id), currency: cur, hasHistory: false, note: "No purchases yet, so there is nothing to measure.", definitions: DEFINITIONS };
  const total = buys.reduce((s, b) => s + b.valueMinor, 0); const n = buys.length; const first = Date.parse(buys[0].at), last = Date.parse(buys[n - 1].at);
  const months = Math.max(1, (last - first) / (30 * DAY)); const recencyDays = Math.floor((Date.now() - last) / DAY);
  const yr = buys.filter((b) => Date.now() - Date.parse(b.at) <= 365 * DAY); const f12 = yr.length; const m12 = yr.reduce((s, b) => s + b.valueMinor, 0);
  // M quintiles across the company's customers (12 months, till sales)
  const dist = (await salesOrders.aggregate([{ $match: { orgId: o, channel: "POS", status: { $ne: "VOIDED" }, contactId: { $ne: null }, completedAt: { $gte: new Date(Date.now() - 365 * DAY).toISOString() } } }, { $group: { _id: "$contactId", v: { $sum: { $subtract: ["$totals.totalMinor", { $ifNull: ["$refundedMinor", 0] }] } } } }]).toArray()).map((x) => x.v).sort((a, b) => a - b);
  const q = (p) => dist.length ? dist[Math.min(dist.length - 1, Math.floor(p * dist.length))] : 0;
  const R = recencyDays <= 30 ? 5 : recencyDays <= 60 ? 4 : recencyDays <= 120 ? 3 : recencyDays <= 240 ? 2 : 1;
  const F = f12 >= 12 ? 5 : f12 >= 6 ? 4 : f12 >= 3 ? 3 : f12 >= 2 ? 2 : f12 >= 1 ? 1 : 1;
  const M = m12 >= q(0.8) ? 5 : m12 >= q(0.6) ? 4 : m12 >= q(0.4) ? 3 : m12 >= q(0.2) ? 2 : 1;
  const label = R >= 4 && F >= 4 ? "Champion" : F >= 4 ? "Loyal" : R <= 2 && F >= 3 ? "At risk" : F <= 1 && R >= 4 ? "New" : R <= 2 && F <= 2 ? "Hibernating" : "Promising";
  const bought = buys.reduce((s, b) => s + b.boughtMinor, 0), refunded = buys.reduce((s, b) => s + b.refundedMinor, 0);
  const cat = new Map(); for (const b of buys) for (const l of b.lines || []) if (l.productType !== "GIFT_CARD") cat.set(l.category || "Uncategorised", (cat.get(l.category || "Uncategorised") || 0) + l.grossMinor);
  const affinity = [...cat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => ({ category: k, spend: fromMinor(v) }));
  const channels = buys.reduce((m, b) => ({ ...m, [b.channel]: (m[b.channel] || 0) + 1 }), {});
  const spanDays = (last - first) / DAY; const canForecast = n >= 3 && spanDays >= 90;
  const perYear = canForecast ? n / (spanDays / 365) : null;
  return { customerId: sid(c._id), currency: cur, hasHistory: true,
    totalSpend: fromMinor(total), orders: n, aov: fromMinor(Math.round(total / n)), frequencyPerMonth: r2(n / months), firstPurchase: buys[0].at, lastPurchase: buys[n - 1].at, recencyDays,
    rfm: { r: R, f: F, m: M, label }, repeatCustomer: n >= 2, refundRate: bought ? r2((refunded / bought) * 100) : 0, returns: sales.reduce((s, x) => s + (x.refunds?.length || 0), 0),
    affinity, atRisk: isAtRisk(c.commerce), channels, source: c.sourceChannel || null,
    lifetimeValue: { historical: fromMinor(total), estimate: canForecast ? fromMinor(Math.round((total / n) * perYear * 3)) : null, estimateNote: canForecast ? "Estimate: average sale × purchases per year × 3 years." : "Not enough history for an estimate (needs 3+ purchases over 90+ days)." },
    ...(excludedOtherCurrency ? { note: `${excludedOtherCurrency} purchase(s) in other currencies are not included.` } : {}), definitions: DEFINITIONS };
}
export const DEFINITIONS = {
  totalSpend: "Till sales minus refunds plus invoices issued (orders are counted once, as their invoice). Voided sales are excluded.",
  aov: "Total spend divided by the number of purchases.", frequency: "Purchases per month between the first and the latest purchase.",
  rfm: "Recency, frequency (12 months) and spend (12 months, against your other customers), each scored 1-5.",
  lifetimeValue: "What the customer has spent; a forward estimate only with 3+ purchases over 90+ days.", atRisk: "A repeat customer silent for more than twice their usual gap (and over 30 days).",
};

// ---------------------------------------------------------------- duplicates and merge (8.3)
export async function findDuplicates({ orgId, membership, limit = 100 }) {
  if (!canManageOrg(membership)) return fail("Only the owner or an admin can review duplicates.", 403);
  const { crmContacts } = await getOrgCollections();
  const rows = await crmContacts.find({ orgId: toObjectId(orgId), deletedAt: null, mergedInto: { $exists: false } }, { projection: { name: 1, company: 1, email: 1, phone: 1, billingAddress: 1, createdAt: 1 } }).limit(20000).toArray();
  const byEmail = new Map(), byPhone = new Map(), pairs = new Map();
  const add = (a, b, why, score) => { const k = [sid(a._id), sid(b._id)].sort().join(":"); const p = pairs.get(k) || { a, b, reasons: [], score: 0 }; if (!p.reasons.includes(why)) { p.reasons.push(why); p.score = Math.min(100, p.score + score); } pairs.set(k, p); };
  for (const r of rows) {
    const e = normEmail(r.email), ph = normPhone(r.phone);
    if (e) { for (const x of byEmail.get(e) || []) add(x, r, "same email", 70); byEmail.set(e, [...(byEmail.get(e) || []), r]); }
    if (ph) { for (const x of byPhone.get(ph) || []) add(x, r, "same phone", 50); byPhone.set(ph, [...(byPhone.get(ph) || []), r]); }
  }
  // name similarity only counts together with a second signal (company or address), never alone
  const byFirst = new Map(); for (const r of rows) { const k = normName(r.name).split(" ")[0]; if (k) byFirst.set(k, [...(byFirst.get(k) || []), r]); }
  for (const group of byFirst.values()) { if (group.length > 300) continue; for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) { const a = group[i], b = group[j]; if (sim(a.name, b.name) < 0.8) continue; const co = a.company && b.company && sim(a.company, b.company) >= 0.8; const ad = a.billingAddress && b.billingAddress && JSON.stringify(a.billingAddress) === JSON.stringify(b.billingAddress); if (co || ad) add(a, b, co ? "similar name and company" : "similar name and address", 40); } }
  const v = (x) => ({ id: sid(x._id), name: x.name, company: x.company || null, email: x.email || null, phone: x.phone || null, createdAt: x.createdAt });
  return { candidates: [...pairs.values()].sort((x, y) => y.score - x.score).slice(0, limit).map((p) => ({ a: v(p.a), b: v(p.b), reasons: p.reasons, confidence: p.score >= 70 ? "HIGH" : p.score >= 50 ? "MEDIUM" : "LOW" })) };
}

// every place that points at a CRM contact, and the field that does
const REFS = [
  ["salesOrders", "contactId"], ["invoices", "contactId"], ["crmDeals", "contactId"], ["crmActivities", "contactId"], ["supportTickets", "requester.contactId"],
];
const CC_REFS = [["g_points", "customerId"], ["g_card", "customerId"], ["g_member", "customerId"], ["c_cust_price", "customerId"], ["g_promo_use", "customerId"]];
export async function mergePreview({ orgId, membership, survivorId, duplicateId }) {
  if (!canManageOrg(membership)) return fail("Only the owner or an admin can merge customers.", 403);
  if (String(survivorId) === String(duplicateId)) return fail("Choose two different customers.");
  const cols = await getOrgCollections(); const o = toObjectId(orgId);
  const [s, d] = await Promise.all([cols.crmContacts.findOne({ _id: toObjectId(survivorId), orgId: o, deletedAt: null }), cols.crmContacts.findOne({ _id: toObjectId(duplicateId), orgId: o, deletedAt: null })]);
  if (!s || !d) return fail("Both customers must exist in this company.", 404); // cross-company merges are impossible: both are looked up inside this company
  if (s.mergedInto || d.mergedInto) return fail("One of these has already been merged.", 409);
  const counts = {}; for (const [col, f] of REFS) counts[col] = await cols[col].countDocuments({ orgId: o, [f]: d._id });
  const cc = await ccol(); for (const [k, f] of CC_REFS) counts[k] = await cc.countDocuments({ orgId: o, kind: k, [f]: d._id });
  const fill = Object.fromEntries(["email", "phone", "company", "taxId", "billingAddress", "shippingAddress"].filter((k) => !s[k] && d[k]).map((k) => [k, d[k]]));
  return { survivor: profileView(s), duplicate: profileView(d), moves: counts, fillsEmptyFields: fill, note: "The duplicate is kept as MERGED and can be restored with Undo." };
}
export async function mergeCustomers({ orgId, membership, actorEmail, survivorId, duplicateId, reason }) {
  const pv = await mergePreview({ orgId, membership, survivorId, duplicateId }); if (pv.error) return pv;
  const cols = await getOrgCollections(); const o = toObjectId(orgId); const s = toObjectId(survivorId), d = toObjectId(duplicateId); const cc = await ccol(); const now = nowIso();
  const moved = {};
  const { withStockTransaction } = await import("../inventory.js");
  await ensureCommerceIndexes();
  let mergeId;
  await withStockTransaction(async (session) => {
    for (const [col, f] of REFS) { const ids = (await cols[col].find({ orgId: o, [f]: d }, { projection: { _id: 1 }, session }).toArray()).map((x) => x._id); if (ids.length) await cols[col].updateMany({ _id: { $in: ids } }, { $set: { [f]: s } }, { session }); moved[col] = ids; }
    const keepOnSurvivor = new Set((await cc.find({ orgId: o, kind: "c_cust_price", customerId: s }, { projection: { productId: 1 }, session }).toArray()).map((x) => String(x.productId)));
    for (const [k, f] of CC_REFS) { const ids = (await cc.find({ orgId: o, kind: k, [f]: d }, { projection: { _id: 1, productId: 1 }, session }).toArray()).filter((x) => k !== "c_cust_price" || !keepOnSurvivor.has(String(x.productId))).map((x) => x._id); if (ids.length) await cc.updateMany({ _id: { $in: ids } }, { $set: { [f]: s } }, { session }); moved[k] = ids; }
    const dup = await cols.crmContacts.findOne({ _id: d }, { session });
    const inc = { "commerce.purchaseCount": dup.commerce?.purchaseCount || 0, "commerce.spendMinor": dup.commerce?.spendMinor || 0 };
    await cols.crmContacts.updateOne({ _id: s }, { $set: { ...pv.fillsEmptyFields, updatedAt: now }, $inc: inc, ...(dup.commerce?.firstPurchaseAt ? { $min: { "commerce.firstPurchaseAt": dup.commerce.firstPurchaseAt } } : {}), ...(dup.commerce?.lastPurchaseAt ? { $max: { "commerce.lastPurchaseAt": dup.commerce.lastPurchaseAt } } : {}) }, { session });
    await cols.crmContacts.updateOne({ _id: d }, { $set: { mergedInto: s, mergedAt: now, mergedBy: actorEmail, accountStatus: "MERGED" } }, { session });
    const r = await cc.insertOne({ orgId: o, kind: MERGE_KIND, survivorId: s, duplicateId: d, moved, filled: Object.keys(pv.fillsEmptyFields), statsMoved: inc, reason: clean(reason, 300) || null, by: actorEmail, at: now, undone: false }, { session });
    mergeId = r.insertedId;
  });
  await logOrgActivity({ orgId: o, recordType: "CRM_CONTACT", recordId: s, actorEmail, action: "CUSTOMERS_MERGED", previousState: null, newState: null, metadata: { duplicateId: sid(d), moves: Object.fromEntries(Object.entries(moved).map(([k, v]) => [k, v.length])), reason: reason || null } }).catch(() => {});
  return { mergeId: sid(mergeId), moved: Object.fromEntries(Object.entries(moved).map(([k, v]) => [k, v.length])) };
}
/** Undo: every moved reference goes back, the duplicate is restored, filled-in fields and stats are reverted. */
export async function undoMerge({ orgId, membership, actorEmail, mergeId }) {
  if (!canManageOrg(membership)) return fail("Only the owner or an admin can undo a merge.", 403);
  const cc = await ccol(); const cols = await getOrgCollections(); const o = toObjectId(orgId);
  const m = await cc.findOne({ _id: toObjectId(mergeId), orgId: o, kind: MERGE_KIND }); if (!m) return fail("Merge not found.", 404); if (m.undone) return fail("Already undone.", 409);
  const { withStockTransaction } = await import("../inventory.js");
  await withStockTransaction(async (session) => {
    for (const [col, f] of REFS) if (m.moved[col]?.length) await cols[col].updateMany({ _id: { $in: m.moved[col] }, orgId: o }, { $set: { [f]: m.duplicateId } }, { session });
    for (const [k, f] of CC_REFS) if (m.moved[k]?.length) await cc.updateMany({ _id: { $in: m.moved[k] }, orgId: o }, { $set: { [f]: m.duplicateId } }, { session });
    await cols.crmContacts.updateOne({ _id: m.survivorId }, { $inc: Object.fromEntries(Object.entries(m.statsMoved || {}).map(([k, v]) => [k, -v])), $unset: Object.fromEntries((m.filled || []).map((k) => [k, ""])) }, { session });
    await cols.crmContacts.updateOne({ _id: m.duplicateId }, { $unset: { mergedInto: "", mergedAt: "", mergedBy: "" }, $set: { accountStatus: "ACTIVE" } }, { session });
    const u = await cc.updateOne({ _id: m._id, undone: false }, { $set: { undone: true, undoneAt: nowIso(), undoneBy: actorEmail } }, { session }); if (!u.modifiedCount) throw Object.assign(new Error("Already undone."), { status: 409 });
  });
  await logOrgActivity({ orgId: o, recordType: "CRM_CONTACT", recordId: m.survivorId, actorEmail, action: "CUSTOMER_MERGE_UNDONE", previousState: null, newState: null, metadata: { mergeId: sid(m._id), duplicateId: sid(m.duplicateId) } }).catch(() => {});
  return { ok: true };
}
export async function listMerges({ orgId, membership }) {
  if (!canManageOrg(membership)) return fail("Only the owner or an admin can see merges.", 403);
  const cc = await ccol(); return { merges: (await cc.find({ orgId: toObjectId(orgId), kind: MERGE_KIND }).sort({ at: -1 }).limit(100).toArray()).map((m) => ({ id: sid(m._id), survivorId: sid(m.survivorId), duplicateId: sid(m.duplicateId), at: m.at, by: m.by, reason: m.reason, undone: m.undone, moved: Object.fromEntries(Object.entries(m.moved || {}).map(([k, v]) => [k, v.length])) })) };
}
