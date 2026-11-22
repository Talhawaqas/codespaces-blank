// src/lib/sales-orders.js
//
// Sales (wholesale) orders: a CRM customer, a dispatching warehouse and product lines. The lifecycle (Inaya Commerce
// Master SOW 6.9, shared with Online Commerce later through the same `sales_orders` collection and states):
//
//   QUOTE --accept--> DRAFT --confirm--> CONFIRMED (stock RESERVED) --pick--> PICKING --pack--> PACKED
//                         \--confirm (allowBackorder)--> BACKORDERED --reserve--> CONFIRMED     \--ready--> READY_FOR_PICKUP
//   CONFIRMED (any stage) --fulfil--> FULFILLED (stage DISPATCHED, or COLLECTED for pickup orders) --deliver--> DELIVERED
//   invoice: a DRAFT invoice from CONFIRMED/FULFILLED; INVOICED = dispatched AND invoiced (unchanged meaning)
//   cancel: QUOTE/DRAFT/CONFIRMED/BACKORDERED with no invoice and no money held (reservations are released)
//   return: dispatched items come back (restock / damaged write-off / not restockable) -> PARTIALLY_RETURNED / RETURNED
//
// `status` keeps the commercial state (QUOTE, DRAFT, CONFIRMED, BACKORDERED, FULFILLED, INVOICED, CANCELLED, RETURNED);
// `stage` is where the goods are (RESERVED, PICKING, PACKED, READY_FOR_PICKUP, DISPATCHED, COLLECTED, DELIVERED).
// Reservations live on stock_levels.reserved (inventory.js): reserved stock can only leave through its order, so the
// till and transfers can never sell what a confirmed order is holding. Confirm, reserve, dispatch, cancel and return
// each run in ONE transaction: no partial dispatch, no orphaned reservation.
//
// Payments (deposit / part-paid / paid): money recorded against an order (cash, bank transfer or a referenced manual
// payment -- never a card capture) is a CUSTOMER DEPOSIT in the books (Dr Cash, Cr Customer Deposits) until the order's
// invoice is paid, when the deposit is applied to the invoice (ledger.js). A payment that completes an order whose
// invoice is already sent marks that invoice PAID. Deposits can be refunded while the invoice is unpaid.

import { getOrgCollections, toObjectId, canAccessDepartment, canAccessFinance } from "./orgs.js";
import { recordStockMovement, reserveStock, releaseStock, withStockTransaction, StockError } from "./inventory.js";
import { logOrgActivity } from "./org-activity-log.js";
import { isSupportedCurrency } from "./currency.js";
import { normalizeLotNumber, normalizeExpiryDate } from "./inventory-lots.js";
import { validateInvoiceLines, computeInvoiceTotals } from "./documentAutomation/invoiceTerms.js";
import { getDocumentSettings } from "./documentAutomation/settings.js";

export const SALES_ORDER_STATES = ["QUOTE", "DRAFT", "CONFIRMED", "BACKORDERED", "FULFILLED", "INVOICED", "CANCELLED", "RETURNED"];
export const ORDER_STAGES = ["RESERVED", "PICKING", "PACKED", "READY_FOR_PICKUP", "DISPATCHED", "COLLECTED", "DELIVERED"];
export const ORDER_PAYMENT_METHODS = ["CASH", "BANK_TRANSFER", "MANUAL_REFERENCE"];
const MAX_LINES = 500;
const r2 = (n) => Math.round(n * 100) / 100;
const boom = (message, status = 400) => Object.assign(new Error(message), { status, isOrderError: true });

function paymentSummary(o) {
  const paidMinor = (o.payments || []).reduce((n, p) => n + (p.kind === "REFUND" ? -p.amountMinor : p.amountMinor), 0);
  const totalMinor = Math.round((o.total ?? o.subtotal) * 100);
  return { paid: paidMinor / 100, balance: Math.max(0, totalMinor - paidMinor) / 100, paymentStatus: paidMinor <= 0 ? "UNPAID" : paidMinor >= totalMinor ? "PAID" : "PART_PAID", paidMinor, totalMinor };
}

