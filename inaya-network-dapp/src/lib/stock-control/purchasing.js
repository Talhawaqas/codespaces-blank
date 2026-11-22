// src/lib/stock-control/purchasing.js -- Inaya Commerce Phase 3 (Master SOW 7.7 - 7.11): supplier catalogue, purchasing
// controls, landed cost, receiving discrepancies, supplier returns and supplier-document proposals.
//
// Costing method (documented before use, SOW 7.10): MOVING AVERAGE per product across locations. A receipt's unit cost =
// purchase price per stock unit + its share of the PO's landed charges (freight, insurance, duty, handling, other),
// allocated by line value (default) or by quantity, converted to the company's selling currency at the receipt date.
// Historical costs are never rewritten: landed charges are locked once the first goods are received, and every cost is
// stored on its movement. COGS/margins built on incomplete costs are labelled estimates in reports.
//
// Storage (no new collections): calendar_records kinds i_settings (one per company), i_supplier_item (supplier catalogue),
// i_supplier_return (returns to suppliers). Purchase orders keep living in purchase_orders.
import { getOrgCollections, toObjectId, canAccessDepartment, canManageOrg } from "../orgs.js";
import { recordStockMovement, withStockTransaction, StockError } from "../inventory.js";
import { logOrgActivity } from "../org-activity-log.js";
import { ccol, nextNumber, ensureCommerceIndexes } from "../commerce/store.js";

export const KINDS = { settings: "i_settings", supplierItem: "i_supplier_item", supplierReturn: "i_supplier_return" };
export const CHARGE_TYPES = ["FREIGHT", "INSURANCE", "DUTY", "HANDLING", "OTHER"];
const r4 = (n) => Math.round(n * 10000) / 10000; const r2 = (n) => Math.round(n * 100) / 100;
const fail = (error, status = 400, code) => ({ error, status, ...(code ? { code } : {}) });
const nowIso = () => new Date().toISOString();
const oid = toObjectId;

// ---------------------------------------------------------------- settings
export const DEFAULT_STOCK_SETTINGS = {
  // PO approval levels by order value in the company's selling currency: each level needs one approval from someone of
  // that role who hasn't approved an earlier level. Default = one admin/owner approval (the long-standing behaviour).
  poApprovalLevels: [{ above: 0, role: "admin" }],
  overReceiptPercent: 0, // receiving more than ordered is refused unless within this % of the line
  duplicatePoWindowHours: 24, // same supplier + same lines within this window needs confirmation
};
export async function getStockSettings(orgId) {
  const c = await ccol(); const s = await c.findOne({ orgId: oid(orgId), kind: KINDS.settings });
  return { ...DEFAULT_STOCK_SETTINGS, ...(s?.settings || {}) };
}
export async function updateStockSettings({ orgId, membership, actorEmail, input }) {
  if (!canManageOrg(membership)) return fail("Only the owner or an admin can change stock settings.", 403);
  const out = {};
  if (input.poApprovalLevels !== undefined) {
    const lv = input.poApprovalLevels;
    if (!Array.isArray(lv) || !lv.length || lv.length > 4 || !lv.every((l) => Number.isFinite(Number(l.above)) && Number(l.above) >= 0 && ["admin", "owner"].includes(l.role))) return fail("poApprovalLevels: 1-4 levels of { above: amount, role: admin|owner }.");
    out.poApprovalLevels = lv.map((l) => ({ above: Number(l.above), role: l.role })).sort((a, b) => a.above - b.above);
  }
  if (input.overReceiptPercent !== undefined) { const p = Number(input.overReceiptPercent); if (!(p >= 0 && p <= 50)) return fail("overReceiptPercent 0-50."); out.overReceiptPercent = p; }
  if (input.duplicatePoWindowHours !== undefined) { const h = Number(input.duplicatePoWindowHours); if (!(h >= 0 && h <= 720)) return fail("duplicatePoWindowHours 0-720."); out.duplicatePoWindowHours = h; }
  await ensureCommerceIndexes(); const c = await ccol(); const now = nowIso();
  await c.updateOne({ orgId: oid(orgId), kind: KINDS.settings }, { $set: Object.fromEntries(Object.entries(out).map(([k, v]) => [`settings.${k}`, v])), $setOnInsert: { orgId: oid(orgId), kind: KINDS.settings, createdAt: now } }, { upsert: true });
  await logOrgActivity({ orgId: oid(orgId), recordType: "STOCK_SETTINGS", recordId: oid(orgId), actorEmail, action: "STOCK_SETTINGS_CHANGED", previousState: null, newState: out, metadata: {} }).catch(() => {});
  return { settings: await getStockSettings(orgId) };
}

