// src/lib/growth/promotions.js -- Inaya Commerce Phase 4 (Master SOW 8.10): promotions and coupons.
//
// A promotion is set up as a DRAFT and must be APPROVED by a commerce manager (not its author) before it applies; it can
// be PAUSED or ENDED at any time (audited). Types:
//   PERCENT  x% off qualifying items            AMOUNT  fixed amount off the qualifying total
//   BOGO     buy N get M of the qualifying items (the cheapest M) at y% off (100 = free)
// Conditions: qualifying products and/or categories (empty = everything), minimum spend, first purchase only, customer
// types, a saved segment, member-only, branches, a date window, daily hours and weekdays, a coupon code, a total usage
// limit and a per-customer limit. Stacking: EXCLUSIVE promotions never combine (the best single one wins); STACKABLE ones
// combine with each other in priority order. Promotion discounts are pre-approved, so they don't need a cashier-limit
// approval; manual discounts still do. Each use is recorded once per sale (idempotent) and released if the sale is
// voided or fully refunded; usage limits are enforced with a guarded counter inside the sale transaction.
// Storage: calendar_records kinds g_promo and g_promo_use.
import { ccol, ensureCommerceIndexes, fail, clean, nowIso, oid, sid, commerceAccess, commerceRoleOf, audit, toMinor, fromMinor } from "../commerce/store.js";

export const KINDS = { promo: "g_promo", use: "g_promo_use" };
export const PROMO_TYPES = ["PERCENT", "AMOUNT", "BOGO"];

export function promoView(p) {
  return { id: sid(p._id), name: p.name, code: p.code || null, type: p.type, value: p.type === "AMOUNT" ? fromMinor(p.valueMinor) : p.value, buyQty: p.buyQty ?? null, getQty: p.getQty ?? null,
    productIds: p.productIds || [], categories: p.categories || [], minSpend: p.minSpendMinor ? fromMinor(p.minSpendMinor) : null, firstPurchaseOnly: !!p.firstPurchaseOnly, customerTypes: p.customerTypes || [],
    segmentId: p.segmentId || null, membersOnly: !!p.membersOnly, branchIds: p.branchIds || [], startsAt: p.startsAt || null, endsAt: p.endsAt || null, hours: p.hours || null,
    usageLimit: p.usageLimit ?? null, perCustomerLimit: p.perCustomerLimit ?? null, used: p.used || 0, stacking: p.stacking, priority: p.priority || 0, status: p.status,
    createdBy: p.createdBy, approvedBy: p.approvedBy || null, discountGiven: fromMinor(p.discountMinor || 0), sales: p.salesCount || 0, revenue: fromMinor(p.revenueMinor || 0) };
}

