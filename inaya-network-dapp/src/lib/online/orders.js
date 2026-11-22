// src/lib/online/orders.js -- turns a checkout (native store) or an imported channel order (Shopify / WooCommerce) into a
// `sales_orders` document and runs it through the SAME lifecycle as staff-entered orders (sales-orders.js): confirm reserves
// stock in one transaction (never oversells: a shortfall cancels the order and nothing is reserved), payments post to Customer
// Deposits, fulfilment issues stock, cancellation releases reservations. Online-only extras on the order:
//   channel ONLINE | SHOPIFY | WOOCOMMERCE, storeId / channelId, externalOrderId, publicToken (customer status page),
//   onlinePayment { method, state, holdUntil, provider, providerRef }, shipping { method, zone, amount, address, window },
//   invoiceLines (net unit prices + tax % per line, so the invoice equals what the customer was charged) and shippingAmount.
// Customer notifications (placed / paid / ready / dispatched / delivered / cancelled) go by email through Resend, never in a
// test environment.
import { randomBytes, createHash } from "node:crypto";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { transitionSalesOrder } from "../sales-orders.js";
import { ccol, oid, sid, clean, nowIso, fromMinor, audit, emitCommerceEvent } from "../commerce/store.js";
import { OK, countVisit } from "./stores.js";

export const SYSTEM_ACTOR = "online-store@system";
/** The order engine checks department access; system steps (confirm after checkout, expiry, provider-confirmed payments) act
 *  as an org-level system member, and every such step is audited under SYSTEM_ACTOR. */
export const systemMembership = () => ({ role: "admin", email: SYSTEM_ACTOR, system: true });
export const ONLINE_CHANNELS = ["ONLINE", "SHOPIFY", "WOOCOMMERCE"];
const isTestEnv = () => process.env.INAYA_USE_TEST_DB === "1" || !!process.env.NODE_TEST_CONTEXT;
export const tokenHash = (t) => createHash("sha256").update(String(t)).digest("hex");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