// ---------------------------------------------------------------- supplier catalogue (7.7)
export function supplierItemView(x) {
  return { id: String(x._id), supplierId: String(x.supplierId), productId: String(x.productId), supplierSku: x.supplierSku || null, price: x.price ?? null, currency: x.currency || null,
    leadTimeDays: x.leadTimeDays ?? null, moq: x.moq ?? null, orderMultiple: x.orderMultiple ?? null, preferred: !!x.preferred,
    priceHistory: (x.priceHistory || []).slice(-20), leadTimeHistory: (x.leadTimeHistory || []).slice(-20), avgLeadTimeDays: x.leadTimeHistory?.length ? r2(x.leadTimeHistory.reduce((n, h) => n + h.days, 0) / x.leadTimeHistory.length) : null };
}
export async function listSupplierItems({ orgId, supplierId, productId }) {
  const c = await ccol(); const q = { orgId: oid(orgId), kind: KINDS.supplierItem };
  if (supplierId) q.supplierId = oid(supplierId); if (productId) q.productId = oid(productId);
  return { items: (await c.find(q).limit(2000).toArray()).map(supplierItemView) };
}
export async function saveSupplierItem({ orgId, membership, actorEmail, input }) {
  const { suppliers, products } = await getOrgCollections(); const o = oid(orgId);
  const sup = await suppliers.findOne({ _id: oid(input.supplierId), orgId: o, deletedAt: null }); if (!sup) return fail("Supplier not found.", 404);
  if (!canAccessDepartment(membership, sup.departmentId)) return fail("You don't have access to this supplier.", 403);
  const prod = await products.findOne({ _id: oid(input.productId), orgId: o, deletedAt: null }); if (!prod) return fail("Product not found.", 404);
  const n = (v, k) => { if (v === undefined || v === null || v === "") return null; const x = Number(v); if (!(x >= 0)) throw new Error(`${k} must be zero or more.`); return x; };
  let f; try { f = { price: n(input.price, "price"), leadTimeDays: n(input.leadTimeDays, "leadTimeDays"), moq: n(input.moq, "moq"), orderMultiple: n(input.orderMultiple, "orderMultiple") }; } catch (e) { return fail(e.message); }
  const currency = String(input.currency || "").toUpperCase() || null;
  await ensureCommerceIndexes(); const c = await ccol(); const now = nowIso();
  const before = await c.findOne({ orgId: o, kind: KINDS.supplierItem, supplierId: sup._id, productId: prod._id });
  const push = before && f.price !== null && f.price !== before.price ? { priceHistory: { price: f.price, currency, at: now, by: actorEmail } } : (!before && f.price !== null ? { priceHistory: { price: f.price, currency, at: now, by: actorEmail } } : null);
  await c.updateOne({ orgId: o, kind: KINDS.supplierItem, supplierId: sup._id, productId: prod._id }, { $set: { supplierSku: String(input.supplierSku || "").trim().slice(0, 60) || null, ...f, currency, preferred: input.preferred === true, updatedAt: now, updatedBy: actorEmail }, $setOnInsert: { orgId: o, kind: KINDS.supplierItem, supplierId: sup._id, productId: prod._id, createdAt: now }, ...(push ? { $push: push } : {}) }, { upsert: true });
  if (input.preferred === true) {
    await c.updateMany({ orgId: o, kind: KINDS.supplierItem, productId: prod._id, supplierId: { $ne: sup._id } }, { $set: { preferred: false } });
    await products.updateOne({ _id: prod._id }, { $set: { preferredSupplierId: String(sup._id) } });
  }
  return { item: supplierItemView(await c.findOne({ orgId: o, kind: KINDS.supplierItem, supplierId: sup._id, productId: prod._id })) };
}
/** MOQ / multiples / price checks for PO lines: warnings, never silent changes. */
export async function poLineWarnings({ orgId, supplierId, items }) {
  const c = await ccol(); const out = [];
  for (const [i, it] of (items || []).entries()) {
    if (!it.productId) continue;
    const si = await c.findOne({ orgId: oid(orgId), kind: KINDS.supplierItem, supplierId: oid(supplierId), productId: oid(it.productId) });
    if (!si) continue;
    if (si.moq && it.quantity < si.moq) out.push({ line: i, kind: "BELOW_MOQ", message: `Line ${i + 1}: the supplier's minimum order is ${si.moq}.` });
    if (si.orderMultiple && Math.abs(it.quantity / si.orderMultiple - Math.round(it.quantity / si.orderMultiple)) > 1e-9) out.push({ line: i, kind: "NOT_MULTIPLE", message: `Line ${i + 1}: the supplier sells in multiples of ${si.orderMultiple}.` });
    if (si.price !== null && si.price !== undefined && Math.abs(Number(it.unitPrice) - si.price) > 0.005) out.push({ line: i, kind: "PRICE_DIFFERS", message: `Line ${i + 1}: catalogue price is ${si.price}${si.currency ? ` ${si.currency}` : ""}.` });
  }
  return out;
}