export function validatePromo(input = {}) {
  const name = clean(input.name, 80); if (!name) return fail("A promotion needs a name.");
  if (!PROMO_TYPES.includes(input.type)) return fail(`type must be ${PROMO_TYPES.join(", ")}.`);
  const out = { name, type: input.type, stacking: input.stacking === "STACKABLE" ? "STACKABLE" : "EXCLUSIVE", priority: Number(input.priority) || 0 };
  if (input.type === "PERCENT") { const v = Number(input.value); if (!(v > 0 && v <= 100)) return fail("Percent must be 1-100."); out.value = v; }
  if (input.type === "AMOUNT") { const v = toMinor(input.value); if (!(v > 0)) return fail("Amount must be positive."); out.valueMinor = v; }
  if (input.type === "BOGO") { const b = Number(input.buyQty), g = Number(input.getQty), v = input.value === undefined ? 100 : Number(input.value); if (!(Number.isInteger(b) && b >= 1 && Number.isInteger(g) && g >= 1 && v > 0 && v <= 100)) return fail("Buy/get quantities must be whole numbers and the discount 1-100%."); Object.assign(out, { buyQty: b, getQty: g, value: v }); }
  out.code = input.code ? clean(input.code, 30).toUpperCase().replace(/\s+/g, "") : null;
  if (out.code && !/^[A-Z0-9_-]{3,30}$/.test(out.code)) return fail("Coupon codes are 3-30 letters, numbers, - or _.");
  out.productIds = Array.isArray(input.productIds) ? input.productIds.slice(0, 500).map(String) : [];
  out.categories = Array.isArray(input.categories) ? input.categories.slice(0, 50).map((c) => clean(c, 80)).filter(Boolean) : [];
  out.minSpendMinor = input.minSpend ? toMinor(input.minSpend) : null;
  out.firstPurchaseOnly = input.firstPurchaseOnly === true; out.membersOnly = input.membersOnly === true;
  out.customerTypes = Array.isArray(input.customerTypes) ? input.customerTypes.filter((t) => ["INDIVIDUAL", "BUSINESS"].includes(t)) : [];
  out.segmentId = input.segmentId ? String(input.segmentId) : null;
  out.branchIds = Array.isArray(input.branchIds) ? input.branchIds.map(String).slice(0, 200) : [];
  for (const k of ["startsAt", "endsAt"]) if (input[k]) { if (Number.isNaN(Date.parse(input[k]))) return fail(`${k} must be a date.`); out[k] = new Date(input[k]).toISOString(); } else out[k] = null;
  if (out.startsAt && out.endsAt && out.endsAt <= out.startsAt) return fail("The end must be after the start.");
  if (input.hours) { const h = input.hours; const ok = /^\d{2}:\d{2}$/.test(h.from || "") && /^\d{2}:\d{2}$/.test(h.to || ""); if (!ok) return fail("Hours are HH:MM to HH:MM."); out.hours = { from: h.from, to: h.to, days: Array.isArray(h.days) ? h.days.filter((d) => d >= 0 && d <= 6) : [] }; } else out.hours = null;
  for (const k of ["usageLimit", "perCustomerLimit"]) { if (input[k] === undefined || input[k] === null || input[k] === "") out[k] = null; else { const v = Number(input[k]); if (!(Number.isInteger(v) && v >= 1)) return fail(`${k} must be a whole number.`); out[k] = v; } }
  return { promo: out };
}

export async function savePromotion({ orgId, membership, actorEmail, id, input }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const v = validatePromo(input); if (v.error) return v;
  await ensureCommerceIndexes(); const c = await ccol(); const o = oid(orgId); const now = nowIso();
  if (v.promo.code && await c.findOne({ orgId: o, kind: KINDS.promo, code: v.promo.code, status: { $in: ["DRAFT", "ACTIVE", "PAUSED"] }, ...(id ? { _id: { $ne: oid(id) } } : {}) })) return fail("Another live promotion uses that code.", 409);
  if (id) {
    const before = await c.findOne({ _id: oid(id), orgId: o, kind: KINDS.promo }); if (!before) return fail("Promotion not found.", 404);
    if (before.status !== "DRAFT") return fail("Only a draft can be edited. Pause/end this one and create a new draft.", 409);
    await c.updateOne({ _id: before._id }, { $set: { ...v.promo, updatedAt: now, updatedBy: actorEmail } });
    return { promotion: promoView(await c.findOne({ _id: before._id })) };
  }
  const r = await c.insertOne({ orgId: o, kind: KINDS.promo, ...v.promo, status: "DRAFT", used: 0, createdBy: actorEmail, createdAt: now });
  await audit({ orgId, actorEmail, recordType: "PROMOTION", recordId: r.insertedId, action: "PROMOTION_DRAFTED", newState: v.promo });
  return { promotion: promoView(await c.findOne({ _id: r.insertedId })) };
}
/** approve (a different manager) | pause | resume | end */
export async function transitionPromotion({ orgId, membership, actorEmail, id, action }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const c = await ccol(); const p = await c.findOne({ _id: oid(id), orgId: oid(orgId), kind: KINDS.promo }); if (!p) return fail("Promotion not found.", 404);
  const map = { approve: [["DRAFT"], "ACTIVE"], pause: [["ACTIVE"], "PAUSED"], resume: [["PAUSED"], "ACTIVE"], end: [["DRAFT", "ACTIVE", "PAUSED"], "ENDED"] }[action];
  if (!map) return fail("Unknown action.");
  if (!map[0].includes(p.status)) return fail(`This promotion is ${p.status.toLowerCase()}.`, 409);
  if (action === "approve" && p.createdBy === actorEmail) return fail("Another manager must approve a promotion you created.", 403, "SELF_APPROVAL");
  await c.updateOne({ _id: p._id, status: p.status }, { $set: { status: map[1], updatedAt: nowIso(), ...(action === "approve" ? { approvedBy: actorEmail, approvedAt: nowIso() } : {}) } });
  await audit({ orgId, actorEmail, recordType: "PROMOTION", recordId: p._id, action: `PROMOTION_${action.toUpperCase()}`, previousState: { status: p.status }, newState: { status: map[1] } });
  return { promotion: promoView(await c.findOne({ _id: p._id })) };
}
export async function listPromotions({ orgId, membership }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  const c = await ccol(); return { promotions: (await c.find({ orgId: oid(orgId), kind: KINDS.promo }).sort({ createdAt: -1 }).limit(300).toArray()).map(promoView) };
}

