// src/lib/commerce/pricing.js -- Inaya Commerce, Batch 1 (Master SOW 6.4): price lists, customer-specific prices and the
// server-side pricing engine every sale goes through (the register's numbers are never trusted).
//
// Price precedence for a line: a manual override (if the user may override) > the customer's own price for the product >
// the price list in use (the customer's assigned list, else the one the cashier picked) > the product's unitPrice.
// Discounts: line and order level, fixed amount or percentage. Stacking policy "line_and_order" applies both (order
// discount spread over lines in proportion to their value, for correct tax); "best_only" keeps whichever is larger per
// line. Every discount and price override is checked against the role limits in commerce settings; anything beyond the
// actor's limit is returned in `approvals` and the sale cannot complete until a supervisor/manager approves it (sale.js).
// All amounts are integer minor units.
import { ccol, ensureCommerceIndexes, KINDS, fail, clean, nowIso, oid, sid, commerceAccess, audit, commerceRoleOf, getSettings, toMinor, fromMinor, emitCommerceEvent } from "./store.js";
import { loadTaxResolver, taxOn } from "./tax.js";
import { isSupportedCurrency } from "../currency.js";

// ---------------------------------------------------------------- price lists
const listView = (d) => ({ id: sid(d._id), code: d.code, name: d.name, currency: d.currency, active: d.active !== false, isWholesale: !!d.isWholesale });
export async function listPriceLists(orgId) { await ensureCommerceIndexes(); const c = await ccol(); return (await c.find({ orgId: oid(orgId), kind: KINDS.priceList }).sort({ name: 1 }).toArray()).map(listView); }
export async function savePriceList({ orgId, membership, actorEmail, id = null, code, name, currency, isWholesale = false, active = true }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const cd = clean(code, 20).toUpperCase(); const nm = clean(name, 80);
  if (!/^[A-Z0-9_-]{1,20}$/.test(cd) || !nm) return fail("A price list needs a code (1-20 letters/digits) and a name.");
  const settings = await getSettings(orgId); const cur = currency || settings.currency; if (!isSupportedCurrency(cur)) return fail("Unsupported currency.");
  await ensureCommerceIndexes(); const c = await ccol(); const now = nowIso();
  try {
    if (id) { const r = await c.findOneAndUpdate({ _id: oid(id), orgId: oid(orgId), kind: KINDS.priceList }, { $set: { code: cd, name: nm, currency: cur, isWholesale: !!isWholesale, active: active !== false, updatedAt: now } }, { returnDocument: "after" }); if (!r) return fail("Price list not found.", 404); return { priceList: listView(r) }; }
    const r = await c.insertOne({ orgId: oid(orgId), kind: KINDS.priceList, code: cd, name: nm, currency: cur, isWholesale: !!isWholesale, active: true, createdAt: now, createdBy: actorEmail });
    await audit({ orgId, actorEmail, recordType: "PRICE_LIST", recordId: r.insertedId, action: "PRICE_LIST_CREATED", newState: { code: cd, name: nm, currency: cur } });
    return { priceList: listView(await c.findOne({ _id: r.insertedId })) };
  } catch (e) { if (e?.code === 11000) return fail(`A price list with code ${cd} already exists.`, 409); throw e; }
}
/** Set (or remove with price null) a product's price in a list, or a customer's own price (customerId instead of priceListId). */
export async function setPrice({ orgId, membership, actorEmail, priceListId = null, customerId = null, productId, price }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  if (!!priceListId === !!customerId) return fail("Give either priceListId or customerId.");
  if (price !== null && !(Number.isFinite(price) && price >= 0)) return fail("price must be a non-negative number or null.");
  const { getOrgCollections } = await import("../orgs.js"); const { products, crmContacts } = await getOrgCollections();
  const product = await products.findOne({ _id: oid(productId), orgId: oid(orgId), deletedAt: null }); if (!product) return fail("Product not found.", 404);
  await ensureCommerceIndexes(); const c = await ccol(); const o = oid(orgId);
  let key;
  if (priceListId) { if (!(await c.findOne({ _id: oid(priceListId), orgId: o, kind: KINDS.priceList }))) return fail("Price list not found.", 404); key = { orgId: o, kind: KINDS.price, priceListId: oid(priceListId), productId: product._id }; }
  else { if (crmContacts && !(await crmContacts.findOne({ _id: oid(customerId), orgId: o }))) return fail("Customer not found.", 404); key = { orgId: o, kind: KINDS.custPrice, customerId: oid(customerId), productId: product._id }; }
  const before = await c.findOne(key);
  if (price === null) await c.deleteOne(key); else await c.updateOne(key, { $set: { priceMinor: toMinor(price), updatedAt: nowIso(), updatedBy: actorEmail }, $setOnInsert: key }, { upsert: true });
  const change = { productId: sid(product._id), sku: product.sku, priceListId: sid(priceListId), customerId: sid(customerId), from: before ? fromMinor(before.priceMinor) : null, to: price };
  await audit({ orgId, actorEmail, recordType: "PRODUCT", recordId: product._id, action: "PRICE_CHANGED", previousState: { price: change.from }, newState: change });
  await emitCommerceEvent({ orgId, name: "price.changed", entityId: product._id, actorEmail, source: "pricing", payload: { change } });
  return { ok: true, change };
}