// ---------------------------------------------------------------- duplicate PO guard (7.8)
export async function findDuplicatePo({ orgId, supplierId, items, excludeId = null }) {
  const s = await getStockSettings(orgId); if (!s.duplicatePoWindowHours) return null;
  const { purchaseOrders } = await getOrgCollections();
  const since = new Date(Date.now() - s.duplicatePoWindowHours * 3600000).toISOString();
  const sig = (its) => JSON.stringify((its || []).map((i) => [String(i.productId || i.description || "").toLowerCase(), Number(i.quantity)]).sort());
  const mine = sig(items);
  for (const po of await purchaseOrders.find({ orgId: oid(orgId), supplierId: oid(supplierId), deletedAt: null, createdAt: { $gte: since }, status: { $nin: ["CANCELLED", "REJECTED"] }, ...(excludeId ? { _id: { $ne: oid(excludeId) } } : {}) }).toArray())
    if (sig(po.items) === mine) return po;
  return null;
}

// ---------------------------------------------------------------- multi-level approval (7.8)
/** Which approvals a PO needs, in the company's selling currency. */
export async function requiredPoApprovals(orgId, po) {
  const s = await getStockSettings(orgId);
  const { computePoTotals } = await import("../purchase-order-totals.js");
  const total = computePoTotals(po).total + landedTotal(po);
  const { getSettings } = await import("../commerce/store.js"); const sell = (await getSettings(orgId).catch(() => null))?.currency || null;
  let value = total; const from = po.currency || "USD";
  if (sell && from !== sell) { const { convert } = await import("../currency.js"); const cv = convert(total, from, sell); if (Number.isFinite(cv?.convertedAmount)) value = cv.convertedAmount; }
  return { value: r2(value), currency: sell || from, levels: s.poApprovalLevels.filter((l, i) => i === 0 || value > l.above) };
}

