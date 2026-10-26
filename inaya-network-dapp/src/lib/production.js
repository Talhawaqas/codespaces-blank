// src/lib/production.js
//
// Bills of materials and production orders (light manufacturing).
//
// A BOM says what one run of a finished product is made from: outputQuantity
// units of productId from components [{ productId, quantity }]. A production
// order makes `quantity` units of a product from a warehouse's stock:
// PLANNED -> IN_PROGRESS (components checked) -> COMPLETED, or CANCELLED.
// Completing it goes through the stock ledger (recordStockMovement): every
// component is CONSUMEd (batch-tracked ones earliest-expiry-first) and the
// finished goods are PRODUCEd into a batch, and the order keeps which
// component batches went into which finished batch, so a recall can be traced
// in both directions. Planning totals what open orders need against stock and
// can draft purchase requests for the shortfall (one per component, never a
// second one while an earlier request is still open).

import { getOrgCollections, toObjectId, canAccessDepartment } from "./orgs.js";
import { recordStockMovement, getStockLevel } from "./inventory.js";
import { findOpenReorderRequest } from "./inventory-reorder.js";
import { logOrgActivity } from "./org-activity-log.js";
import { normalizeLotNumber, normalizeExpiryDate } from "./inventory-lots.js";

export const PRODUCTION_STATES = ["PLANNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"];
const OPEN = ["PLANNED", "IN_PROGRESS"];
const round = (n) => Math.round(n * 1e6) / 1e6;

/** Component quantities needed to make `quantity` units with this BOM. Pure. */
export function requirementsFor(bom, quantity) {
  const factor = quantity / bom.outputQuantity;
  return bom.components.map((c) => ({ productId: c.productId, quantity: round(c.quantity * factor) }));
}

/** Totals per product across several requirement lists, minus what's in stock. Pure. */
export function shortages(requirementLists, stockByProduct) {
  const need = new Map();
  for (const list of requirementLists) for (const r of list) need.set(r.productId.toString(), round((need.get(r.productId.toString()) || 0) + r.quantity));
  return [...need].map(([productId, quantity]) => {
    const inStock = stockByProduct.get(productId) || 0;
    return { productId, needed: quantity, inStock, short: round(Math.max(0, quantity - inStock)) };
  });
}

export function serializeBom(b, names = new Map()) {
  return {
    id: b._id.toString(), departmentId: b.departmentId.toString(), productId: b.productId.toString(), productName: names.get(b.productId.toString()) || null,
    outputQuantity: b.outputQuantity, notes: b.notes || null,
    components: b.components.map((c) => ({ productId: c.productId.toString(), productName: names.get(c.productId.toString()) || null, quantity: c.quantity })),
    updatedAt: b.updatedAt,
  };
}

export function serializeProductionOrder(o, names = new Map()) {
  return {
    id: o._id.toString(), departmentId: o.departmentId.toString(), orderNumber: o.orderNumber,
    productId: o.productId.toString(), productName: names.get(o.productId.toString()) || null,
    warehouseId: o.warehouseId.toString(), warehouseName: names.get(o.warehouseId.toString()) || null,
    quantity: o.quantity, dueDate: o.dueDate || null, status: o.status, notes: o.notes || null,
    lotNumber: o.lotNumber || null, expiryDate: o.expiryDate || null,
    requirements: o.requirements.map((r) => ({ productId: r.productId.toString(), productName: names.get(r.productId.toString()) || null, quantity: r.quantity })),
    consumed: o.consumed ? o.consumed.map((c) => ({ ...c, productId: c.productId.toString(), productName: names.get(c.productId.toString()) || null })) : null,
    producedLots: o.producedLots || null, completedAt: o.completedAt || null,
    createdByEmail: o.createdByEmail, createdAt: o.createdAt, updatedAt: o.updatedAt,
  };
}

/** Product and warehouse names (id -> name) for serializing production orders. */
export async function productionNames(orgId, orders) {
  const { products, warehouses } = await getOrgCollections();
  const org = toObjectId(orgId);
  const ids = orders.flatMap((o) => [o.productId, ...o.requirements.map((r) => r.productId)]);
  const [ps, ws] = await Promise.all([
    products.find({ orgId: org, _id: { $in: ids } }, { projection: { name: 1 } }).toArray(),
    warehouses.find({ orgId: org }, { projection: { name: 1 } }).toArray(),
  ]);
  return new Map([...ps, ...ws].map((d) => [d._id.toString(), d.name]));
}

