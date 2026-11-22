// src/lib/online/checkout.js -- native store checkout (Master SOW 9.4). Everything the shopper sends is re-validated on the
// server: listings must be published in THIS store, prices / tax / promotions come from the pricing engine (priceCart, the same
// one the till uses), stock is reserved by confirming the order (no overselling), delivery cost from the store's zones.
// Duplicate submissions return the first result (idempotency key per checkout). Payment:
//   BANK_TRANSFER  order held (stock reserved) for `holdHours`; staff confirm the money arrived (explicit admin confirmation)
//   COD            cash on delivery; staff record the payment on delivery (optional order-value limit)
//   STRIPE/SAFEPAY hosted checkout on the provider; the order is held 60 minutes and paid only when the provider confirms it
import { getOrgCollections } from "../orgs.js";
import { priceCart } from "../commerce/pricing.js";
import { ccol, oid, sid, clean, nowIso, toMinor, fromMinor, fail } from "../commerce/store.js";
import { OK, countVisit } from "./stores.js";
import { seal, openSafe } from "./crypto.js";
import { ensureCustomer, linesFromPriced, placeOrder, notifyCustomer } from "./orders.js";

export const PAYMENT_METHODS = ["BANK_TRANSFER", "COD", "STRIPE", "SAFEPAY"];
const CARD_HOLD_MINUTES = 60;

function zoneFor(store, zoneId, address) {
  const z = (store.shipping?.zones || []).find((x) => x.id === zoneId); if (!z) return null;
  if (z.countries?.length && !z.countries.includes(String(address?.country || "").toUpperCase())) return null;
  if (z.cities?.length && !z.cities.includes(String(address?.city || "").trim().toLowerCase())) return null;
  return z;
}
export function shippingCost(zone, goodsMinor, weightKg) {
  if (!zone) return 0;
  if (zone.freeOverMinor !== null && zone.freeOverMinor !== undefined && goodsMinor >= zone.freeOverMinor) return 0;
  if (zone.rateType === "free") return 0;
  if (zone.rateType === "weight") return (zone.flatMinor || 0) + Math.round((zone.perKgMinor || 0) * Math.max(0, weightKg));
  return zone.flatMinor || 0;
}

/** Resolves cart lines to products in this store, then prices them with the shared engine. */
export async function quoteCart(store, input = {}) {
  const c = await ccol(); const raw = Array.isArray(input.lines) ? input.lines.slice(0, 100) : [];
  if (!raw.length) return fail("Your cart is empty.");
  const listings = new Map((await c.find({ orgId: store.orgId, kind: OK.listing, storeId: store._id, status: "PUBLISHED", _id: { $in: raw.map((l) => oid(l.listingId)).filter(Boolean) } }).toArray()).map((l) => [sid(l._id), l]));
  const lines = []; let weight = 0; let allDigital = true;
  for (const [i, l] of raw.entries()) {
    const li = listings.get(String(l.listingId)); if (!li) return fail(`Item ${i + 1} is no longer available.`, 409, "UNAVAILABLE");
    const q = Number(l.quantity); if (!(Number.isInteger(q) && q >= 1 && q <= 999)) return fail(`Item ${i + 1}: choose a quantity from 1 to 999.`);
    lines.push({ productId: sid(li.productId), quantity: q }); weight += (li.weightKg || 0) * q; if (!li.digital) allDigital = false;
  }
  const merged = [...lines.reduce((m, l) => m.set(l.productId, (m.get(l.productId) || 0) + l.quantity), new Map())].map(([productId, quantity]) => ({ productId, quantity }));
  const whId = input.fulfilment === "PICKUP" && input.pickupWarehouseId && (store.shipping?.pickup?.warehouseIds || []).includes(String(input.pickupWarehouseId)) ? String(input.pickupWarehouseId) : sid(store.warehouseId);
  const coupons = (Array.isArray(input.coupons) ? input.coupons : []).map((x) => clean(x, 40).toUpperCase()).filter(Boolean).slice(0, 5);
  const priced = await priceCart({ orgId: sid(store.orgId), membership: null, input: { lines: merged, warehouseId: whId, priceListId: store.priceListId ? sid(store.priceListId) : undefined, coupons } });
  if (priced.error) return priced;
  if (priced.approvals?.length) return fail("This cart can't be priced online. Please contact the shop.", 409);
  if (priced.lines.some((l) => l.productType === "GIFT_CARD")) return fail("Gift cards can't be bought online yet.", 409);
  return { priced, weightKg: weight, allDigital, warehouseId: whId, coupons };
}