// ---------------------------------------------------------------- landed cost (7.10)
export const landedTotal = (po) => r2((po.landedCharges || []).reduce((n, c) => n + c.amount, 0));
export function validateCharges(charges) {
  if (!Array.isArray(charges) || charges.length > 20) return { error: "Up to 20 charges." };
  const out = [];
  for (const c of charges) {
    if (!CHARGE_TYPES.includes(c.type)) return { error: `Charge type must be one of ${CHARGE_TYPES.join(", ")}.` };
    const a = Number(c.amount); if (!(a >= 0)) return { error: "Each charge needs an amount of zero or more." };
    const allocation = c.allocation === "QUANTITY" ? "QUANTITY" : "VALUE";
    out.push({ type: c.type, amount: r2(a), allocation, note: String(c.note || "").slice(0, 120) || null });
  }
  return { charges: out };
}
export async function setLandedCharges({ orgId, membership, actorEmail, poId, charges }) {
  const { purchaseOrders } = await getOrgCollections();
  const po = await purchaseOrders.findOne({ _id: oid(poId), orgId: oid(orgId), deletedAt: null }); if (!po) return fail("Purchase order not found.", 404);
  if (!canAccessDepartment(membership, po.departmentId)) return fail("You don't have permission to do that.", 403);
  if ((po.items || []).some((i) => (i.receivedQuantity || 0) > 0)) return fail("Goods have been received, so the landed charges are locked (historical costs are never rewritten).", 409, "LANDED_LOCKED");
  if (["CANCELLED", "REJECTED", "RECEIVED"].includes(po.status)) return fail("This purchase order is closed.", 409);
  const v = validateCharges(charges); if (v.error) return fail(v.error);
  const r = await purchaseOrders.findOneAndUpdate({ _id: po._id, "items.receivedQuantity": { $not: { $gt: 0 } } }, { $set: { landedCharges: v.charges, updatedAt: nowIso() } }, { returnDocument: "after" });
  if (!r) return fail("Goods were received meanwhile; charges are locked.", 409, "LANDED_LOCKED");
  await logOrgActivity({ orgId: oid(orgId), recordType: "PURCHASE_ORDER", recordId: po._id, actorEmail, action: "PO_LANDED_CHARGES_SET", previousState: null, newState: null, metadata: { before: po.landedCharges || [], after: v.charges } }).catch(() => {});
  return { po: r, allocation: allocateLanded(r) };
}
/** Extra cost per PURCHASE unit for each line, from the landed charges (value- or quantity-weighted). */
export function allocateLanded(po) {
  const items = po.items || []; const per = items.map(() => 0);
  const valueSum = items.reduce((n, i) => n + i.quantity * i.unitPrice, 0); const qtySum = items.reduce((n, i) => n + i.quantity, 0);
  const shipping = Number.isFinite(po.shippingCost) && po.shippingCost > 0 ? [{ type: "FREIGHT", amount: po.shippingCost, allocation: "VALUE" }] : [];
  for (const ch of [...shipping, ...(po.landedCharges || [])]) {
    for (const [k, i] of items.entries()) {
      const share = ch.allocation === "QUANTITY" ? (qtySum ? i.quantity / qtySum : 0) : (valueSum ? (i.quantity * i.unitPrice) / valueSum : (qtySum ? i.quantity / qtySum : 0));
      per[k] += i.quantity ? (ch.amount * share) / i.quantity : 0;
    }
  }
  return per.map(r4);
}