export function serializeSalesOrder(o, names = {}) {
  const pay = paymentSummary(o);
  return {
    id: o._id.toString(), orgId: o.orgId.toString(), departmentId: o.departmentId.toString(),
    contactId: o.contactId.toString(), customerName: names.customer || null,
    warehouseId: o.warehouseId.toString(), warehouseName: names.warehouse || null,
    orderNumber: o.orderNumber, orderDate: o.orderDate, deliveryDate: o.deliveryDate || null, validUntil: o.validUntil || null,
    currency: o.currency, lines: o.lines.map((l) => ({ ...l, productId: l.productId.toString(), reservedQty: l.reservedQty || 0, returnedQty: l.returnedQty || 0, backorderQty: o.status === "BACKORDERED" ? r2(l.quantity - (l.reservedQty || 0)) : 0 })),
    subtotal: o.subtotal, tax: o.tax ?? null, total: o.total ?? o.subtotal, status: o.status, stage: o.stage || null, fulfilmentMethod: o.fulfilmentMethod || "DELIVERY",
    paid: pay.paid, balance: pay.balance, paymentStatus: pay.paymentStatus,
    payments: (o.payments || []).map((p) => ({ no: p.no, kind: p.kind, method: p.method, amount: p.amountMinor / 100, reference: p.reference || null, by: p.by, at: p.at, reason: p.reason || null })),
    returns: (o.returns || []).map((r) => ({ no: r.no, reason: r.reason, by: r.by, at: r.at, lines: r.lines })),
    notes: o.notes || null, channel: o.channel || "ORDER",
    invoiceId: o.invoiceId ? o.invoiceId.toString() : null, fulfilledAt: o.fulfilledAt || null, deliveredAt: o.deliveredAt || null,
    history: (o.history || []).slice(-30),
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
    lines.push({ productId: product._id, sku: product.sku, description: String(raw.description || product.name).trim().slice(0, 500), quantity, unitPrice, unit: product.unit || "each", productType: product.productType || "STOCK", ...(lotNumber ? { lotNumber } : {}),
      ...(product.productType === "KIT" ? { kitComponents: (product.kitComponents || []).map((c) => ({ productId: toObjectId(c.productId), quantity: c.quantity })) } : {}) });
  }
  return { lines, subtotal: r2(lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0)) };
}
const stocked = (l) => !["SERVICE", "NON_STOCK", "KIT"].includes(l.productType);
/** The stock behind one unit of an order line: the product itself, a kit's components (snapshot taken when the order
 *  was created), or nothing for services. Reservations of a kit line are counted in kits. */
const legsOf = (l) => (l.productType === "KIT" ? (l.kitComponents || []).map((c) => ({ productId: c.productId, per: c.quantity })) : stocked(l) ? [{ productId: l.productId, per: 1 }] : []);
const hasStock = (l) => legsOf(l).length > 0;

/** Order total including the company's default tax, computed exactly like the invoice it will become. */
async function orderTotals(orgId, lines, currency) {
  try {
    const { lineItems, error } = validateInvoiceLines(lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, sku: l.sku })));
    if (error) return { tax: 0, total: r2(lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0)) };
    const settings = await getDocumentSettings(orgId);
    const t = computeInvoiceTotals({ lineItems, currency, orgDefaultTaxPercent: settings.billingProfile.defaultTaxPercent });
    return { tax: r2(t.total - t.subtotal), total: t.total };
  } catch { return { tax: 0, total: r2(lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0)) }; }
}