/** Cart summary for the cart page (no order created). */
export async function cartSummary(store, input = {}) {
  const q = await quoteCart(store, input); if (q.error) return q;
  const zone = input.zoneId ? zoneFor(store, input.zoneId, input.address || {}) : null;
  const goods = q.priced.totals.totalMinor; const ship = q.allDigital || input.fulfilment === "PICKUP" ? 0 : shippingCost(zone, goods, q.weightKg);
  return { currency: q.priced.currency, taxMode: q.priced.taxMode, lines: q.priced.lines.map(({ _minor, ...l }) => l), totals: { ...q.priced.totals, shipping: fromMinor(ship), grandTotal: fromMinor(goods + ship) }, allDigital: q.allDigital, zoneMatched: !!zone };
}

const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || "")) && String(e).length <= 200;
function address(a = {}) { return { line1: clean(a.line1, 200), line2: clean(a.line2, 200), city: clean(a.city, 80), region: clean(a.region, 80), postcode: clean(a.postcode, 20), country: String(a.country || "").toUpperCase().slice(0, 2) }; }

/** Places an order from the shopper's checkout. Returns { orderNumber, token, redirectUrl? }. */
export async function placeCheckout({ store, input = {}, baseUrl, fetchImpl = fetch }) {
  const idem = String(input.idempotencyKey || ""); if (!/^[A-Za-z0-9_-]{16,80}$/.test(idem)) return fail("Missing checkout key; reload the page and try again.");
  const c = await ccol();
  const prior = await c.findOne({ orgId: store.orgId, kind: OK.checkout, idem });
  if (prior) return prior.result ? { ...prior.result, token: openSafe(prior.tokenSealed), duplicate: true } : fail("This checkout is still being processed. Please wait a moment.", 409, "IN_PROGRESS");
  // claim the key first so a double click can't place two orders
  try { await c.insertOne({ orgId: store.orgId, kind: OK.checkout, storeId: store._id, idem, state: "PROCESSING", createdAt: nowIso() }); }
  catch (e) { if (e?.code === 11000) return fail("This checkout is still being processed. Please wait a moment.", 409, "IN_PROGRESS"); throw e; }
  const done = async (result, extra = {}) => { await c.updateOne({ orgId: store.orgId, kind: OK.checkout, idem }, { $set: { state: result.error ? "FAILED" : "PLACED", result: result.error ? null : { orderNumber: result.orderNumber, redirectUrl: result.redirectUrl || null, orderId: result.orderId }, error: result.error || null, ...extra, updatedAt: nowIso() } }); if (result.error) await c.deleteOne({ orgId: store.orgId, kind: OK.checkout, idem, state: "FAILED" }); return result; };

  const cust = input.customer || {}; const name = clean(cust.name, 120); const email = String(cust.email || "").trim().toLowerCase(); const phone = clean(cust.phone, 40);
  if (name.length < 2) return done(fail("Enter your name."));
  if (!validEmail(email)) return done(fail("Enter a valid email address."));
  if (store.checkout?.requirePhone !== false && phone.replace(/\D/g, "").length < 7) return done(fail("Enter a phone number so the shop can reach you about delivery."));
  if (input.acceptTerms !== true) return done(fail("Please accept the terms and privacy policy to place the order."));
  const method = String(input.paymentMethod || ""); const pay = store.payments || {};
  const enabled = { BANK_TRANSFER: pay.bankTransfer?.enabled, COD: pay.cod?.enabled, STRIPE: pay.stripe?.enabled, SAFEPAY: pay.safepay?.enabled };
  if (!PAYMENT_METHODS.includes(method) || !enabled[method]) return done(fail("Choose one of the payment options shown."));
  await countVisit(store._id, store.orgId, "checkoutsStarted");

  const q = await quoteCart(store, input); if (q.error) return done(q);
  const fulfilment = q.allDigital ? "DIGITAL" : input.fulfilment === "PICKUP" ? "PICKUP" : "DELIVERY";
  const addr = address(input.address);
  let zone = null;
  if (fulfilment === "DELIVERY") {
    if (!addr.line1 || !addr.city || !addr.country) return done(fail("Enter the delivery address (street, city and country)."));
    zone = zoneFor(store, String(input.zoneId || ""), addr); if (!zone) return done(fail("We don't deliver to that address with the chosen option. Pick another delivery option or pickup.", 409, "NO_ZONE"));
  } else if (fulfilment === "PICKUP" && !store.shipping?.pickup?.enabled) return done(fail("Pickup isn't offered by this shop."));
  const goodsMinor = q.priced.totals.totalMinor; const shipMinor = fulfilment === "DELIVERY" ? shippingCost(zone, goodsMinor, q.weightKg) : 0; const totalMinor = goodsMinor + shipMinor;
  if (method === "COD" && (fulfilment !== "DELIVERY" || (pay.cod.maxMinor && totalMinor > pay.cod.maxMinor))) return done(fail(fulfilment !== "DELIVERY" ? "Cash on delivery is for delivered orders." : `Cash on delivery is available up to ${store.currency} ${fromMinor(pay.cod.maxMinor).toFixed(2)}. Choose another way to pay.`, 409));
  const window = zone?.windows?.length && input.deliveryWindow && zone.windows.includes(input.deliveryWindow) ? input.deliveryWindow : null;

  const cr = await ensureCustomer({ orgId: sid(store.orgId), departmentId: sid(store.departmentId), name, email, phone, address: fulfilment === "DELIVERY" ? addr : null, source: "online store" }); if (cr.error) return done(cr);
  const { products } = await getOrgCollections(); const prodMap = new Map((await products.find({ _id: { $in: q.priced.lines.map((l) => oid(l.productId)) }, orgId: store.orgId }).toArray()).map((p) => [sid(p._id), p]));
  const { lines, invoiceLines } = linesFromPriced(q.priced, prodMap);
  const now = Date.now();
  const onlinePayment = method === "BANK_TRANSFER" ? { method, state: "PENDING_BANK_TRANSFER", holdUntil: new Date(now + (store.holdHours || 48) * 3600000).toISOString(), instructions: pay.bankTransfer.instructions }
    : method === "COD" ? { method, state: "COD_DUE" }
    : { method, state: "AWAITING_PAYMENT", holdUntil: new Date(now + CARD_HOLD_MINUTES * 60000).toISOString() };
  const placed = await placeOrder({ orgId: sid(store.orgId), departmentId: sid(store.departmentId), warehouseId: q.warehouseId, currency: q.priced.currency, contact: cr.contact, channel: "ONLINE", storeId: sid(store._id),
    lines, invoiceLines, goodsTotalMinor: goodsMinor, taxMinor: toMinor(q.priced.totals.tax), shipping: { method: fulfilment, zoneId: zone?.id || null, zoneName: zone?.name || null, amountMinor: shipMinor, address: fulfilment === "DELIVERY" ? addr : null, window, phone, name },
    onlinePayment, notes: clean(input.notes, 1000) || null, fulfilmentMethod: fulfilment === "PICKUP" ? "PICKUP" : "DELIVERY" });
  if (placed.error) return done(placed);
  if (q.priced.totals.promotions?.length) { const { recordPromotionUses } = await import("../growth/promotions.js"); await recordPromotionUses({ orgId: sid(store.orgId), applied: q.priced.totals.promotions.map((p) => ({ id: p.id, discountMinor: p.discountMinor, code: p.code })), saleId: placed.orderId, customerId: cr.contact._id, revenueMinor: goodsMinor }).catch(() => {}); }

  let redirectUrl = null;
  if (method === "STRIPE" || method === "SAFEPAY") {
    const back = `${baseUrl}/order/${encodeURIComponent(placed.orderNumber)}?t=${encodeURIComponent(placed.publicToken)}`;
    try {
      const { startStripe, startSafepay } = await import("./payments.js");
      const r = method === "STRIPE" ? await startStripe({ store, order: { orderId: placed.orderId, orderNumber: placed.orderNumber, currency: q.priced.currency }, totalMinor, successUrl: `${back}&paid=1`, cancelUrl: `${back}&cancelled=1`, customerEmail: email, fetchImpl })
        : await startSafepay({ store, order: { orderId: placed.orderId, orderNumber: placed.orderNumber, currency: q.priced.currency }, totalMinor, successUrl: `${back}&paid=1`, cancelUrl: `${back}&cancelled=1`, fetchImpl });
      if (r.error) throw Object.assign(new Error(r.error), { status: r.status });
      redirectUrl = r.redirectUrl;
    } catch (e) {
      const { expireOrder } = await import("./orders.js"); await expireOrder({ orgId: sid(store.orgId), orderId: placed.orderId, reason: "Card payment couldn't start" });
      return done(fail(`Card payment couldn't start (${e.message}). Your order was not placed; try again or choose another way to pay.`, 502, "PAYMENT_START"));
    }
  }
  notifyCustomer({ orgId: sid(store.orgId), orderId: placed.orderId, event: "placed" }).catch(() => {});
  return done({ orderNumber: placed.orderNumber, orderId: placed.orderId, token: placed.publicToken, redirectUrl, total: fromMinor(totalMinor), currency: q.priced.currency, paymentMethod: method }, { tokenSealed: seal(placed.publicToken), orderId: oid(placed.orderId) });
}