// ---------------------------------------------------------------- amendments (7.8)
/** Amend an ordered PO (quantities, prices, expected date) with a reason; each amendment is kept with before/after. */
export async function amendPurchaseOrder({ orgId, membership, actorEmail, poId, input }) {
  const { purchaseOrders } = await getOrgCollections();
  const po = await purchaseOrders.findOne({ _id: oid(poId), orgId: oid(orgId), deletedAt: null }); if (!po) return fail("Purchase order not found.", 404);
  if (!canAccessDepartment(membership, po.departmentId)) return fail("You don't have permission to do that.", 403);
  if (!["APPROVED", "ORDERED", "PARTIALLY_RECEIVED"].includes(po.status)) return fail("Only an approved or ordered purchase order is amended (edit a draft directly).", 409);
  const reason = String(input.reason || "").trim(); if (reason.length < 3) return fail("Give a reason for the amendment.");
  const items = po.items.map((i) => ({ ...i })); const changes = [];
  for (const ch of input.items || []) {
    const i = Number(ch.itemIndex); const it = items[i]; if (!it) return fail("Unknown line.");
    if (ch.quantity !== undefined) { const q = Number(ch.quantity); if (!(q > 0) || q < (it.receivedQuantity || 0)) return fail(`Line ${i + 1}: quantity must be at least what was already received (${it.receivedQuantity || 0}).`); changes.push({ line: i, field: "quantity", from: it.quantity, to: q }); it.quantity = q; }
    if (ch.unitPrice !== undefined) { const p = Number(ch.unitPrice); if (!(p >= 0)) return fail("Prices must be zero or more."); if ((it.receivedQuantity || 0) > 0) return fail(`Line ${i + 1} has received goods; its price is locked.`); changes.push({ line: i, field: "unitPrice", from: it.unitPrice, to: p }); it.unitPrice = p; }
  }
  const set = { items, updatedAt: nowIso() };
  if (input.expectedDeliveryDate !== undefined) { changes.push({ field: "expectedDeliveryDate", from: po.expectedDeliveryDate || null, to: input.expectedDeliveryDate || null }); set.expectedDeliveryDate = input.expectedDeliveryDate ? String(input.expectedDeliveryDate).slice(0, 10) : null; }
  if (!changes.length) return fail("Nothing to change.");
  const full = items.every((i) => (i.receivedQuantity || 0) >= i.quantity); if (full && po.status === "PARTIALLY_RECEIVED") set.status = "RECEIVED";
  const r = await purchaseOrders.findOneAndUpdate({ _id: po._id, updatedAt: po.updatedAt }, { $set: set, $push: { amendments: { no: (po.amendments || []).length + 1, reason, changes, by: actorEmail, at: set.updatedAt } } }, { returnDocument: "after" });
  if (!r) return fail("This purchase order changed; reload.", 409);
  await logOrgActivity({ orgId: oid(orgId), recordType: "PURCHASE_ORDER", recordId: po._id, actorEmail, action: "PO_AMENDED", previousState: po.status, newState: r.status, metadata: { reason, changes } }).catch(() => {});
  return { po: r };
}