export async function createSalesOrder({ orgId, membership, actorEmail, departmentId, contactId, warehouseId, currency, lines: rawLines, deliveryDate, notes, quote = false, validUntil, fulfilmentMethod = "DELIVERY" }) {
  if (!departmentId || !contactId || !warehouseId) return { error: "Choose a department, a customer and the warehouse it ships from.", status: 400 };
  if (!canAccessDepartment(membership, departmentId)) return { error: "You don't have access to this department.", status: 403 };
  const cur = String(currency || "USD").toUpperCase();
  if (!isSupportedCurrency(cur)) return { error: `Unsupported currency "${cur}".`, status: 400 };
  const delivery = normalizeExpiryDate(deliveryDate);
  if (delivery?.error) return { error: "Delivery date must be a date (YYYY-MM-DD).", status: 400 };
  const valid = quote ? normalizeExpiryDate(validUntil) : null;
  if (valid?.error) return { error: "Valid-until must be a date (YYYY-MM-DD).", status: 400 };
  if (!["DELIVERY", "PICKUP"].includes(fulfilmentMethod)) return { error: "fulfilmentMethod must be DELIVERY or PICKUP.", status: 400 };

  const { departments, crmContacts, warehouses, products, salesOrders } = await getOrgCollections();
  const org = toObjectId(orgId);
  if (!await departments.findOne({ _id: toObjectId(departmentId), orgId: org })) return { error: "Department not found.", status: 404 };
  const contact = await crmContacts.findOne({ _id: toObjectId(contactId), orgId: org, deletedAt: null });
  if (!contact) return { error: "Customer not found.", status: 404 };
  const warehouse = await warehouses.findOne({ _id: toObjectId(warehouseId), orgId: org });
  if (!warehouse) return { error: "Warehouse not found.", status: 404 };
  const v = await validateLines(products, org, rawLines);
  if (v.error) return { error: v.error, status: 400 };
  const totals = await orderTotals(orgId, v.lines, cur);

  const now = new Date().toISOString(); const status = quote ? "QUOTE" : "DRAFT";
  const doc = {
    orgId: org, departmentId: toObjectId(departmentId), contactId: contact._id, warehouseId: warehouse._id,
    orderNumber: `${quote ? "QT" : "SO"}-${Date.now().toString(36).toUpperCase()}`, orderDate: now, deliveryDate: delivery, validUntil: valid || null,
    currency: cur, lines: v.lines, subtotal: v.subtotal, tax: totals.tax, total: totals.total, status, stage: null, fulfilmentMethod,
    payments: [], returns: [], history: [{ to: status, by: actorEmail, at: now }],
    notes: notes ? String(notes).trim().slice(0, 2000) : null,
    invoiceId: null, createdByEmail: actorEmail, createdAt: now, updatedAt: now, deletedAt: null,
  };
  const r = await salesOrders.insertOne(doc);
  await logOrgActivity({ orgId: org, recordType: "SALES_ORDER", recordId: r.insertedId, actorEmail, action: quote ? "SALES_QUOTE_CREATED" : "SALES_ORDER_CREATED", previousState: null, newState: status, metadata: { orderNumber: doc.orderNumber, subtotal: doc.subtotal, total: doc.total } }).catch(() => {});
  return { order: serializeSalesOrder({ ...doc, _id: r.insertedId }, { customer: contact.name, warehouse: warehouse.name }) };
}

async function stockShortfalls(orgId, order) {
  const need = new Map();
  for (const l of order.lines) for (const g of legsOf(l)) need.set(g.productId.toString(), (need.get(g.productId.toString()) || 0) + l.quantity * g.per);
  const short = [];
  const { stockLevels } = await getOrgCollections();
  for (const [productId, qty] of need) {
    const lvl = await stockLevels.findOne({ orgId: toObjectId(orgId), productId: toObjectId(productId), warehouseId: order.warehouseId });
    const free = Math.max(0, (lvl?.quantity || 0) - (lvl?.reserved || 0));
    if (free < qty) short.push(`${order.lines.find((l) => legsOf(l).some((g) => g.productId.toString() === productId))?.description || "An item"} (have ${free}, need ${qty}${lvl?.reserved ? `; ${lvl.reserved} more are reserved for other orders` : ""})`);
  }
  return short;
}

/** action: accept | confirm | reserve | pick | pack | ready | fulfil | deliver | invoice | cancel
 *  plus payment / refund / return (extra fields in `input`). */