/** Creates or replaces the BOM for a finished product. */
export async function saveBom({ orgId, membership, actorEmail, productId, outputQuantity, components: raw, notes }) {
  const { products, boms } = await getOrgCollections();
  const org = toObjectId(orgId);
  const product = await products.findOne({ _id: toObjectId(productId), orgId: org, deletedAt: null });
  if (!product) return { error: "Product not found.", status: 404 };
  if (!canAccessDepartment(membership, product.departmentId)) return { error: "Product not found.", status: 404 };
  const out = Number(outputQuantity);
  if (!Number.isFinite(out) || out <= 0) return { error: "The batch size (how many it makes) must be a positive number.", status: 400 };
  if (!Array.isArray(raw) || raw.length === 0) return { error: "Add at least one component.", status: 400 };
  if (raw.length > 200) return { error: "A bill of materials may have at most 200 components.", status: 400 };
  const components = [];
  const seen = new Set();
  for (const c of raw) {
    const q = Number(c?.quantity);
    if (!c?.productId || !Number.isFinite(q) || q <= 0) return { error: "Every component needs a product and a positive quantity.", status: 400 };
    if (String(c.productId) === product._id.toString()) return { error: "A product can't be a component of itself.", status: 400 };
    if (seen.has(String(c.productId))) return { error: "Each component can appear only once; add the quantities together.", status: 400 };
    seen.add(String(c.productId));
    const comp = await products.findOne({ _id: toObjectId(c.productId), orgId: org, deletedAt: null });
    if (!comp) return { error: "A component product wasn't found.", status: 400 };
    components.push({ productId: comp._id, quantity: q });
  }
  const now = new Date().toISOString();
  await boms.updateOne(
    { orgId: org, productId: product._id, deletedAt: null },
    { $set: { departmentId: product.departmentId, outputQuantity: out, components, notes: notes ? String(notes).trim().slice(0, 2000) : null, updatedAt: now, updatedByEmail: actorEmail }, $setOnInsert: { orgId: org, productId: product._id, createdAt: now, createdByEmail: actorEmail, deletedAt: null } },
    { upsert: true }
  );
  const bom = await boms.findOne({ orgId: org, productId: product._id, deletedAt: null });
  await logOrgActivity({ orgId: org, recordType: "BOM", recordId: bom._id, actorEmail, action: "BOM_SAVED", previousState: null, newState: null, metadata: { productId: product._id.toString(), components: components.length } }).catch(() => {});
  return { bom };
}

export async function createProductionOrder({ orgId, membership, actorEmail, productId, quantity, warehouseId, dueDate, notes }) {
  const { products, warehouses, boms, productionOrders } = await getOrgCollections();
  const org = toObjectId(orgId);
  const product = await products.findOne({ _id: toObjectId(productId), orgId: org, deletedAt: null });
  if (!product) return { error: "Product not found.", status: 404 };
  if (!canAccessDepartment(membership, product.departmentId)) return { error: "Product not found.", status: 404 };
  const bom = await boms.findOne({ orgId: org, productId: product._id, deletedAt: null });
  if (!bom) return { error: "This product has no bill of materials yet. Add one first.", status: 409 };
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) return { error: "Quantity must be a positive number.", status: 400 };
  const warehouse = await warehouses.findOne({ _id: toObjectId(warehouseId), orgId: org });
  if (!warehouse) return { error: "Warehouse not found.", status: 404 };
  const due = normalizeExpiryDate(dueDate);
  if (due?.error) return { error: "Due date must be a date (YYYY-MM-DD).", status: 400 };
  const now = new Date().toISOString();
  const doc = {
    orgId: org, departmentId: product.departmentId, productId: product._id, warehouseId: warehouse._id, bomId: bom._id,
    orderNumber: `MO-${Date.now().toString(36).toUpperCase()}`, quantity: qty, dueDate: due,
    requirements: requirementsFor(bom, qty), status: "PLANNED", notes: notes ? String(notes).trim().slice(0, 2000) : null,
    createdByEmail: actorEmail, createdAt: now, updatedAt: now, deletedAt: null,
  };
  const r = await productionOrders.insertOne(doc);
  await logOrgActivity({ orgId: org, recordType: "PRODUCTION_ORDER", recordId: r.insertedId, actorEmail, action: "PRODUCTION_PLANNED", previousState: null, newState: "PLANNED", metadata: { orderNumber: doc.orderNumber, quantity: qty } }).catch(() => {});
  return { order: { ...doc, _id: r.insertedId } };
}