// ---------------------------------------------------------------- the engine
const pct = (part, whole) => (whole > 0 ? (part * 100) / whole : 0);
function discountMinor(d, baseMinor) {
  if (!d || d.value === undefined || d.value === null || d.value === 0) return 0;
  if (d.type === "percent") { if (!(d.value > 0 && d.value <= 100)) throw Object.assign(new Error("A percentage discount must be between 0 and 100."), { status: 400 }); return Math.round((baseMinor * d.value) / 100); }
  if (d.type === "amount") { const m = toMinor(d.value); if (!(m > 0)) throw Object.assign(new Error("A discount amount must be positive."), { status: 400 }); return Math.min(m, baseMinor); }
  throw Object.assign(new Error("Discount type must be percent or amount."), { status: 400 });
}
/** The role needed for a discount of `percent` (or a price override), given the company limits. */
export function requiredRole(percent, settings) {
  if (percent <= settings.discountLimits.cashierPercent + 1e-9) return "cashier";
  if (percent <= settings.discountLimits.supervisorPercent + 1e-9) return "supervisor";
  return "manager";
}
const RANK = { cashier: 1, supervisor: 2, manager: 3 };
export const roleCovers = (role, needed) => (RANK[role] || 0) >= (RANK[needed] || 9);

/** Prices a cart on the server. Loads products, prices and tax once (optionally inside a transaction), then computes.
 *  input: { lines: [{ productId, quantity, priceOverride?, discount?: {type, value}, note? }], orderDiscount?, customerId?,
 *          priceListId?, warehouseId } -> { lines, totals, approvals, currency, taxMode } or { error, status }. */