/** Finds the CRM contact by email or creates a CUSTOMER contact (tenant-scoped, case-insensitive email match). */
export async function ensureCustomer({ orgId, departmentId, name, email, phone, address, source }) {
  const { crmContacts } = await getOrgCollections(); const e = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) || e.length > 200) return { error: "Enter a valid email address.", status: 400 };
  const rx = new RegExp(`^${e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  const existing = await crmContacts.findOne({ orgId: toObjectId(orgId), email: rx, deletedAt: null });
  if (existing) { if (address && !existing.shippingAddress?.line1) await crmContacts.updateOne({ _id: existing._id }, { $set: { shippingAddress: address, updatedAt: nowIso() } }); return { contact: existing, created: false }; }
  const now = nowIso();
  const doc = { orgId: toObjectId(orgId), departmentId: toObjectId(departmentId), type: "CUSTOMER", name: clean(name, 120) || e.split("@")[0], email: e, phone: phone ? clean(phone, 40) : null, company: null, taxId: null, paymentTerms: null, billingAddress: address || {}, shippingAddress: address || {}, notes: `Created from ${source}`, sourceChannel: source, createdByEmail: SYSTEM_ACTOR, createdAt: now, updatedAt: now, deletedAt: null };
  const r = await crmContacts.insertOne(doc);
  return { contact: { ...doc, _id: r.insertedId }, created: true };
}

/** Builds order lines from a priceCart() result. invoiceLines carry the net (pre-tax) amount actually charged, so the invoice
 *  reproduces the checkout total exactly; a line whose net doesn't divide evenly by its quantity is invoiced as one line. */
export function linesFromPriced(priced, products) {
  const lines = []; const invoiceLines = [];
  for (const l of priced.lines) {
    const p = products.get(String(l.productId));
    lines.push({ productId: toObjectId(l.productId), sku: l.sku, description: l.name, quantity: l.quantity, unitPrice: l.unitPrice, unit: p?.unit || "each", productType: l.productType || "STOCK",
      ...(l.productType === "KIT" ? { kitComponents: (p?.kitComponents || []).map((k) => ({ productId: toObjectId(k.productId), quantity: k.quantity })) } : {}), netMinor: l._minor.netMinor, taxMinor: l._minor.taxMinor, grossMinor: l._minor.grossMinor, discountMinor: l._minor.disc, taxRate: l.taxRate });
    const unit = l._minor.netMinor / l.quantity; const even = Number.isInteger(unit);
    invoiceLines.push(even ? { description: l.name, quantity: l.quantity, unitPrice: fromMinor(unit), taxPercent: l.taxRate || 0, sku: l.sku } : { description: `${l.quantity} × ${l.name}`, quantity: 1, unitPrice: fromMinor(l._minor.netMinor), taxPercent: l.taxRate || 0, sku: l.sku });
  }
  return { lines, invoiceLines };
}

/** Inserts the order and confirms it (reserving stock). On a stock shortfall the order is cancelled and the error returned. */
export async function placeOrder({ orgId, departmentId, warehouseId, currency, contact, channel, storeId = null, channelId = null, externalOrderId = null, lines, invoiceLines, goodsTotalMinor, taxMinor, shipping = null, onlinePayment, notes = null, fulfilmentMethod = "DELIVERY", allowBackorder = false, externalPaid = false }) {
  const { salesOrders } = await getOrgCollections(); const now = nowIso();
  const shipMinor = shipping?.amountMinor || 0; const totalMinor = goodsTotalMinor + shipMinor;
  const token = randomBytes(18).toString("base64url");
  const prefix = { ONLINE: "WEB", SHOPIFY: "SHP", WOOCOMMERCE: "WOO" }[channel] || "WEB";
  const doc = {
    orgId: toObjectId(orgId), departmentId: toObjectId(departmentId), contactId: contact._id, warehouseId: toObjectId(warehouseId),
    orderNumber: `${prefix}-${Date.now().toString(36).toUpperCase()}${randomBytes(1).toString("hex").toUpperCase()}`, orderDate: now, deliveryDate: null, validUntil: null,
    currency, lines, subtotal: fromMinor(lines.reduce((n, l) => n + (l.netMinor || 0), 0)), tax: fromMinor(taxMinor), total: fromMinor(totalMinor), status: "DRAFT", stage: null, fulfilmentMethod,
    payments: [], returns: [], history: [{ to: "DRAFT", by: SYSTEM_ACTOR, at: now, channel }], notes: notes ? clean(notes, 2000) : null, invoiceId: null,
    channel, storeId: storeId ? toObjectId(storeId) : null, channelId: channelId ? toObjectId(channelId) : null, externalOrderId: externalOrderId ? String(externalOrderId) : null,
    customerEmail: contact.email || null, publicTokenHash: tokenHash(token), onlinePayment, shipping: shipping ? { ...shipping } : null, shippingAmount: fromMinor(shipMinor), invoiceLines,
    createdByEmail: SYSTEM_ACTOR, createdAt: now, updatedAt: now, deletedAt: null,
  };
  const r = await salesOrders.insertOne(doc); doc._id = r.insertedId;
  const conf = await transitionSalesOrder({ orgId, orderId: sid(doc._id), action: "confirm", membership: systemMembership(), actorEmail: SYSTEM_ACTOR, input: { allowBackorder } });
  if (conf.error) {
    await salesOrders.updateOne({ _id: doc._id }, { $set: { status: "CANCELLED", cancelledAt: nowIso(), cancelReason: `Not placed: ${conf.error}`, "onlinePayment.state": "NOT_PLACED", updatedAt: nowIso() }, $push: { history: { to: "CANCELLED", by: SYSTEM_ACTOR, at: nowIso() } } });
    return { error: /stock/i.test(conf.error) ? "Sorry, some items just sold out. Please review your cart." : conf.error, status: conf.status || 409, code: "OUT_OF_STOCK", orderId: sid(doc._id) };
  }
  await audit({ orgId, actorEmail: SYSTEM_ACTOR, recordType: "SALES_ORDER", recordId: doc._id, action: "ONLINE_ORDER_PLACED", newState: conf.order.status, metadata: { channel, orderNumber: doc.orderNumber, total: fromMinor(totalMinor), payment: onlinePayment?.method, externalOrderId } });
  await emitCommerceEvent({ orgId, name: "order.placed", entityId: doc._id, actorEmail: SYSTEM_ACTOR, source: channel.toLowerCase(), payload: { orderNumber: doc.orderNumber, channel, total: fromMinor(totalMinor), currency } }).catch(() => {});
  if (storeId) await countVisit(storeId, orgId, "orders");
  if (externalPaid) await recordProviderPayment({ orgId, orderId: sid(doc._id), method: "MANUAL_REFERENCE", amountMinor: totalMinor, reference: `${channel} order ${externalOrderId}`, provider: channel }).catch(() => {});
  return { order: conf.order, orderId: sid(doc._id), orderNumber: doc.orderNumber, publicToken: token, totalMinor };
}

/** Records money the provider confirmed (or the channel says was paid) as an order payment, once. */
export async function recordProviderPayment({ orgId, orderId, method = "CARD", amountMinor, reference, provider }) {
  const { salesOrders } = await getOrgCollections(); const order = await salesOrders.findOne({ _id: toObjectId(orderId), orgId: toObjectId(orgId) });
  if (!order) return { error: "Order not found.", status: 404 };
  if ((order.payments || []).some((p) => p.reference === reference && p.kind !== "REFUND")) return { order, duplicate: true }; // idempotent
  const r = await transitionSalesOrder({ orgId, orderId, action: "payment", membership: systemMembership(), actorEmail: SYSTEM_ACTOR, input: { method, amount: fromMinor(amountMinor), reference } });
  if (r.error) return r;
  await salesOrders.updateOne({ _id: order._id }, { $set: { "onlinePayment.state": "PAID", "onlinePayment.paidAt": nowIso(), "onlinePayment.provider": provider, updatedAt: nowIso() } });
  notifyCustomer({ orgId, orderId, event: "paid" }).catch(() => {});
  return r;
}

/** Cancels an online order that was never paid in time (card checkout abandoned, bank transfer not received). */
export async function expireOrder({ orgId, orderId, reason }) {
  const { salesOrders } = await getOrgCollections(); const order = await salesOrders.findOne({ _id: toObjectId(orderId), orgId: toObjectId(orgId) });
  if (!order || !["AWAITING_PAYMENT", "PENDING_BANK_TRANSFER"].includes(order.onlinePayment?.state) || (order.payments || []).length) return { skipped: true };
  const r = await transitionSalesOrder({ orgId, orderId, action: "cancel", membership: systemMembership(), actorEmail: SYSTEM_ACTOR, input: { reason } });
  if (r.error) return r;
  await salesOrders.updateOne({ _id: order._id }, { $set: { "onlinePayment.state": "EXPIRED", updatedAt: nowIso() } });
  const { releasePromotionUses } = await import("../growth/promotions.js"); await releasePromotionUses({ orgId, saleId: orderId }).catch(() => {});
  if (order.storeId) await countVisit(order.storeId, orgId, "abandoned");
  notifyCustomer({ orgId, orderId, event: "cancelled" }).catch(() => {});
  return { expired: true };
}
export async function expireDueOrders({ now = new Date(), orgId = null, fetchImpl = fetch } = {}) {
  const { salesOrders } = await getOrgCollections(); let n = 0, rescued = 0;
  const due = await salesOrders.find({ ...(orgId ? { orgId: toObjectId(orgId) } : {}), channel: "ONLINE", status: { $in: ["CONFIRMED", "BACKORDERED"] }, "onlinePayment.state": { $in: ["AWAITING_PAYMENT", "PENDING_BANK_TRANSFER"] }, "onlinePayment.holdUntil": { $lt: now.toISOString() }, payments: { $size: 0 } }, { projection: { orgId: 1, onlinePayment: 1 } }).limit(500).toArray();
  for (const o of due) {
    if (o.onlinePayment.state === "AWAITING_PAYMENT") {
      // never cancel a card order without asking the provider first: the customer may have paid just before the hold ran out
      const c = await ccol(); const p = await c.findOne({ kind: OK.payment, orderId: o._id }, { sort: { createdAt: -1 } });
      if (p) { const { reconcilePayment } = await import("./payments.js"); const r = await reconcilePayment({ paymentId: sid(p._id), fetchImpl }).catch(() => ({ state: "UNKNOWN" })); if (r.state === "PAID" || r.state === "UNKNOWN") { rescued++; continue; } }
    }
    const r = await expireOrder({ orgId: sid(o.orgId), orderId: sid(o._id), reason: o.onlinePayment.state === "PENDING_BANK_TRANSFER" ? "Bank transfer not received in time" : "Card payment not completed" }); if (r.expired) n++;
  }
  return { expired: n, keptBecausePaidOrUnconfirmed: rescued };
}

/** Public order-status page data, by the customer's private token. */
export async function orderByToken({ orgId, orderNumber, token }) {
  const { salesOrders } = await getOrgCollections();
  const o = await salesOrders.findOne({ orgId: toObjectId(orgId), orderNumber: String(orderNumber || "").slice(0, 40), publicTokenHash: tokenHash(token || "") });
  if (!o) return null;
  const paid = (o.payments || []).reduce((n, p) => n + (p.kind === "REFUND" ? -p.amountMinor : p.amountMinor), 0);
  return { orderNumber: o.orderNumber, placedAt: o.orderDate, status: o.status, stage: o.stage, fulfilmentMethod: o.fulfilmentMethod, currency: o.currency,
    lines: o.lines.map((l) => ({ description: l.description, quantity: l.quantity, total: fromMinor(l.grossMinor ?? Math.round(l.quantity * l.unitPrice * 100)) })), shipping: o.shipping ? { method: o.shipping.method, zone: o.shipping.zoneName || null, amount: o.shippingAmount, window: o.shipping.window || null, trackingRef: o.shipping.trackingRef || null } : null,
    tax: o.tax, total: o.total, paid: fromMinor(paid), payment: { method: o.onlinePayment?.method, state: o.onlinePayment?.state, holdUntil: o.onlinePayment?.holdUntil || null, instructions: o.onlinePayment?.instructions || null } };
}

// ---------------------------------------------------------------- customer notifications
const SUBJECTS = { placed: "We received your order", paid: "Payment received", ready: "Your order is ready for pickup", dispatched: "Your order is on its way", delivered: "Your order was delivered", cancelled: "Your order was cancelled" };
export async function notifyCustomer({ orgId, orderId, event }) {
  if (!SUBJECTS[event]) return { skipped: true };
  const { salesOrders, orgs } = await getOrgCollections(); const o = await salesOrders.findOne({ _id: toObjectId(orderId), orgId: toObjectId(orgId) });
  if (!o?.customerEmail || o.channel !== "ONLINE") return { skipped: true }; // Shopify / WooCommerce notify their own customers
  if ((o.notified || []).includes(event)) return { skipped: true };
  await salesOrders.updateOne({ _id: o._id }, { $addToSet: { notified: event } });
  const c = await ccol(); const store = o.storeId ? await c.findOne({ _id: o.storeId, kind: OK.store }) : null; const org = await orgs.findOne({ _id: o.orgId }, { projection: { name: 1 } });
  const shop = store?.published?.branding?.name || org?.name || "the shop";
  const extra = event === "placed" && o.onlinePayment?.method === "BANK_TRANSFER" ? `<p>Please pay by bank transfer using your order number <b>${esc(o.orderNumber)}</b> as the reference:</p><p>${esc(o.onlinePayment.instructions || "").replace(/\n/g, "<br>")}</p><p>We hold your items until ${esc(new Date(o.onlinePayment.holdUntil).toUTCString())}.</p>`
    : event === "placed" && o.onlinePayment?.method === "COD" ? "<p>Please have the amount ready when your order arrives (cash on delivery).</p>"
    : event === "dispatched" && o.shipping?.trackingRef ? `<p>Tracking reference: <b>${esc(o.shipping.trackingRef)}</b></p>` : "";
  const html = `<p>Hello,</p><p>${esc(SUBJECTS[event])} — order <b>${esc(o.orderNumber)}</b> from ${esc(shop)}.</p>${extra}<p>Total: ${esc(o.currency)} ${Number(o.total).toFixed(2)}</p><p>Thank you for shopping with ${esc(shop)}.</p>`;
  if (isTestEnv()) return { sent: false, reason: "test_environment", subject: SUBJECTS[event] };
  const { sendEmail } = await import("../email.js");
  return sendEmail({ to: o.customerEmail, subject: `${SUBJECTS[event]} (${o.orderNumber})`, html, text: html.replace(/<[^>]+>/g, " ") });
}

/** Called by the order engine after a staff transition on a channel order: notifies the customer and syncs the status back
 *  to Shopify / WooCommerce (fulfilled / cancelled). Never throws into the caller. */
export async function afterTransition({ orgId, order, action }) {
  try {
    if (!ONLINE_CHANNELS.includes(order?.channel)) return;
    const ev = { ready: "ready", fulfil: order.fulfilmentMethod === "PICKUP" ? null : "dispatched", deliver: "delivered", cancel: "cancelled" }[action];
    if (ev && order.channel === "ONLINE") await notifyCustomer({ orgId, orderId: order.id || sid(order._id), event: ev });
    if (order.channel !== "ONLINE" && ["fulfil", "cancel"].includes(action)) { const { pushOrderStatus } = await import("./channels.js"); await pushOrderStatus({ orgId, orderId: order.id || sid(order._id), action }); }
  } catch (e) { console.error("online afterTransition failed:", e.message); }
}
