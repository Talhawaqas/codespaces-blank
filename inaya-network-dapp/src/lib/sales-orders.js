// src/lib/sales-orders.js
//
// Sales (wholesale) orders: a CRM customer, a dispatching warehouse and
// product lines. DRAFT -> CONFIRMED (stock is checked) -> FULFILLED (stock
// leaves the warehouse through recordStockMovement, so batch-tracked products
// go earliest-expiry-first and every batch is tied to this order and
// customer) -> INVOICED. The invoice (a DRAFT built from the lines) can be
// raised before or after dispatch: invoiceId marks it, and INVOICED means
// dispatched AND invoiced. DRAFT and un-invoiced CONFIRMED orders can be
// CANCELLED; once dispatched, stock comes back only through an ordinary
// stock adjustment, so the ledger stays honest.

import { getOrgCollections, toObjectId, canAccessDepartment, canAccessFinance } from "./orgs.js";
import { recordStockMovement, getStockLevel } from "./inventory.js";
import { logOrgActivity } from "./org-activity-log.js";
import { isSupportedCurrency } from "./currency.js";
import { normalizeLotNumber, normalizeExpiryDate } from "./inventory-lots.js";
import { validateInvoiceLines, computeInvoiceTotals } from "./documentAutomation/invoiceTerms.js";
import { getDocumentSettings } from "./documentAutomation/settings.js";

export const SALES_ORDER_STATES = ["DRAFT", "CONFIRMED", "FULFILLED", "INVOICED", "CANCELLED"];
const MAX_LINES = 500;

export function serializeSalesOrder(o, names = {}) {
  return {
    id: o._id.toString(), orgId: o.orgId.toString(), departmentId: o.departmentId.toString(),
    contactId: o.contactId.toString(), customerName: names.customer || null,
    warehouseId: o.warehouseId.toString(), warehouseName: names.warehouse || null,
    orderNumber: o.orderNumber, orderDate: o.orderDate, deliveryDate: o.deliveryDate || null,
    currency: o.currency, lines: o.lines.map((l) => ({ ...l, productId: l.productId.toString() })),
    subtotal: o.subtotal, status: o.status, notes: o.notes || null,
    invoiceId: o.invoiceId ? o.invoiceId.toString() : null, fulfilledAt: o.fulfilledAt || null,
    createdByEmail: o.createdByEmail, createdAt: o.createdAt, updatedAt: o.updatedAt,
  };
}

/** Validates order lines against the org's products. Pure apart from the product lookup. */
async function validateLines(products, orgId, rawLines) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) return { error: "Add at least one product line." };
  if (rawLines.length > MAX_LINES) return { error: `An order may have at most ${MAX_LINES} lines.` };
  const lines = [];
  for (const raw of rawLines) {
    const quantity = Number(raw?.quantity);
    const unitPrice = Number(raw?.unitPrice);
    if (!raw?.productId) return { error: "Every line needs a product." };
    if (!Number.isFinite(quantity) || quantity <= 0) return { error: "Every line needs a positive quantity." };
    if (!Number.isFinite(unitPrice) || unitPrice < 0) return { error: "Every line needs a unit price of 0 or more." };
    const product = await products.findOne({ _id: toObjectId(raw.productId), orgId, deletedAt: null });
    if (!product) return { error: "A product on this order wasn't found." };
    const lotNumber = normalizeLotNumber(raw.lotNumber);
    lines.push({ productId: product._id, sku: product.sku, description: String(raw.description || product.name).trim().slice(0, 500), quantity, unitPrice, unit: product.unit || "each", ...(lotNumber ? { lotNumber } : {}) });
  }
  return { lines, subtotal: Math.round(lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0) * 100) / 100 };
}