// ---------------------------------------------------------------- supplier returns and credits (7.7)
export async function createSupplierReturn({ orgId, membership, actorEmail, input }) {
  const { suppliers, products, warehouses } = await getOrgCollections(); const o = oid(orgId);
  const sup = await suppliers.findOne({ _id: oid(input.supplierId), orgId: o, deletedAt: null }); if (!sup) return fail("Supplier not found.", 404);
  if (!canAccessDepartment(membership, sup.departmentId)) return fail("You don't have access to this supplier.", 403);
  const wh = await warehouses.findOne({ _id: oid(input.warehouseId), orgId: o }); if (!wh) return fail("Location not found.", 404);
  const reason = String(input.reason || "").trim(); if (reason.length < 3) return fail("Give a reason (e.g. faulty batch).");
  if (!Array.isArray(input.lines) || !input.lines.length) return fail("Add the items going back.");
  const lines = [];
  for (const l of input.lines) {
    const p = await products.findOne({ _id: oid(l.productId), orgId: o, deletedAt: null }); if (!p) return fail("Product not found.", 404);
    const q = Number(l.quantity); if (!(q > 0)) return fail("Quantities must be positive.");
    lines.push({ productId: p._id, sku: p.sku, name: p.name, quantity: q, unitCost: Number.isFinite(Number(l.unitCost)) ? Number(l.unitCost) : (p.avgCost ?? p.costPrice ?? null), lotNumber: l.lotNumber || null });
  }
  await ensureCommerceIndexes(); const c = await ccol(); const now = nowIso();
  const doc = { orgId: o, kind: KINDS.supplierReturn, number: `SR-${String(await nextNumber(orgId, "supplier_return")).padStart(5, "0")}`, status: "DRAFT", supplierId: sup._id, supplierName: sup.name, warehouseId: wh._id, poId: input.poId ? oid(input.poId) : null, reason, lines, value: r2(lines.reduce((n, l) => n + (l.unitCost || 0) * l.quantity, 0)), createdBy: actorEmail, createdAt: now, history: [{ to: "DRAFT", by: actorEmail, at: now }] };
  const r = await c.insertOne(doc);
  return { supplierReturn: { ...doc, id: String(r.insertedId) } };
}
/** send: stock leaves (SUPPLIER_RETURN movements) | credit { amount, reference, settlement: CREDIT_NOTE|REFUND|REPLACEMENT } | cancel (draft only) */
export async function transitionSupplierReturn({ orgId, membership, actorEmail, returnId, action, input = {} }) {
  const c = await ccol(); const o = oid(orgId);
  const x = await c.findOne({ _id: oid(returnId), orgId: o, kind: KINDS.supplierReturn }); if (!x) return fail("Supplier return not found.", 404);
  const now = nowIso();
  if (action === "send") {
    if (x.status !== "DRAFT") return fail("Only a draft return can be sent.", 409);
    try {
      await withStockTransaction(async (session) => {
        for (const [i, l] of x.lines.entries()) {
          const mv = await recordStockMovement({ orgId, productId: l.productId, warehouseId: x.warehouseId, delta: -l.quantity, type: "SUPPLIER_RETURN", lotNumber: l.lotNumber || undefined, relatedPurchaseOrderId: x.poId || undefined, reason: x.reason, note: `Return ${x.number} to ${x.supplierName}`, actorEmail, session, idempotencyKey: `sr:${x._id}:${i}` });
          if (mv.error) throw Object.assign(new Error(`${l.name}: ${mv.error}`), { status: mv.status || 409 });
        }
        const r = await c.updateOne({ _id: x._id, status: "DRAFT" }, { $set: { status: "SENT", sentAt: now, sentBy: actorEmail }, $push: { history: { to: "SENT", by: actorEmail, at: now } } }, { session });
        if (!r.modifiedCount) throw Object.assign(new Error("This return changed; reload."), { status: 409 });
      });
    } catch (e) { if (e instanceof StockError || e.status) return fail(e.message, e.status || 409); throw e; }
  } else if (action === "credit") {
    if (x.status !== "SENT") return fail("Record the credit after the goods were sent back.", 409);
    const amount = Number(input.amount); if (!(amount >= 0)) return fail("Credit amount must be zero or more.");
    const settlement = ["CREDIT_NOTE", "REFUND", "REPLACEMENT"].includes(input.settlement) ? input.settlement : null; if (!settlement) return fail("Settlement must be CREDIT_NOTE, REFUND or REPLACEMENT.");
    await c.updateOne({ _id: x._id, status: "SENT" }, { $set: { status: "CREDITED", credit: { amount: r2(amount), settlement, reference: String(input.reference || "").slice(0, 120) || null, at: now, by: actorEmail } }, $push: { history: { to: "CREDITED", by: actorEmail, at: now } } });
  } else if (action === "cancel") {
    if (x.status !== "DRAFT") return fail("Only a draft can be cancelled.", 409);
    await c.updateOne({ _id: x._id }, { $set: { status: "CANCELLED" }, $push: { history: { to: "CANCELLED", by: actorEmail, at: now } } });
  } else return fail("Unknown action.");
  await logOrgActivity({ orgId: o, recordType: "SUPPLIER_RETURN", recordId: x._id, actorEmail, action: `SUPPLIER_RETURN_${action.toUpperCase()}`, previousState: x.status, newState: null, metadata: { number: x.number, ...(action === "credit" ? { amount: input.amount, settlement: input.settlement } : {}) } }).catch(() => {});
  const y = await c.findOne({ _id: x._id });
  return { supplierReturn: { ...y, id: String(y._id) } };
}
export async function listSupplierReturns({ orgId, supplierId }) {
  const c = await ccol(); const rows = await c.find({ orgId: oid(orgId), kind: KINDS.supplierReturn, ...(supplierId ? { supplierId: oid(supplierId) } : {}) }).sort({ createdAt: -1 }).limit(200).toArray();
  const credited = rows.filter((r) => r.status === "CREDITED");
  return { returns: rows.map((r) => ({ ...r, id: String(r._id) })), outstandingValue: r2(rows.filter((r) => r.status === "SENT").reduce((n, r) => n + r.value, 0)), creditedValue: r2(credited.reduce((n, r) => n + (r.credit?.amount || 0), 0)) };
}