function inHours(hours, tz, when = new Date()) {
  if (!hours) return true;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz || "UTC", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(when).map((x) => [x.type, x.value]));
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday); const hm = `${parts.hour}:${parts.minute}`;
  if (hours.days?.length && !hours.days.includes(day)) return false;
  return hours.from <= hours.to ? hm >= hours.from && hm < hours.to : hm >= hours.from || hm < hours.to;
}

/** Works out which promotions apply to a priced cart and how much each line gets off. Read-only.
 *  lines: [{ i, p (product), q, unitMinor, remainMinor }] -- remainMinor = what's left after manual discounts. */
export async function evaluatePromotions({ orgId, lines, input, customer, settings, session = null, now = new Date() }) {
  const c = await ccol(); const o = oid(orgId);
  const codes = (Array.isArray(input.coupons) ? input.coupons : input.coupon ? [input.coupon] : []).map((x) => String(x).toUpperCase().trim()).filter(Boolean).slice(0, 5);
  const iso = now.toISOString();
  const live = await c.find({ orgId: o, kind: KINDS.promo, status: "ACTIVE", $and: [{ $or: [{ code: null }, { code: { $in: codes } }] }, { $or: [{ startsAt: null }, { startsAt: { $lte: iso } }] }, { $or: [{ endsAt: null }, { endsAt: { $gt: iso } }] }] }, { session }).toArray();
  const unknown = codes.filter((k) => !live.some((p) => p.code === k));
  const reasons = []; const candidates = [];
  let firstPurchase = null, member = null;
  for (const p of live) {
    const why = (t) => { if (p.code) reasons.push({ code: p.code, reason: t }); };
    if (p.usageLimit && (p.used || 0) >= p.usageLimit) { why("This offer has been fully used."); continue; }
    if (p.branchIds?.length && !p.branchIds.includes(String(input.warehouseId))) { why("Not valid at this branch."); continue; }
    if (!inHours(p.hours, settings.timezone)) { why("Not valid at this time."); continue; }
    if ((p.firstPurchaseOnly || p.perCustomerLimit || p.customerTypes?.length || p.segmentId || p.membersOnly) && !customer) { why("Choose the customer first."); continue; }
    if (p.customerTypes?.length && !p.customerTypes.includes(customer.customerType || "INDIVIDUAL")) { why("Not for this type of customer."); continue; }
    if (p.firstPurchaseOnly) { if (firstPurchase === null) firstPurchase = !(customer.commerce?.purchaseCount > 0); if (!firstPurchase) { why("Only for a customer's first purchase."); continue; } }
    if (p.membersOnly) { if (member === null) { const { activeMembership } = await import("./loyalty.js"); member = !!(await activeMembership(orgId, customer._id, session)); } if (!member) { why("Members only."); continue; } }
    if (p.perCustomerLimit) { const n = await c.countDocuments({ orgId: o, kind: KINDS.use, promoId: p._id, customerId: customer._id, reversed: { $ne: true } }, { session }); if (n >= p.perCustomerLimit) { why("Already used the maximum times."); continue; } }
    if (p.segmentId) { const { inSegment } = await import("./segments.js"); if (!(await inSegment(orgId, p.segmentId, customer))) { why("Not in the customer group for this offer."); continue; } }
    const qual = lines.filter((l) => (!p.productIds?.length && !p.categories?.length) || p.productIds?.includes(sid(l.p._id)) || (l.p.category && p.categories?.includes(l.p.category)));
    const qualTotal = qual.reduce((s, l) => s + l.remainMinor, 0); if (!qual.length || qualTotal <= 0) { why("Nothing in the basket qualifies."); continue; }
    if (p.minSpendMinor && lines.reduce((s, l) => s + l.remainMinor, 0) < p.minSpendMinor) { why(`Spend at least ${fromMinor(p.minSpendMinor)} first.`); continue; }
    const per = new Map();
    if (p.type === "PERCENT") for (const l of qual) per.set(l.i, Math.round((l.remainMinor * p.value) / 100));
    else if (p.type === "AMOUNT") { const amt = Math.min(p.valueMinor, qualTotal); let spread = 0; qual.forEach((l, k) => { const s = k === qual.length - 1 ? amt - spread : Math.floor((l.remainMinor * amt) / qualTotal); spread += s; per.set(l.i, s); }); }
    else if (p.type === "BOGO") {
      const units = []; for (const l of qual) { const unitRemain = l.remainMinor / l.q; for (let u = 0; u < Math.floor(l.q + 1e-9); u++) units.push({ i: l.i, v: unitRemain }); }
      const sets = Math.floor(units.length / (p.buyQty + p.getQty)); if (!sets) { why(`Add ${p.buyQty + p.getQty} qualifying items.`); continue; }
      units.sort((a, b) => a.v - b.v); for (const u of units.slice(0, sets * p.getQty)) per.set(u.i, (per.get(u.i) || 0) + Math.round((u.v * p.value) / 100));
    }
    const total = [...per.values()].reduce((a, b) => a + b, 0); if (total <= 0) continue;
    candidates.push({ p, per, total });
  }
  // stacking: best exclusive vs all stackables (priority order, each on what's left)
  const best = candidates.filter((x) => x.p.stacking === "EXCLUSIVE").sort((a, b) => b.total - a.total)[0] || null;
  const stack = candidates.filter((x) => x.p.stacking === "STACKABLE").sort((a, b) => (b.p.priority || 0) - (a.p.priority || 0));
  const stackTotal = stack.reduce((s, x) => s + x.total, 0);
  const chosen = best && best.total >= stackTotal ? [best] : stack;
  const remain = new Map(lines.map((l) => [l.i, l.remainMinor])); const applied = []; const perLine = new Map();
  for (const x of chosen) { let used = 0; for (const [i, v] of x.per) { const take = Math.min(v, remain.get(i)); remain.set(i, remain.get(i) - take); perLine.set(i, (perLine.get(i) || 0) + take); used += take; } if (used > 0) applied.push({ id: sid(x.p._id), name: x.p.name, code: x.p.code || null, discountMinor: used, stacking: x.p.stacking }); }
  for (const x of candidates) if (!chosen.includes(x) && x.p.code) reasons.push({ code: x.p.code, reason: "A better offer already applies (offers don't combine)." });
  return { applied, perLine, rejected: [...unknown.map((k) => ({ code: k, reason: "Unknown or expired code." })), ...reasons.filter((r) => !applied.some((a) => a.code === r.code))] };
}