async function componentShortfalls(orgId, order) {
  const short = [];
  for (const r of order.requirements) {
    const have = await getStockLevel(orgId, r.productId, order.warehouseId);
    if (have < r.quantity) short.push({ productId: r.productId, have, need: r.quantity });
  }
  return short;
}

/** action: start | complete | cancel. complete takes { lotNumber?, expiryDate? } for the finished batch. */
export async function transitionProductionOrder({ orgId, orderId, action, membership, actorEmail, lotNumber, expiryDate }) {
  const { productionOrders, products } = await getOrgCollections();
  const org = toObjectId(orgId);
  const order = await productionOrders.findOne({ _id: toObjectId(orderId), orgId: org, deletedAt: null });
  if (!order) return { error: "Production order not found.", status: 404 };
  if (!canAccessDepartment(membership, order.departmentId)) return { error: "Production order not found.", status: 404 };
  const now = new Date().toISOString();
  const log = (prev, next, metadata = {}) => logOrgActivity({ orgId: org, recordType: "PRODUCTION_ORDER", recordId: order._id, actorEmail, action: `PRODUCTION_${next}`, previousState: prev, newState: next, metadata: { orderNumber: order.orderNumber, ...metadata } }).catch(() => {});
  const nameOf = async (id) => (await products.findOne({ _id: id }, { projection: { name: 1 } }))?.name || "a component";

  if (action === "start") {
    if (order.status !== "PLANNED") return { error: `Only a planned order can be started (this one is ${order.status}).`, status: 409 };
    const short = await componentShortfalls(orgId, order);
    if (short.length) return { error: `Not enough components at this warehouse: ${(await Promise.all(short.map(async (s) => `${await nameOf(s.productId)} (have ${s.have}, need ${s.need})`))).join("; ")}.`, status: 409 };
    if (!await productionOrders.findOneAndUpdate({ _id: order._id, status: "PLANNED" }, { $set: { status: "IN_PROGRESS", startedAt: now, updatedAt: now } })) return { error: "This order changed since it was loaded. Reload and try again.", status: 409 };
    await log("PLANNED", "IN_PROGRESS");
  } else if (action === "complete") {
    if (order.status !== "IN_PROGRESS") return { error: `Only an order in progress can be completed (this one is ${order.status}).`, status: 409 };
    const expiry = normalizeExpiryDate(expiryDate);
    if (expiry?.error) return { error: expiry.error, status: 400 };
    const lot = normalizeLotNumber(lotNumber) || order.orderNumber;
    if (!await productionOrders.findOneAndUpdate({ _id: order._id, status: "IN_PROGRESS" }, { $set: { status: "COMPLETING", updatedAt: now } })) return { error: "This order changed since it was loaded. Reload and try again.", status: 409 };
    const consumed = [];
    const undo = async (why) => {
      for (const c of consumed) await recordStockMovement({ orgId, productId: c.productId, warehouseId: order.warehouseId, delta: c.quantity, type: "ADJUSTMENT", relatedProductionOrderId: order._id, note: `Reversal: ${order.orderNumber} could not complete (${why})`, actorEmail, lots: c.lots || undefined });
      await productionOrders.updateOne({ _id: order._id }, { $set: { status: "IN_PROGRESS", updatedAt: new Date().toISOString() } });
    };
    for (const r of order.requirements) {
      const res = await recordStockMovement({ orgId, productId: r.productId, warehouseId: order.warehouseId, delta: -r.quantity, type: "CONSUME", relatedProductionOrderId: order._id, note: `Used in ${order.orderNumber}`, actorEmail });
      if (res.error) { await undo(res.error); return { error: `Couldn't take ${await nameOf(r.productId)}: ${res.error}`, status: res.status }; }
      consumed.push({ productId: r.productId, quantity: r.quantity, lots: res.lots || null });
    }
    const finished = await products.findOne({ _id: order.productId }, { projection: { trackLots: 1 } });
    const made = await recordStockMovement({ orgId, productId: order.productId, warehouseId: order.warehouseId, delta: order.quantity, type: "PRODUCE", relatedProductionOrderId: order._id, note: `Made in ${order.orderNumber}`, actorEmail, ...(finished?.trackLots ? { lotNumber: lot, expiryDate: expiry } : {}) });
    if (made.error) { await undo(made.error); return { error: `Couldn't record the finished goods: ${made.error}`, status: made.status }; }
    await productionOrders.updateOne({ _id: order._id }, { $set: { status: "COMPLETED", consumed, producedLots: made.lots || null, lotNumber: made.lots ? lot : null, expiryDate: expiry, completedAt: now, updatedAt: now } });
    await log("IN_PROGRESS", "COMPLETED", { lotNumber: made.lots ? lot : null });
  } else if (action === "cancel") {
    if (!OPEN.includes(order.status)) return { error: "Only a planned or in-progress order can be cancelled.", status: 409 };
    if (!await productionOrders.findOneAndUpdate({ _id: order._id, status: { $in: OPEN } }, { $set: { status: "CANCELLED", cancelledAt: now, updatedAt: now } })) return { error: "This order changed since it was loaded. Reload and try again.", status: 409 };
    await log(order.status, "CANCELLED");
  } else {
    return { error: "action must be start, complete or cancel.", status: 400 };
  }
  return { order: await productionOrders.findOne({ _id: order._id }) };
}