export async function transitionSalesOrder({ orgId, orderId, action, membership, actorEmail, input = {} }) {
  const { salesOrders, invoices, crmContacts } = await getOrgCollections();
  const org = toObjectId(orgId);
  const order = await salesOrders.findOne({ _id: toObjectId(orderId), orgId: org, deletedAt: null, channel: { $ne: "POS" } });
  if (!order) return { error: "Sales order not found.", status: 404 };
  if (!canAccessDepartment(membership, order.departmentId)) return { error: "Sales order not found.", status: 404 };
  const now = new Date().toISOString();
  const hist = (to, extra = {}) => ({ $push: { history: { to, by: actorEmail, at: now, ...extra } } });
  const log = (prev, next, metadata = {}) => logOrgActivity({ orgId: org, recordType: "SALES_ORDER", recordId: order._id, actorEmail, action: `SALES_ORDER_${next}`, previousState: prev, newState: next, metadata: { orderNumber: order.orderNumber, ...metadata } }).catch(() => {});
  const claim = (from, set, extra = {}) => salesOrders.findOneAndUpdate({ _id: order._id, status: { $in: from }, ...extra }, { $set: { ...set, updatedAt: now }, ...hist(set.stage ? `${set.status || order.status}/${set.stage}` : set.status) }, { returnDocument: "after" });
  const changed = { error: "This order changed since it was loaded. Reload and try again.", status: 409 };
  const run = async (fn) => { try { return await withStockTransaction(fn); } catch (e) { if (e?.isOrderError || e instanceof StockError) return { error: e.message, status: e.status || 409 }; throw e; } };

  if (action === "accept") {
    if (order.status !== "QUOTE") return { error: `Only a quote can be accepted (this one is ${order.status}).`, status: 409 };
    if (order.validUntil && order.validUntil < now.slice(0, 10)) return { error: `This quote expired on ${order.validUntil}. Create a new quote.`, status: 409 };
    if (!await claim(["QUOTE"], { status: "DRAFT", acceptedAt: now })) return changed;
    await log("QUOTE", "ACCEPTED");
  } else if (action === "confirm" || action === "reserve") {
    const from = action === "confirm" ? ["DRAFT"] : ["BACKORDERED"];
    if (!from.includes(order.status)) return { error: action === "confirm" ? `Only a draft order can be confirmed (this one is ${order.status}).` : "Only a backordered order can be re-reserved.", status: 409 };
    const allowBackorder = action === "reserve" || input.allowBackorder === true;
    if (!allowBackorder) { const short = await stockShortfalls(orgId, order); if (short.length) return { error: `Not enough stock at the dispatching warehouse: ${short.join("; ")}. Confirm it as a backorder to reserve what is there.`, status: 409 }; }
    const res = await run(async (session) => {
      const fresh = await salesOrders.findOne({ _id: order._id, status: { $in: from } }, { session }); if (!fresh) throw boom(changed.error, 409);
      const lines = []; let complete = true;
      for (const l of fresh.lines) {
        if (!hasStock(l)) { lines.push(l); continue; }
        const want = r2(l.quantity - (l.reservedQty || 0));
        let got = { reserved: 0 };
        if (want > 0 && l.productType === "KIT") {
          // a kit is reserved whole: as many complete kits as every component allows
          const { stockLevels } = await getOrgCollections(); let kits = want;
          for (const g of legsOf(l)) { const lvl = await stockLevels.findOne({ orgId: org, productId: g.productId, warehouseId: fresh.warehouseId }, { session }); kits = Math.min(kits, Math.floor((Math.max(0, (lvl?.quantity || 0) - (lvl?.reserved || 0)) / g.per) + 1e-9)); }
          if (!allowBackorder && kits < want) kits = 0;
          if (kits > 0) for (const g of legsOf(l)) { const r = await reserveStock({ orgId, productId: g.productId, warehouseId: fresh.warehouseId, quantity: r2(kits * g.per), session, relatedSalesOrderId: fresh._id, actorEmail }); if (r.reserved < r2(kits * g.per)) throw boom(`Stock for ${l.description} changed while reserving; try again.`, 409); }
          got = { reserved: kits };
        } else if (want > 0) got = await reserveStock({ orgId, productId: l.productId, warehouseId: fresh.warehouseId, quantity: want, partial: allowBackorder, session, relatedSalesOrderId: fresh._id, actorEmail });
        if (!allowBackorder && got.reserved < want) throw boom(`Not enough stock for ${l.description}; nothing was reserved.`, 409);
        const reservedQty = r2((l.reservedQty || 0) + got.reserved); if (reservedQty < l.quantity) complete = false;
        lines.push({ ...l, reservedQty });
      }
      const status = complete ? "CONFIRMED" : "BACKORDERED";
      await salesOrders.updateOne({ _id: fresh._id }, { $set: { lines, status, stage: complete ? "RESERVED" : null, ...(action === "confirm" ? { confirmedAt: now } : {}), updatedAt: now }, ...hist(status) }, { session });
      return { status };
    });
    if (res.error) return res;
    await log(order.status, res.status);
  } else if (["pick", "pack", "ready"].includes(action)) {
    const step = { pick: [["RESERVED"], "PICKING"], pack: [["PICKING"], "PACKED"], ready: [["PACKED"], "READY_FOR_PICKUP"] }[action];
    if (order.status !== "CONFIRMED") return { error: "Only a confirmed order with all stock reserved can be picked and packed.", status: 409 };
    if (action === "ready" && order.fulfilmentMethod !== "PICKUP") return { error: "Only pickup orders are marked ready for pickup; delivery orders are dispatched.", status: 409 };
    if (!step[0].includes(order.stage || "RESERVED")) return { error: `This order is ${order.stage || "RESERVED"}; it can't move to ${step[1]} now.`, status: 409 };
    if (!await claim(["CONFIRMED"], { status: "CONFIRMED", stage: step[1] }, { stage: order.stage ?? null })) return changed;
    await log(order.stage || "RESERVED", step[1]);
  } else if (action === "fulfil") {
    if (order.status !== "CONFIRMED") return { error: order.status === "BACKORDERED" ? "Some items are on backorder. Reserve the missing stock first." : `Only a confirmed order can be dispatched (this one is ${order.status}).`, status: 409 };
    const res = await run(async (session) => {
      const fresh = await salesOrders.findOne({ _id: order._id, status: "CONFIRMED" }, { session }); if (!fresh) throw boom(changed.error, 409);
      const lines = [];
      for (const l of fresh.lines) {
        if (!hasStock(l)) { lines.push(l); continue; }
        let lots = null; const idx = lines.length;
        for (const [k, g] of legsOf(l).entries()) {
          const r = await recordStockMovement({ orgId, productId: g.productId, warehouseId: fresh.warehouseId, delta: -r2(l.quantity * g.per), type: "ISSUE", relatedSalesOrderId: fresh._id, note: `Sales order ${fresh.orderNumber}${l.productType === "KIT" ? ` (kit ${l.sku})` : ""}`, actorEmail, lotNumber: l.productType === "KIT" ? undefined : l.lotNumber, session, consumeReserved: r2((l.reservedQty || 0) * g.per), idempotencyKey: l.productType === "KIT" ? `so:${fresh._id}:${idx}:k${k}` : `so:${fresh._id}:${idx}` });
          if (r.error) throw boom(`Couldn't dispatch "${l.description}": ${r.error}`, r.status || 409);
          if (l.productType !== "KIT") lots = r.lots || null;
        }
        lines.push({ ...l, reservedQty: 0, dispatchedLots: lots });
      }
      const next = fresh.invoiceId ? "INVOICED" : "FULFILLED"; const stage = fresh.fulfilmentMethod === "PICKUP" ? "COLLECTED" : "DISPATCHED";
      await salesOrders.updateOne({ _id: fresh._id }, { $set: { status: next, stage, lines, fulfilledAt: now, updatedAt: now }, ...hist(`${next}/${stage}`) }, { session });
      return { next, stage };
    });
    if (res.error) return res;
    await log("CONFIRMED", res.next, { stage: res.stage });
  } else if (action === "deliver") {
    if (!["FULFILLED", "INVOICED"].includes(order.status) || order.stage !== "DISPATCHED") return { error: "Only a dispatched delivery can be marked delivered.", status: 409 };
    if (!await salesOrders.findOneAndUpdate({ _id: order._id, stage: "DISPATCHED" }, { $set: { stage: "DELIVERED", deliveredAt: now, deliveryNote: String(input.note || "").slice(0, 300) || null, updatedAt: now }, ...hist(`${order.status}/DELIVERED`) })) return changed;
    await log("DISPATCHED", "DELIVERED");
  } else if (action === "invoice") {
    if (!["CONFIRMED", "BACKORDERED", "FULFILLED"].includes(order.status)) return { error: `Only a confirmed or dispatched order can be invoiced (this one is ${order.status}).`, status: 409 };
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
    if (!locked) return changed;
    const contact = await crmContacts.findOne({ _id: order.contactId });
    const days = Number.parseInt(String(contact?.paymentTerms || "").replace(/\D/g, ""), 10);
    const due = new Date(Date.now() + (Number.isFinite(days) && days > 0 ? days : 30) * 86400000).toISOString().slice(0, 10);
    const pay = paymentSummary(order);
    const inv = await invoices.insertOne({
      orgId: org, departmentId: order.departmentId, contactId: order.contactId,
      invoiceNumber: `INV-${Date.now().toString(36).toUpperCase()}`, issueDate: now, dueDate: due,
      lineItems, subtotal: totals.subtotal, total: totals.total, currency: order.currency, status: "DRAFT",
      notes: `From sales order ${order.orderNumber}${pay.paid > 0 ? ` (${order.currency} ${pay.paid.toFixed(2)} already received as deposit)` : ""}`, reference: order.orderNumber, relatedSalesOrderId: order._id,
      depositsReceived: pay.paid, createdByEmail: actorEmail, createdAt: now, updatedAt: now, deletedAt: null,
    });
    const next = order.status === "FULFILLED" ? "INVOICED" : order.status;
    await salesOrders.updateOne({ _id: order._id }, { $set: { status: next, invoiceId: inv.insertedId, updatedAt: now }, $unset: { invoicing: "" }, ...hist(next === order.status ? `${next}/INVOICE_RAISED` : next) });
    await log(order.status, next === order.status ? "INVOICE_RAISED" : next, { invoiceId: inv.insertedId.toString() });
  } else if (action === "cancel") {
    if (!["QUOTE", "DRAFT", "CONFIRMED", "BACKORDERED"].includes(order.status)) return { error: "Only a quote or a not-yet-dispatched order can be cancelled. For a dispatched order, record a return.", status: 409 };
    if (order.invoiceId) return { error: "This order has an invoice. Cancel the invoice in Accounting first.", status: 409 };
    if (paymentSummary(order).paidMinor > 0) return { error: "This order holds a deposit. Refund it before cancelling.", status: 409 };
    const res = await run(async (session) => {
      const fresh = await salesOrders.findOne({ _id: order._id, status: { $in: ["QUOTE", "DRAFT", "CONFIRMED", "BACKORDERED"] }, invoiceId: null }, { session }); if (!fresh) throw boom(changed.error, 409);
      for (const l of fresh.lines) if (l.reservedQty > 0) for (const g of legsOf(l)) await releaseStock({ orgId, productId: g.productId, warehouseId: fresh.warehouseId, quantity: r2(l.reservedQty * g.per), session, relatedSalesOrderId: fresh._id, actorEmail });
      await salesOrders.updateOne({ _id: fresh._id }, { $set: { status: "CANCELLED", stage: null, lines: fresh.lines.map((l) => ({ ...l, reservedQty: 0 })), cancelledAt: now, cancelReason: String(input.reason || "").slice(0, 300) || null, updatedAt: now }, ...hist("CANCELLED") }, { session });
      return { ok: true };
    });
    if (res.error) return res;
    await log(order.status, "CANCELLED");
  } else if (action === "payment" || action === "refund") {
    return orderPayment({ orgId, order, membership, actorEmail, input, refund: action === "refund", now });
  } else if (action === "return") {
    return returnOrderItems({ orgId, order, actorEmail, input, now });
  } else {
    return { error: "Unknown action.", status: 400 };
  }
  return { order: serializeSalesOrder(await salesOrders.findOne({ _id: order._id })) };
}