// ---------------------------------------------------------------- supplier document intelligence (7.11)
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function similarity(a, b) { const A = new Set(norm(a).split(" ").filter(Boolean)), B = new Set(norm(b).split(" ").filter(Boolean)); if (!A.size || !B.size) return 0; let n = 0; for (const t of A) if (B.has(t)) n++; return n / Math.max(A.size, B.size); }
/** From an extracted supplier invoice (AI Bookkeeper document): proposes product matches for each line. Document text is
 *  treated as data only -- matching is deterministic (supplier SKU, own SKU/barcode, then word overlap); nothing is
 *  created here. */
export async function proposeFromSupplierDocument({ orgId, membership, documentId, supplierId }) {
  const { bkDocuments, products, suppliers } = await getOrgCollections(); const o = oid(orgId);
  const doc = await bkDocuments.findOne({ _id: oid(documentId), orgId: o }); if (!doc) return fail("Document not found.", 404);
  if (!canAccessDepartment(membership, doc.departmentId)) return fail("You don't have access to this document.", 403);
  const sup = supplierId ? await suppliers.findOne({ _id: oid(supplierId), orgId: o, deletedAt: null }) : (doc.vendorId ? await suppliers.findOne({ _id: doc.vendorId, orgId: o }) : null);
  const c = await ccol(); const cat = sup ? await c.find({ orgId: o, kind: KINDS.supplierItem, supplierId: sup._id }).toArray() : [];
  const prods = await products.find({ orgId: o, deletedAt: null }, { projection: { name: 1, sku: 1, barcode: 1, unitPrice: 1 } }).limit(5000).toArray();
  const byId = new Map(prods.map((p) => [String(p._id), p]));
  const lines = (doc.lineItems || []).slice(0, 200).map((li, i) => {
    const text = String(li.description || ""); const padded = ` ${norm(text)} `; const has = (code) => !!norm(code) && padded.includes(` ${norm(code)} `);
    let match = null, how = null, score = 0;
    const s1 = cat.find((x) => x.supplierSku && has(x.supplierSku)); if (s1 && byId.get(String(s1.productId))) { match = byId.get(String(s1.productId)); how = "supplier SKU"; score = 1; }
    if (!match) { const s2 = prods.find((p) => has(p.sku) || (p.barcode && has(p.barcode))); if (s2) { match = s2; how = "SKU/barcode"; score = 0.95; } }
    if (!match) { let best = null, bs = 0; for (const p of prods) { const sc = similarity(text, p.name); if (sc > bs) { bs = sc; best = p; } } if (best && bs >= 0.5) { match = best; how = "name"; score = Math.round(bs * 100) / 100; } }
    return { line: i, description: text.slice(0, 160), quantity: li.quantity ?? null, unitPrice: li.unitPrice ?? null, amount: li.amount ?? null, match: match ? { productId: String(match._id), sku: match.sku, name: match.name, how, confidence: score } : null };
  });
  return { documentId: String(doc._id), supplier: sup ? { id: String(sup._id), name: sup.name } : null, invoiceNumber: doc.fields?.invoiceNumber?.value || null, currency: doc.fields?.currency?.value || null, total: doc.fields?.total?.value ?? null, lines,
    unmatched: lines.filter((l) => !l.match).length, note: "Proposal only. Review each line; nothing is created until you approve it." };
}
/** Compares a supplier invoice with what was ordered and received on a PO: quantities and prices (7.9 / 7.11). */
export async function matchInvoiceToPo({ orgId, membership, documentId, poId }) {
  const { purchaseOrders } = await getOrgCollections();
  const po = await purchaseOrders.findOne({ _id: oid(poId), orgId: oid(orgId), deletedAt: null }); if (!po) return fail("Purchase order not found.", 404);
  const prop = await proposeFromSupplierDocument({ orgId, membership, documentId, supplierId: String(po.supplierId) }); if (prop.error) return prop;
  const rows = prop.lines.map((l) => {
    const i = l.match ? po.items.findIndex((it) => String(it.productId) === l.match.productId) : -1; const it = po.items[i];
    if (!it) return { ...l, status: "NOT_ON_PO" };
    const issues = [];
    if (l.quantity != null && Math.abs(l.quantity - (it.receivedQuantity || 0)) > 1e-9) issues.push(`invoiced ${l.quantity}, received ${it.receivedQuantity || 0}`);
    if (l.unitPrice != null && Math.abs(l.unitPrice - it.unitPrice) > 0.005) issues.push(`invoice price ${l.unitPrice}, PO price ${it.unitPrice}`);
    return { ...l, poLine: i, ordered: it.quantity, received: it.receivedQuantity || 0, poPrice: it.unitPrice, status: issues.length ? "MISMATCH" : "MATCHED", issues };
  });
  return { poId: String(po._id), invoiceNumber: prop.invoiceNumber, lines: rows, matched: rows.filter((r) => r.status === "MATCHED").length, problems: rows.filter((r) => r.status !== "MATCHED").length };
}