export async function createSalesOrder({ orgId, membership, actorEmail, departmentId, contactId, warehouseId, currency, lines: rawLines, deliveryDate, notes }) {
  if (!departmentId || !contactId || !warehouseId) return { error: "Choose a department, a customer and the warehouse it ships from.", status: 400 };
  if (!canAccessDepartment(membership, departmentId)) return { error: "You don't have access to this department.", status: 403 };
  const cur = String(currency || "USD").toUpperCase();
  if (!isSupportedCurrency(cur)) return { error: `Unsupported currency "${cur}".`, status: 400 };
  const delivery = normalizeExpiryDate(deliveryDate);
  if (delivery?.error) return { error: "Delivery date must be a date (YYYY-MM-DD).", status: 400 };

  const { departments, crmContacts, warehouses, products, salesOrders } = await getOrgCollections();
  const org = toObjectId(orgId);
  if (!await departments.findOne({ _id: toObjectId(departmentId), orgId: org })) return { error: "Department not found.", status: 404 };
  const contact = await crmContacts.findOne({ _id: toObjectId(contactId), orgId: org, deletedAt: null });
  if (!contact) return { error: "Customer not found.", status: 404 };
  const warehouse = await warehouses.findOne({ _id: toObjectId(warehouseId), orgId: org });
  if (!warehouse) return { error: "Warehouse not found.", status: 404 };
  const v = await validateLines(products, org, rawLines);
  if (v.error) return { error: v.error, status: 400 };

  const now = new Date().toISOString();
  const doc = {
    orgId: org, departmentId: toObjectId(departmentId), contactId: contact._id, warehouseId: warehouse._id,
    orderNumber: `SO-${Date.now().toString(36).toUpperCase()}`, orderDate: now, deliveryDate: delivery,
    currency: cur, lines: v.lines, subtotal: v.subtotal, status: "DRAFT", notes: notes ? String(notes).trim().slice(0, 2000) : null,
    invoiceId: null, createdByEmail: actorEmail, createdAt: now, updatedAt: now, deletedAt: null,
  };
  const r = await salesOrders.insertOne(doc);
  await logOrgActivity({ orgId: org, recordType: "SALES_ORDER", recordId: r.insertedId, actorEmail, action: "SALES_ORDER_CREATED", previousState: null, newState: "DRAFT", metadata: { orderNumber: doc.orderNumber, subtotal: doc.subtotal } }).catch(() => {});
  return { order: serializeSalesOrder({ ...doc, _id: r.insertedId }, { customer: contact.name, warehouse: warehouse.name }) };
}

async function stockShortfalls(orgId, order) {
  const need = new Map();
  for (const l of order.lines) need.set(l.productId.toString(), (need.get(l.productId.toString()) || 0) + l.quantity);
  const short = [];
  for (const [productId, qty] of need) {
    const have = await getStockLevel(orgId, productId, order.warehouseId);
    if (have < qty) short.push(`${order.lines.find((l) => l.productId.toString() === productId).description} (have ${have}, need ${qty})`);
  }
  return short;
}