/** Materials needed by every open order the member can see, against stock at each order's warehouse. */
export async function materialsPlan({ orgId, membership }) {
  const { productionOrders, products } = await getOrgCollections();
  const org = toObjectId(orgId);
  const open = (await productionOrders.find({ orgId: org, status: { $in: OPEN }, deletedAt: null }).toArray()).filter((o) => canAccessDepartment(membership, o.departmentId));
  const byWarehouse = new Map();
  for (const o of open) byWarehouse.set(o.warehouseId.toString(), [...(byWarehouse.get(o.warehouseId.toString()) || []), o]);
  const rows = [];
  for (const [warehouseId, orders] of byWarehouse) {
    const ids = [...new Set(orders.flatMap((o) => o.requirements.map((r) => r.productId.toString())))];
    const stock = new Map();
    for (const id of ids) stock.set(id, await getStockLevel(orgId, id, warehouseId));
    for (const s of shortages(orders.map((o) => o.requirements), stock)) rows.push({ ...s, warehouseId, orders: orders.filter((o) => o.requirements.some((r) => r.productId.toString() === s.productId)).map((o) => o.orderNumber) });
  }
  const names = new Map((await products.find({ orgId: org, _id: { $in: rows.map((r) => toObjectId(r.productId)) } }, { projection: { name: 1, sku: 1, unit: 1 } }).toArray()).map((p) => [p._id.toString(), p]));
  return rows.map((r) => ({ ...r, productName: names.get(r.productId)?.name || "Unknown", sku: names.get(r.productId)?.sku || "", unit: names.get(r.productId)?.unit || "each" })).sort((a, b) => b.short - a.short);
}

/** Drafts a purchase request per short component (skipping any with a request already open). */
export async function draftShortageRequests({ orgId, membership, actorEmail }) {
  const { products, purchaseRequests } = await getOrgCollections();
  const org = toObjectId(orgId);
  const short = (await materialsPlan({ orgId, membership })).filter((r) => r.short > 0);
  const drafted = [];
  const skipped = [];
  for (const s of short) {
    if (await findOpenReorderRequest(orgId, s.productId)) { skipped.push(s.productName); continue; }
    const product = await products.findOne({ _id: toObjectId(s.productId), orgId: org, deletedAt: null });
    if (!product || !canAccessDepartment(membership, product.departmentId)) continue;
    const now = new Date().toISOString();
    const unitPrice = Number.isFinite(product.unitPrice) ? product.unitPrice : null;
    const r = await purchaseRequests.insertOne({
      orgId: org, departmentId: product.departmentId, supplierId: null,
      title: `Materials for production: ${product.sku} — ${product.name}`,
      description: `Open production orders (${s.orders.join(", ")}) need ${s.needed}; ${s.inStock} in stock at that warehouse. Short by ${s.short}.`,
      estimatedCost: unitPrice !== null ? Math.round(unitPrice * s.short * 100) / 100 : null,
      status: "DRAFT", reorderForProductId: product._id, reorderQuantity: s.short, reorderSource: "production",
      createdByEmail: actorEmail, createdAt: now, updatedAt: now, deletedAt: null,
    });
    await logOrgActivity({ orgId: org, recordType: "PURCHASE_REQUEST", recordId: r.insertedId, actorEmail, action: "REORDER_DRAFTED", previousState: null, newState: "DRAFT", metadata: { productId: product._id.toString(), quantity: s.short, source: "production" } }).catch(() => {});
    drafted.push(product.name);
  }
  return { drafted, skipped };
}