/** Deposit / part payment / final payment, or a deposit refund. Amounts are bounded: payments never exceed the order
 *  total, refunds never exceed what was received; a refund is possible only while the invoice is unpaid. */
async function orderPayment({ orgId, order, membership, actorEmail, input, refund, now }) {
  const { salesOrders, invoices } = await getOrgCollections();
  if (["QUOTE", "CANCELLED"].includes(order.status)) return { error: "Accept the quote first; cancelled orders take no payments.", status: 409 };
  if (refund && !canAccessFinance(membership)) return { error: "Refunding a deposit needs finance access.", status: 403 };
  const method = String(input.method || ""); if (!ORDER_PAYMENT_METHODS.includes(method)) return { error: "Payment method must be cash, bank transfer or a referenced manual payment.", status: 400 };
  const amountMinor = Math.round(Number(input.amount) * 100); if (!(amountMinor > 0)) return { error: "Amount must be positive.", status: 400 };
  const reference = String(input.reference || "").trim().slice(0, 120); if (method !== "CASH" && !reference) return { error: "A non-cash payment needs a reference.", status: 400 };
  const pay = paymentSummary(order);
  const inv = order.invoiceId ? await invoices.findOne({ _id: order.invoiceId }) : null;
  if (refund) {
    if (amountMinor > pay.paidMinor) return { error: `Only ${order.currency} ${(pay.paidMinor / 100).toFixed(2)} was received on this order.`, status: 409 };
    if (inv?.status === "PAID") return { error: "The invoice is paid, so the deposit has been applied. Refund through Accounting (cancel or credit the invoice).", status: 409 };
    if (String(input.reason || "").trim().length < 3) return { error: "Give a reason for the refund.", status: 400 };
  } else if (amountMinor > pay.totalMinor - pay.paidMinor) return { error: `That is more than the balance (${order.currency} ${((pay.totalMinor - pay.paidMinor) / 100).toFixed(2)}).`, status: 409 };
  if (!refund && inv?.status === "PAID") return { error: "This order's invoice is already paid.", status: 409 };
  const no = `${refund ? "RF" : "P"}${(order.payments || []).length + 1}`;
  const entry = { no, kind: refund ? "REFUND" : (order.status === "FULFILLED" || order.status === "INVOICED" ? "PAYMENT" : "DEPOSIT"), method, amountMinor, reference: reference || null, by: actorEmail, at: now, ...(refund ? { reason: String(input.reason).trim().slice(0, 300) } : {}) };
  // bounded update: the payment count must still be what we read (no concurrent double entry)
  const r = await salesOrders.findOneAndUpdate({ _id: order._id, [`payments.${(order.payments || []).length}`]: { $exists: false } }, { $push: { payments: entry, history: { to: refund ? "DEPOSIT_REFUNDED" : `PAYMENT_${entry.kind}`, by: actorEmail, at: now } }, $set: { updatedAt: now } }, { returnDocument: "after" });
  if (!r) return { error: "Another payment was recorded at the same moment. Reload and check before trying again.", status: 409 };
  await logOrgActivity({ orgId: order.orgId, recordType: "SALES_ORDER", recordId: order._id, actorEmail, action: refund ? "SALES_ORDER_DEPOSIT_REFUNDED" : "SALES_ORDER_PAYMENT", previousState: pay.paymentStatus, newState: paymentSummary(r).paymentStatus, metadata: { orderNumber: order.orderNumber, no, method, amount: amountMinor / 100, reference: reference || null } }).catch(() => {});
  // paid in full with the invoice already sent: the invoice is paid (from the deposits)
  const after = paymentSummary(r);
  if (!refund && after.paymentStatus === "PAID" && inv && ["SENT", "OVERDUE"].includes(inv.status)) {
    const upd = await invoices.findOneAndUpdate({ _id: inv._id, status: { $in: ["SENT", "OVERDUE"] } }, { $set: { status: "PAID", paidAt: now, updatedAt: now } });
    if (upd) await logOrgActivity({ orgId: order.orgId, recordType: "INVOICE", recordId: inv._id, actorEmail, action: "INVOICE_PAID", previousState: inv.status, newState: "PAID", metadata: { fromSalesOrder: order.orderNumber } }).catch(() => {});
  }
  try { const { syncLedger } = await import("./ledger.js"); await syncLedger(orgId, { actorEmail: "system:orders" }); } catch (e) { console.error("orders: ledger sync after payment failed (nightly sync will retry):", e?.message); }
  return { order: serializeSalesOrder(r) };
}