/** Inside the sale transaction: count each applied promotion once (guarded usage limit) and record the use. */
export async function recordPromotionUses({ orgId, applied, saleId, customerId, revenueMinor, session }) {
  const c = await ccol(); const o = oid(orgId);
  for (const a of applied || []) {
    const p = await c.findOneAndUpdate({ _id: oid(a.id), orgId: o, kind: KINDS.promo, status: "ACTIVE", $or: [{ usageLimit: null }, { $expr: { $lt: [{ $ifNull: ["$used", 0] }, "$usageLimit"] } }] }, { $inc: { used: 1, discountMinor: a.discountMinor, salesCount: 1, revenueMinor } }, { session, returnDocument: "after" });
    if (!p) throw Object.assign(new Error(`The offer "${a.name}" just reached its limit or ended. Re-price the sale.`), { status: 409, code: "PROMO_GONE" });
    await c.insertOne({ orgId: o, kind: KINDS.use, promoId: p._id, saleId: oid(saleId), customerId: customerId || null, discountMinor: a.discountMinor, at: nowIso(), idem: `promo:${a.id}:${sid(saleId)}` }, { session });
  }
}
/** A voided or fully refunded sale gives its promotion uses back. */
export async function releasePromotionUses({ orgId, saleId, session }) {
  const c = await ccol(); const o = oid(orgId);
  for (const u of await c.find({ orgId: o, kind: KINDS.use, saleId: oid(saleId), reversed: { $ne: true } }, { session }).toArray()) {
    await c.updateOne({ _id: u._id, reversed: { $ne: true } }, { $set: { reversed: true, reversedAt: nowIso() } }, { session });
    await c.updateOne({ _id: u.promoId }, { $inc: { used: -1, discountMinor: -u.discountMinor, salesCount: -1 } }, { session });
  }
}