export async function priceCart({ orgId, membership, input, session = null }) {
  const settings = await getSettings(orgId);
  const lines = Array.isArray(input?.lines) ? input.lines : [];
  if (!lines.length) return fail("The cart is empty.");
  if (lines.length > 500) return fail("A sale can have at most 500 lines.");
  const { getOrgCollections } = await import("../orgs.js"); const { products } = await getOrgCollections();
  const o = oid(orgId); const ids = [...new Set(lines.map((l) => String(l.productId)))].map(oid);
  if (ids.some((x) => !x)) return fail("A cart line has an invalid product.");
  const prods = new Map((await products.find({ _id: { $in: ids }, orgId: o, deletedAt: null }, { session }).toArray()).map((p) => [sid(p._id), p]));
  const c = await ccol();
  const custId = input.customerId ? oid(input.customerId) : null;
  const custPrices = custId ? new Map((await c.find({ orgId: o, kind: KINDS.custPrice, customerId: custId, productId: { $in: ids } }, { session }).toArray()).map((x) => [sid(x.productId), x.priceMinor])) : new Map();
  const listId = input.priceListId ? oid(input.priceListId) : null;
  if (listId) { const pl = await c.findOne({ _id: listId, orgId: o, kind: KINDS.priceList, active: { $ne: false } }, { session }); if (!pl) return fail("Price list not found or inactive.", 404); if (pl.currency !== settings.currency) return fail(`This price list is in ${pl.currency}; the register sells in ${settings.currency}.`); }
  const listPrices = listId ? new Map((await c.find({ orgId: o, kind: KINDS.price, priceListId: listId, productId: { $in: ids } }, { session }).toArray()).map((x) => [sid(x.productId), x.priceMinor])) : new Map();
  const taxOf = await loadTaxResolver(orgId, session);
  const role = commerceRoleOf(membership) || "cashier"; const approvals = [];
  const overrideRole = settings.allowPriceOverride === "never" ? null : settings.allowPriceOverride;

  const priced = [];
  try {
    for (const [i, l] of lines.entries()) {
      const p = prods.get(String(l.productId));
      if (!p) return fail(`Line ${i + 1}: product not found.`, 404);
      if (p.status && p.status !== "ACTIVE") return fail(`Line ${i + 1}: ${p.name} is not active.`, 409);
      if (p.availableWarehouseIds?.length && input.warehouseId && !p.availableWarehouseIds.includes(String(input.warehouseId))) return fail(`Line ${i + 1}: ${p.name} is not sold at this location.`, 409);
      const q = Number(l.quantity);
      if (!(Number.isFinite(q) && q > 0 && q <= 100000 && Math.round(q * 1000) === q * 1000)) return fail(`Line ${i + 1}: quantity must be positive (up to 3 decimals).`);
      const listMinor = custPrices.get(sid(p._id)) ?? listPrices.get(sid(p._id)) ?? (Number.isFinite(p.unitPrice) ? toMinor(p.unitPrice) : null);
      let unitMinor = listMinor; let priceSource = custPrices.has(sid(p._id)) ? "customer" : listPrices.has(sid(p._id)) ? "price_list" : "product";
      if (l.priceOverride !== undefined && l.priceOverride !== null) {
        const ov = toMinor(l.priceOverride); if (!(ov >= 0)) return fail(`Line ${i + 1}: override price must be zero or more.`);
        if (!overrideRole) return fail("Price overrides are switched off for this company.", 403, "OVERRIDE_DISABLED");
        if (!roleCovers(role, overrideRole)) approvals.push({ line: i, kind: "price_override", needed: overrideRole, from: listMinor === null ? null : fromMinor(listMinor), to: fromMinor(ov) });
        unitMinor = ov; priceSource = "override";
      }
      if (unitMinor === null) return fail(`Line ${i + 1}: ${p.name} has no price. Set one or enter an override.`, 409, "NO_PRICE");
      const baseMinor = Math.round(unitMinor * q);
      const lineDisc = discountMinor(l.discount, baseMinor);
      priced.push({ i, p, q, unitMinor, baseMinor, lineDisc, priceSource, note: clean(l.note, 300), tax: taxOf(p.taxCategoryId, input.warehouseId) });
    }
    // order discount, spread over lines by value (so tax is computed on what is really charged)
    // "line_and_order": the order discount applies to what is left after line discounts; "best_only": both are measured
    // on the undiscounted price and each line keeps the larger one.
    const bestOnly = settings.stacking === "best_only";
    const basis = (x) => (bestOnly ? x.baseMinor : x.baseMinor - x.lineDisc);
    const afterLine = priced.reduce((s, x) => s + basis(x), 0);
    const orderDisc = discountMinor(input.orderDiscount, afterLine);
    let spread = 0;
    priced.forEach((x, k) => {
      const share = k === priced.length - 1 ? orderDisc - spread : Math.floor(afterLine > 0 ? (basis(x) * orderDisc) / afterLine : 0);
      spread += share; x.orderShare = share;
      if (bestOnly) { const best = Math.max(x.lineDisc, x.orderShare); x.lineDisc = x.lineDisc >= x.orderShare ? best : 0; x.orderShare = x.lineDisc ? 0 : best; }
    });
    // Discount authority: each line's own discount, and the WHOLE sale's total discount, must be within the actor's limit
    // (so stacking a line discount and an order discount cannot exceed it either).
    for (const x of priced) {
      if (x.lineDisc > 0) { const percent = pct(x.lineDisc, x.baseMinor); const needed = requiredRole(percent, settings); if (!roleCovers(role, needed)) approvals.push({ line: x.i, kind: "discount", needed, percent: Math.round(percent * 100) / 100 }); }
    }
    const subtotal = priced.reduce((s, x) => s + x.baseMinor, 0); const allDisc = priced.reduce((s, x) => s + x.lineDisc + x.orderShare, 0);
    if (allDisc > 0) { const percent = pct(allDisc, subtotal); const needed = requiredRole(percent, settings); if (!roleCovers(role, needed) && !approvals.some((a) => a.kind === "discount" && a.needed === needed)) approvals.push({ line: null, kind: "sale_discount", needed, percent: Math.round(percent * 100) / 100 }); }
  } catch (e) { if (e.status) return fail(e.message, e.status); throw e; }

  // tax per line, then totals (per-line rounding, or one rounding on the total per tax category in "total" mode)
  const out = priced.map((x) => {
    const charged = x.baseMinor - x.lineDisc - x.orderShare; const t = taxOn(charged, x.tax.rate, settings.taxMode);
    return { productId: sid(x.p._id), sku: x.p.sku, name: x.p.name, productType: x.p.productType || "STOCK", quantity: x.q, unitPrice: fromMinor(x.unitMinor), priceSource: x.priceSource,
      lineDiscount: fromMinor(x.lineDisc), orderDiscountShare: fromMinor(x.orderShare), net: fromMinor(t.netMinor), tax: fromMinor(t.taxMinor), total: fromMinor(t.grossMinor),
      taxCategory: x.tax.code, taxRate: x.tax.rate, note: x.note || null, _m: { charged, ...t, base: x.baseMinor, disc: x.lineDisc + x.orderShare, rate: x.tax.rate, cat: x.tax.code, catName: x.tax.name } };
  });
  if (settings.rounding.mode === "total") {
    const byCat = new Map(); for (const l of out) { const k = `${l._m.cat}:${l._m.rate}`; byCat.set(k, [...(byCat.get(k) || []), l]); }
    for (const group of byCat.values()) {
      const exact = taxOn(group.reduce((s, l) => s + l._m.charged, 0), group[0]._m.rate, settings.taxMode).taxMinor; let diff = exact - group.reduce((s, l) => s + l._m.taxMinor, 0);
      const last = group[group.length - 1]; last._m.taxMinor += diff; if (settings.taxMode === "exclusive") last._m.grossMinor += diff; else last._m.netMinor -= diff;
      last.tax = fromMinor(last._m.taxMinor); last.total = fromMinor(last._m.grossMinor); last.net = fromMinor(last._m.netMinor);
    }
  }
  const sum = (k) => out.reduce((s, l) => s + l._m[k], 0);
  const taxBreakdown = [...out.reduce((m, l) => { const k = `${l._m.cat || "NONE"}@${l._m.rate}`; const v = m.get(k) || { category: l._m.cat, name: l._m.catName, rate: l._m.rate, taxableMinor: 0, taxMinor: 0 }; v.taxableMinor += l._m.netMinor; v.taxMinor += l._m.taxMinor; m.set(k, v); return m; }, new Map()).values()]
    .map((v) => ({ category: v.category, name: v.name, rate: v.rate, taxable: fromMinor(v.taxableMinor), tax: fromMinor(v.taxMinor) }));
  const totals = { subtotal: fromMinor(sum("base")), discounts: fromMinor(sum("disc")), net: fromMinor(sum("netMinor")), tax: fromMinor(sum("taxMinor")), total: fromMinor(sum("grossMinor")), totalMinor: sum("grossMinor"), cashTotal: fromMinor(cashRounded(sum("grossMinor"), settings.rounding?.cashIncrement || 0)), taxBreakdown };
  return { currency: settings.currency, taxMode: settings.taxMode, lines: out.map(({ _m, ...l }) => ({ ...l, _minor: _m })), totals, approvals, role };
}

/** Cash rounding for a cash tender (e.g. to the nearest 1.00): the amount the customer actually pays in cash. */
export function cashRounded(totalMinor, incrementMinor) { if (!incrementMinor) return totalMinor; return Math.round(totalMinor / incrementMinor) * incrementMinor; }