/** Dispatched items come back. Restock / damaged (returned then written off) / not restockable. Bounded per line. */
async function returnOrderItems({ orgId, order, actorEmail, input, now }) {
  const { salesOrders } = await getOrgCollections();
  if (!["FULFILLED", "INVOICED", "RETURNED"].includes(order.status)) return { error: "Only dispatched orders can have returns.", status: 409 };
  const reason = String(input.reason || "").trim().slice(0, 300); if (reason.length < 3) return { error: "Give a reason for the return.", status: 400 };
  if (!Array.isArray(input.lines) || !input.lines.length) return { error: "Choose the items coming back.", status: 400 };
  try {
    await withStockTransaction(async (session) => {
      const fresh = await salesOrders.findOne({ _id: order._id }, { session });
      const lines = fresh.lines.map((l) => ({ ...l })); const rec = []; const no = `RT${(fresh.returns || []).length + 1}`;
      for (const x of input.lines) {
        const i = Number(x.lineIndex); const l = lines[i]; const q = Number(x.quantity);
        if (!l) throw boom("Unknown order line.");
        if (!(q > 0) || q > l.quantity - (l.returnedQty || 0) + 1e-9) throw boom(`Only ${l.quantity - (l.returnedQty || 0)} of ${l.description} can come back.`, 409);
        const disposition = hasStock(l) ? (x.disposition || "RESTOCK") : "NON_RESTOCKABLE";
        if (!["RESTOCK", "DAMAGED", "NON_RESTOCKABLE"].includes(disposition)) throw boom("Disposition must be RESTOCK, DAMAGED or NON_RESTOCKABLE.");
        if (disposition !== "NON_RESTOCKABLE") for (const [k, g] of legsOf(l).entries()) {
          const kit = l.productType === "KIT"; const tag = kit ? `:k${k}` : "";
          const back = await recordStockMovement({ orgId, productId: g.productId, warehouseId: fresh.warehouseId, delta: r2(q * g.per), type: "RETURN", relatedSalesOrderId: fresh._id, actorEmail, session, note: `Return ${no} of ${fresh.orderNumber}`, idempotencyKey: `so:${fresh._id}:${no}:${i}${tag}`, ...(kit ? {} : { lotNumber: l.dispatchedLots?.[0]?.lotNumber || l.lotNumber, expiryDate: l.dispatchedLots?.[0]?.expiryDate }) });
          if (back.error) throw boom(back.error, back.status || 409);
          if (disposition === "DAMAGED") { const off = await recordStockMovement({ orgId, productId: g.productId, warehouseId: fresh.warehouseId, delta: -r2(q * g.per), type: "WRITE_OFF", relatedSalesOrderId: fresh._id, actorEmail, session, note: `Damaged return ${no}`, idempotencyKey: `so:${fresh._id}:${no}:${i}${tag}:w` }); if (off.error) throw boom(off.error, off.status || 409); }
        }
        l.returnedQty = r2((l.returnedQty || 0) + q); rec.push({ lineIndex: i, sku: l.sku, description: l.description, quantity: q, disposition });
      }
      const all = lines.every((l) => (l.returnedQty || 0) >= l.quantity - 1e-9);
      const upd = await salesOrders.updateOne({ _id: fresh._id, [`returns.${(fresh.returns || []).length}`]: { $exists: false } }, { $set: { lines, ...(all ? { status: "RETURNED" } : {}), updatedAt: now }, $push: { returns: { no, reason, by: actorEmail, at: now, lines: rec }, history: { to: all ? "RETURNED" : "PARTIALLY_RETURNED", by: actorEmail, at: now } } }, { session });
      if (upd.modifiedCount !== 1) throw boom("Another return was recorded at the same moment. Reload.", 409);
    });
  } catch (e) { if (e?.isOrderError || e instanceof StockError) return { error: e.message, status: e.status || 409 }; throw e; }
  await logOrgActivity({ orgId: order.orgId, recordType: "SALES_ORDER", recordId: order._id, actorEmail, action: "SALES_ORDER_RETURN", previousState: order.status, newState: null, metadata: { orderNumber: order.orderNumber, reason, lines: input.lines } }).catch(() => {});
  return { order: serializeSalesOrder(await salesOrders.findOne({ _id: order._id })) };
}