/** After review, the approved lines of a supplier-document proposal become a DRAFT purchase order (never ordered, received
 *  or paid automatically -- the normal approval flow follows). The source document is referenced on the order. */
export async function draftPoFromProposal({ orgId, membership, actorEmail, documentId, input }) {
  const { purchaseOrders, suppliers, warehouses, products, departments } = await getOrgCollections(); const o = oid(orgId);
  const sup = await suppliers.findOne({ _id: oid(input.supplierId), orgId: o, deletedAt: null }); if (!sup) return fail("Supplier not found.", 404);
  const dep = await departments.findOne({ _id: oid(input.departmentId || sup.departmentId), orgId: o }); if (!dep) return fail("Department not found.", 404);
  if (!canAccessDepartment(membership, dep._id)) return fail("You don't have access to this department.", 403);
  const wh = await warehouses.findOne({ _id: oid(input.warehouseId), orgId: o }); if (!wh) return fail("Choose the receiving location.", 404);
  if (!Array.isArray(input.lines) || !input.lines.length) return fail("Approve at least one line.");
  const items = [];
  for (const l of input.lines) {
    const p = await products.findOne({ _id: oid(l.productId), orgId: o, deletedAt: null }); if (!p) return fail("A matched product wasn't found.", 404);
    const q = Number(l.quantity), u = Number(l.unitPrice); if (!(q > 0) || !(u >= 0)) return fail("Each line needs a quantity and a price.");
    items.push({ description: p.name, sku: p.sku, productId: p._id, warehouseId: wh._id, quantity: q, unitPrice: u, receivedQuantity: 0 });
  }
  const { applyPurchaseUnits } = await import("../inventory-units.js"); await applyPurchaseUnits(orgId, items);
  const now = nowIso();
  const doc = { orgId: o, departmentId: dep._id, supplierId: sup._id, sourceRequestId: null, items, currency: String(input.currency || "USD").toUpperCase(), status: "DRAFT", sourceDocumentId: oid(documentId), createdByEmail: actorEmail, createdAt: now, updatedAt: now, deletedAt: null, landedCharges: [] };
  const r = await purchaseOrders.insertOne(doc);
  await logOrgActivity({ orgId: o, recordType: "PURCHASE_ORDER", recordId: r.insertedId, actorEmail, action: "PO_DRAFTED_FROM_DOCUMENT", previousState: null, newState: "DRAFT", metadata: { documentId: String(documentId), lines: items.length } }).catch(() => {});
  return { poId: String(r.insertedId), status: "DRAFT" };
}