/** action: confirm | fulfil | invoice | cancel */
export async function transitionSalesOrder({ orgId, orderId, action, membership, actorEmail }) {
  const { salesOrders, invoices, crmContacts } = await getOrgCollections();
  const org = toObjectId(orgId);
  const order = await salesOrders.findOne({ _id: toObjectId(orderId), orgId: org, deletedAt: null });
  if (!order) return { error: "Sales order not found.", status: 404 };
  if (!canAccessDepartment(membership, order.departmentId)) return { error: "Sales order not found.", status: 404 };
  const now = new Date().toISOString();
  const log = (prev, next, metadata = {}) => logOrgActivity({ orgId: org, recordType: "SALES_ORDER", recordId: order._id, actorEmail, action: `SALES_ORDER_${next}`, previousState: prev, newState: next, metadata: { orderNumber: order.orderNumber, ...metadata } }).catch(() => {});
  const claim = (from, set) => salesOrders.findOneAndUpdate({ _id: order._id, status: { $in: from } }, { $set: { ...set, updatedAt: now } }, { returnDocument: "after" });

  if (action === "confirm") {
    if (order.status !== "DRAFT") return { error: `Only a draft order can be confirmed (this one is ${order.status}).`, status: 409 };
    const short = await stockShortfalls(orgId, order);
    if (short.length) return { error: `Not enough stock at the dispatching warehouse: ${short.join("; ")}.`, status: 409 };
    if (!await claim(["DRAFT"], { status: "CONFIRMED", confirmedAt: now })) return { error: "This order changed since it was loaded. Reload and try again.", status: 409 };
    await log("DRAFT", "CONFIRMED");
  } else if (action === "fulfil") {
    if (order.status !== "CONFIRMED") return { error: `Only a confirmed order can be dispatched (this one is ${order.status}).`, status: 409 };
    if (!await claim(["CONFIRMED"], { status: "FULFILLING" })) return { error: "This order changed since it was loaded. Reload and try again.", status: 409 };
    const done = [];
    for (const [i, l] of order.lines.entries()) {
      const r = await recordStockMovement({ orgId, productId: l.productId, warehouseId: order.warehouseId, delta: -l.quantity, type: "ISSUE", relatedSalesOrderId: order._id, note: `Sales order ${order.orderNumber}`, actorEmail, lotNumber: l.lotNumber });
      if (r.error) {
        // Put back what this dispatch already took, as recorded reversals.
        for (const d of done) await recordStockMovement({ orgId, productId: d.productId, warehouseId: order.warehouseId, delta: d.quantity, type: "ADJUSTMENT", relatedSalesOrderId: order._id, note: `Reversal: dispatch of ${order.orderNumber} failed`, actorEmail, lots: d.lots || undefined });
        await salesOrders.updateOne({ _id: order._id }, { $set: { status: "CONFIRMED", updatedAt: new Date().toISOString() } });
        return { error: `Couldn't dispatch "${l.description}": ${r.error}`, status: r.status };
      }
      done.push({ index: i, productId: l.productId, quantity: l.quantity, lots: r.lots || null });
    }
    const lines = order.lines.map((l, i) => ({ ...l, dispatchedLots: done[i].lots }));
    const next = order.invoiceId ? "INVOICED" : "FULFILLED";
    await salesOrders.updateOne({ _id: order._id }, { $set: { status: next, lines, fulfilledAt: now, updatedAt: now } });
    await log("CONFIRMED", next);
  } else if (action === "invoice") {
    if (!["CONFIRMED", "FULFILLED"].includes(order.status)) return { error: `Only a confirmed or dispatched order can be invoiced (this one is ${order.status}).`, status: 409 };
    if (order.invoiceId) return { error: "This order already has an invoice.", status: 409 };
    if (!canAccessFinance(membership)) return { error: "Creating invoices needs finance access.", status: 403 };
    const { lineItems, error } = validateInvoiceLines(order.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, sku: l.sku })));
    if (error) return { error, status: 400 };
    let totals;
    try {
      const settings = await getDocumentSettings(orgId);
      totals = computeInvoiceTotals({ lineItems, currency: order.currency, orgDefaultTaxPercent: settings.billingProfile.defaultTaxPercent });
    } catch (err) {
      return { error: `Cannot total the invoice: ${err.message}`, status: 400 };
    }
    const locked = await salesOrders.findOneAndUpdate({ _id: order._id, status: order.status, invoiceId: null, invoicing: { $ne: true } }, { $set: { invoicing: true } });
    if (!locked) return { error: "This order changed since it was loaded. Reload and try again.", status: 409 };
    const contact = await crmContacts.findOne({ _id: order.contactId });
    const days = Number.parseInt(String(contact?.paymentTerms || "").replace(/\D/g, ""), 10);
    const due = new Date(Date.now() + (Number.isFinite(days) && days > 0 ? days : 30) * 86400000).toISOString().slice(0, 10);
    const inv = await invoices.insertOne({
      orgId: org, departmentId: order.departmentId, contactId: order.contactId,
      invoiceNumber: `INV-${Date.now().toString(36).toUpperCase()}`, issueDate: now, dueDate: due,
      lineItems, subtotal: totals.subtotal, total: totals.total, currency: order.currency, status: "DRAFT",
      notes: `From sales order ${order.orderNumber}`, reference: order.orderNumber, relatedSalesOrderId: order._id,
      createdByEmail: actorEmail, createdAt: now, updatedAt: now, deletedAt: null,
    });
    const next = order.status === "FULFILLED" ? "INVOICED" : order.status;
    await salesOrders.updateOne({ _id: order._id }, { $set: { status: next, invoiceId: inv.insertedId, updatedAt: now }, $unset: { invoicing: "" } });
    await log(order.status, next === order.status ? "INVOICE_RAISED" : next, { invoiceId: inv.insertedId.toString() });
  } else if (action === "cancel") {
    if (!["DRAFT", "CONFIRMED"].includes(order.status)) return { error: "Only a draft or confirmed order can be cancelled. For a dispatched order, record the returned stock as an adjustment.", status: 409 };
    if (order.invoiceId) return { error: "This order has an invoice. Cancel the invoice in Accounting first.", status: 409 };
    if (!await salesOrders.findOneAndUpdate({ _id: order._id, status: { $in: ["DRAFT", "CONFIRMED"] }, invoiceId: null }, { $set: { status: "CANCELLED", cancelledAt: now, updatedAt: now } })) return { error: "This order changed since it was loaded. Reload and try again.", status: 409 };
    await log(order.status, "CANCELLED");
  } else {
    return { error: "action must be confirm, fulfil, invoice or cancel.", status: 400 };
  }
  return { order: serializeSalesOrder(await salesOrders.findOne({ _id: order._id })) };
}
