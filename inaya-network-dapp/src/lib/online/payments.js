// src/lib/online/payments.js -- card payments through the SHOP'S OWN provider account (owner decision 22 Nov 2026: Stripe for UK
// shops, Safepay for Pakistan shops; no monthly fee; Inaya never holds the money and never sees card data).
//
// Rules (Master SOW 9.5): hosted checkout only (the card is typed on Stripe's / Safepay's page); a browser redirect is never
// proof of payment -- money is recorded only after the provider's API confirms it (webhook signature verified, and the
// payment re-read from the provider); amount, currency and order are checked against what we asked for; one provider payment
// is recorded once (unique provider reference + idempotent order payment); refunds and disputes are reflected on the order.
//   o_payment { orgId, storeId, orderId, provider: "stripe"|"safepay", providerRef, amountMinor, currency, state, history[],
//               fee/net when the provider reports them }
import { createHmac } from "node:crypto";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { ccol, oid, sid, nowIso, fromMinor, audit, fail } from "../commerce/store.js";
import { OK } from "./stores.js";
import { openSafe, safeEqual } from "./crypto.js";
import { recordProviderPayment, expireOrder, SYSTEM_ACTOR, systemMembership } from "./orders.js";

const SAFEPAY = { sandbox: { api: "https://sandbox.api.getsafepay.com", checkout: "https://sandbox.api.getsafepay.com/embedded/" }, production: { api: "https://api.getsafepay.com", checkout: "https://getsafepay.com/embedded/" } };
const form = (obj, prefix = "") => Object.entries(obj).flatMap(([k, v]) => { const key = prefix ? `${prefix}[${k}]` : k; return v !== null && typeof v === "object" ? form(v, key) : v === undefined ? [] : [[key, String(v)]]; });

async function savePayment(doc) { const c = await ccol(); const now = nowIso(); const r = await c.insertOne({ kind: OK.payment, ...doc, history: [{ state: doc.state, at: now }], createdAt: now, updatedAt: now }); return { ...doc, _id: r.insertedId }; }
async function setPaymentState(p, state, extra = {}) { const c = await ccol(); await c.updateOne({ _id: p._id }, { $set: { state, ...extra, updatedAt: nowIso() }, $push: { history: { state, at: nowIso() } } }); }

// ---------------------------------------------------------------- Stripe (Checkout Sessions, the shop's secret key)
async function stripeApi(secret, method, path, body = null, { fetchImpl = fetch, idem = null } = {}) {
  const r = await fetchImpl(`https://api.stripe.com/v1${path}`, { method, headers: { Authorization: `Bearer ${secret}`, ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}), ...(idem ? { "Idempotency-Key": idem } : {}), "Stripe-Version": "2024-06-20" }, body: body ? new URLSearchParams(form(body)).toString() : undefined, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j?.error?.message ? `Stripe: ${j.error.message}` : `Stripe returned ${r.status}`), { status: 502 });
  return j;
}
export async function startStripe({ store, order, totalMinor, successUrl, cancelUrl, customerEmail, fetchImpl = fetch }) {
  const secret = openSafe(store.payments?.stripe?.secretSealed); if (!secret) return fail("Card payments aren't set up for this store.", 409);
  const s = await stripeApi(secret, "POST", "/checkout/sessions", {
    mode: "payment", client_reference_id: order.orderId, customer_email: customerEmail || undefined, success_url: successUrl, cancel_url: cancelUrl,
    expires_at: Math.floor(Date.now() / 1000) + 31 * 60, payment_method_types: { 0: "card" },
    line_items: { 0: { quantity: 1, price_data: { currency: order.currency.toLowerCase(), unit_amount: totalMinor, product_data: { name: `Order ${order.orderNumber}` } } } },
    metadata: { orderId: order.orderId, orgId: sid(store.orgId), storeId: sid(store._id), orderNumber: order.orderNumber },
    payment_intent_data: { metadata: { orderId: order.orderId, orderNumber: order.orderNumber } },
  }, { fetchImpl, idem: `inaya-${order.orderId}` });
  await savePayment({ orgId: store.orgId, storeId: store._id, orderId: toObjectId(order.orderId), provider: "stripe", providerRef: s.id, amountMinor: totalMinor, currency: order.currency, state: "CREATED", mode: store.payments.stripe.mode });
  return { redirectUrl: s.url, providerRef: s.id };
}
/** Stripe-Signature: t=timestamp,v1=hex(HMAC-SHA256(secret, `${t}.${rawBody}`)); 5-minute tolerance. */
export function verifyStripeSignature(rawBody, header, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(String(header).split(",").map((x) => x.split("=")).filter((x) => x.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = String(header).split(",").filter((x) => x.trim().startsWith("v1=")).map((x) => x.trim().slice(3));
  const t = Number(parts.t); if (!Number.isFinite(t) || Math.abs(nowSec - t) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return sigs.some((v) => safeEqual(v, expected));
}

// ---------------------------------------------------------------- Safepay (v3 order API + hosted checkout, the shop's keys)
async function safepayApi(env, secret, method, path, body = null, fetchImpl = fetch) {
  const r = await fetchImpl(`${SAFEPAY[env].api}${path}`, { method, headers: { "X-SFPY-MERCHANT-SECRET": secret, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  const why = (j?.status?.errors || []).join("; ");
  if (r.status === 404 && /merchant with api key|not found/i.test(why)) throw Object.assign(new Error(`Safepay doesn't recognise this store's keys in ${env} mode. Sandbox keys only work with "Sandbox", live keys with "Production": check the environment in the store's payment settings.`), { status: 502 });
  if (!r.ok) throw Object.assign(new Error(`Safepay returned ${r.status}${why ? `: ${why}` : j?.status?.message ? `: ${j.status.message}` : ""}`), { status: 502 });
  return j;
}
export async function startSafepay({ store, order, totalMinor, successUrl, cancelUrl, fetchImpl = fetch }) {
  const sp = store.payments?.safepay || {}; const secret = openSafe(sp.secretSealed); const env = sp.environment;
  if (!secret || !sp.apiKey || !SAFEPAY[env]) return fail("Safepay isn't set up for this store.", 409);
  const init = await safepayApi(env, secret, "POST", "/order/payments/v3/", { merchant_api_key: sp.apiKey, intent: "CYBERSOURCE", mode: "payment", currency: order.currency, amount: totalMinor, metadata: { order_id: order.orderId } }, fetchImpl); // Safepay accepts only known meta keys (order_id); others are rejected (verified on sandbox)
  const tracker = init?.data?.tracker?.token; if (!tracker) throw Object.assign(new Error("Safepay didn't return a checkout session."), { status: 502 });
  const pass = await safepayApi(env, secret, "POST", "/client/passport/v1/token", null, fetchImpl);
  const tbt = typeof pass?.data === "string" ? pass.data : pass?.data?.token; if (!tbt) throw Object.assign(new Error("Safepay didn't return a checkout token."), { status: 502 });
  await savePayment({ orgId: store.orgId, storeId: store._id, orderId: toObjectId(order.orderId), provider: "safepay", providerRef: tracker, amountMinor: totalMinor, currency: order.currency, state: "CREATED", mode: env });
  const q = new URLSearchParams({ environment: env, tracker, tbt, source: "hosted", redirect_url: successUrl, cancel_url: cancelUrl });
  return { redirectUrl: `${SAFEPAY[env].checkout}?${q.toString()}`, providerRef: tracker };
}
/** X-SFPY-SIGNATURE = hex(HMAC-SHA512(webhook shared secret, body)). Safepay's docs sign the JSON payload; we accept the raw body
 *  or its canonical JSON re-serialisation, and in every case re-read the payment from Safepay's API before recording it. */
export function verifySafepaySignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const cands = [rawBody]; try { cands.push(JSON.stringify(JSON.parse(rawBody))); const p = JSON.parse(rawBody); if (p?.data) cands.push(JSON.stringify(p.data)); } catch { /* not JSON */ }
  return cands.some((b) => safeEqual(createHmac("sha512", secret).update(b).digest("hex"), String(header).trim().toLowerCase()));
}

// ---------------------------------------------------------------- reconciliation (the ONLY place money is recorded)
/** Re-reads a payment from the provider and applies the result to the order. Safe to call any number of times. */
export async function reconcilePayment({ paymentId = null, provider = null, providerRef = null, fetchImpl = fetch }) {
  const c = await ccol();
  const p = paymentId ? await c.findOne({ _id: oid(paymentId), kind: OK.payment }) : await c.findOne({ kind: OK.payment, provider, providerRef: String(providerRef || "") });
  if (!p) return fail("Payment not found.", 404);
  const store = await c.findOne({ _id: p.storeId, kind: OK.store }); if (!store) return fail("Store not found.", 404);
  let verdict = null; // { state: "PAID"|"FAILED"|"EXPIRED"|"PENDING"|"REFUNDED"|"DISPUTED", amountMinor, currency, ref, fee, net }
  if (p.provider === "stripe") {
    const secret = openSafe(store.payments?.stripe?.secretSealed); if (!secret) return fail("Stripe key missing.", 409);
    const s = await stripeApi(secret, "GET", `/checkout/sessions/${encodeURIComponent(p.providerRef)}?expand[]=payment_intent.latest_charge.balance_transaction`, null, { fetchImpl });
    const pi = s.payment_intent && typeof s.payment_intent === "object" ? s.payment_intent : null; const ch = pi?.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : null; const bt = ch?.balance_transaction && typeof ch.balance_transaction === "object" ? ch.balance_transaction : null;
    const state = ch?.disputed ? "DISPUTED" : ch?.refunded ? "REFUNDED" : s.payment_status === "paid" ? "PAID" : s.status === "expired" ? "EXPIRED" : "PENDING";
    verdict = { state, amountMinor: s.amount_total, currency: String(s.currency || "").toUpperCase(), ref: pi?.id || s.id, orderId: s.metadata?.orderId || s.client_reference_id, fee: bt?.fee ?? null, net: bt?.net ?? null, refundedMinor: ch?.amount_refunded || 0 };
  } else if (p.provider === "safepay") {
    const sp = store.payments?.safepay || {}; const secret = openSafe(sp.secretSealed); if (!secret || !SAFEPAY[sp.environment]) return fail("Safepay key missing.", 409);
    const r = await safepayApi(sp.environment, secret, "GET", `/reporter/api/v1/payments/${encodeURIComponent(p.providerRef)}`, null, fetchImpl);
    // Shape verified against Safepay sandbox (22 Nov 2026): { data: { state, purchase_totals: { quote_amount: { currency, amount } },
    // metadata: { order_id: { value } }, charge: { amount, fees, net, ... }, events: [...] } } -- amounts are objects, not numbers.
    const t = r?.data?.tracker && typeof r.data.tracker === "object" ? r.data.tracker : r?.data || {}; const st = String(t.state || "").toUpperCase();
    const money = (x) => (x && typeof x === "object" ? { amount: Number(x.amount), currency: String(x.currency || "").toUpperCase() } : { amount: Number(x), currency: "" });
    const q = money(t.purchase_totals?.quote_amount ?? t.charge?.amount ?? t.amount);
    const refunded = (t.events || []).some((e) => /REFUND/i.test(String(e.type || ""))) || /REFUND/.test(st);
    const meta = t.metadata?.order_id; const metaOrder = meta && typeof meta === "object" ? meta.value : meta;
    verdict = { state: refunded ? "REFUNDED" : st === "TRACKER_ENDED" ? "PAID" : /FAIL|CANCEL/.test(st) ? "FAILED" : "PENDING", amountMinor: Number.isFinite(q.amount) ? q.amount : null, currency: q.currency || String(t.currency || "").toUpperCase(), ref: p.providerRef, orderId: metaOrder || null,
      fee: Number.isFinite(Number(t.charge?.fees?.amount)) ? Number(t.charge.fees.amount) : null, net: Number.isFinite(Number(t.charge?.net?.amount)) ? Number(t.charge.net.amount) : null };
  } else return fail("Unknown provider.");

  const orderId = sid(p.orderId);
  if (verdict.state === "PAID" || verdict.state === "REFUNDED" || verdict.state === "DISPUTED") {
    // the provider must confirm exactly what we asked for, for this order
    if (verdict.amountMinor !== p.amountMinor || verdict.currency !== String(p.currency).toUpperCase() || (verdict.orderId && verdict.orderId !== orderId)) {
      await setPaymentState(p, "MISMATCH", { mismatch: { amountMinor: verdict.amountMinor, currency: verdict.currency, orderId: verdict.orderId } });
      await audit({ orgId: p.orgId, actorEmail: SYSTEM_ACTOR, recordType: "ONLINE_PAYMENT", recordId: p._id, action: "PAYMENT_MISMATCH", metadata: { provider: p.provider, expected: p.amountMinor, got: verdict.amountMinor, currency: verdict.currency } });
      return { state: "MISMATCH" };
    }
    if (!["PAID", "REFUNDED", "DISPUTED"].includes(p.state) || p.state !== verdict.state) {
      const rec = await recordProviderPayment({ orgId: sid(p.orgId), orderId, method: "CARD", amountMinor: p.amountMinor, reference: `${p.provider}:${verdict.ref}`, provider: p.provider });
      if (rec.error && /cancelled/i.test(rec.error)) {
        // the customer was charged but the order had already been cancelled: never lose this silently
        await setPaymentState(p, "PAID_AFTER_CANCEL", { paidAt: nowIso(), providerPaymentRef: verdict.ref, fee: verdict.fee ?? null, net: verdict.net ?? null });
        const { salesOrders } = await getOrgCollections();
        await salesOrders.updateOne({ _id: p.orderId }, { $set: { "onlinePayment.state": "PAID_AFTER_CANCEL", "onlinePayment.attention": `The customer paid ${p.currency} ${fromMinor(p.amountMinor).toFixed(2)} through ${p.provider === "stripe" ? "Stripe" : "Safepay"} after this order was cancelled. Refund it in the provider's dashboard, or create the order again and record the payment.`, updatedAt: nowIso() } });
        await audit({ orgId: p.orgId, actorEmail: SYSTEM_ACTOR, recordType: "ONLINE_PAYMENT", recordId: p._id, action: "PAID_AFTER_CANCEL", metadata: { provider: p.provider, amount: fromMinor(p.amountMinor) } });
        return { state: "PAID_AFTER_CANCEL" };
      }
      if (rec.error && !/balance|already paid/i.test(rec.error)) return rec;
      await setPaymentState(p, verdict.state === "PAID" ? "PAID" : verdict.state, { paidAt: p.paidAt || nowIso(), providerPaymentRef: verdict.ref, fee: verdict.fee, net: verdict.net });
    }
    if (verdict.state !== "PAID") await flagOrder(p, verdict);
    return { state: verdict.state };
  }
  if (["FAILED", "EXPIRED"].includes(verdict.state)) { if (p.state !== verdict.state) { await setPaymentState(p, verdict.state); await expireOrder({ orgId: sid(p.orgId), orderId, reason: verdict.state === "FAILED" ? "Card payment failed" : "Card payment not completed" }); } return { state: verdict.state }; }
  return { state: "PENDING" };
}
/** A refund or dispute made in the provider's dashboard is recorded on the order for staff to act on (refunds of the deposit are
 *  then recorded in Inaya; disputes need the shop to respond in the provider's dashboard). */
async function flagOrder(p, verdict) {
  const { salesOrders } = await getOrgCollections();
  await salesOrders.updateOne({ _id: p.orderId }, { $set: { "onlinePayment.state": verdict.state, "onlinePayment.attention": verdict.state === "DISPUTED" ? "The customer disputed this card payment. Respond in your provider's dashboard." : `The provider shows this payment refunded (${fromMinor(verdict.refundedMinor || p.amountMinor)}). Record the refund on the order.`, updatedAt: nowIso() } });
  await audit({ orgId: p.orgId, actorEmail: SYSTEM_ACTOR, recordType: "ONLINE_PAYMENT", recordId: p._id, action: `PAYMENT_${verdict.state}`, metadata: { provider: p.provider } });
}

// ---------------------------------------------------------------- webhooks
export async function stripeWebhook({ storeId, rawBody, signature, fetchImpl = fetch }) {
  const c = await ccol(); const store = await c.findOne({ _id: oid(storeId), kind: OK.store });
  if (!store) return fail("Unknown store.", 404);
  if (!verifyStripeSignature(rawBody, signature, openSafe(store.payments?.stripe?.webhookSecretSealed))) return fail("Invalid signature.", 400);
  let ev; try { ev = JSON.parse(rawBody); } catch { return fail("Invalid payload.", 400); }
  const obj = ev?.data?.object || {};
  const sessionId = obj.object === "checkout.session" ? obj.id : null;
  if (sessionId) { const r = await reconcilePayment({ provider: "stripe", providerRef: sessionId, fetchImpl }); return { received: true, state: r.state || null }; }
  if (["charge.refunded", "charge.dispute.created"].includes(ev.type)) {
    const orderId = obj.metadata?.orderId || null; const p = orderId ? await c.findOne({ kind: OK.payment, provider: "stripe", orderId: oid(orderId) }, { sort: { createdAt: -1 } }) : null;
    if (p) { const r = await reconcilePayment({ paymentId: sid(p._id), fetchImpl }); return { received: true, state: r.state || null }; }
  }
  return { received: true, ignored: ev?.type || null };
}
export async function safepayWebhook({ storeId, rawBody, signature, fetchImpl = fetch }) {
  const c = await ccol(); const store = await c.findOne({ _id: oid(storeId), kind: OK.store });
  if (!store) return fail("Unknown store.", 404);
  if (!verifySafepaySignature(rawBody, signature, openSafe(store.payments?.safepay?.webhookSecretSealed))) return fail("Invalid signature.", 400);
  let ev; try { ev = JSON.parse(rawBody); } catch { return fail("Invalid payload.", 400); }
  const tracker = ev?.data?.tracker || ev?.data?.token || ev?.tracker; if (!tracker) return { received: true, ignored: ev?.type || null };
  const r = await reconcilePayment({ provider: "safepay", providerRef: String(tracker), fetchImpl });
  return { received: true, state: r.state || null };
}

/** Background check for payments still pending (a webhook can be delayed or lost). */
export async function reconcilePending({ olderThanMs = 2 * 60000, fetchImpl = fetch } = {}) {
  const c = await ccol(); const cut = new Date(Date.now() - olderThanMs).toISOString(); let checked = 0, paid = 0;
  const rows = await c.find({ kind: OK.payment, state: "CREATED", createdAt: { $lt: cut } }).limit(200).toArray();
  for (const p of rows) { checked++; try { const r = await reconcilePayment({ paymentId: sid(p._id), fetchImpl }); if (r.state === "PAID") paid++; } catch (e) { console.error("reconcile failed:", p.provider, e.message); } }
  return { checked, paid };
}

/** Settlement view for the shop: each provider payment with fee and net where the provider reports them. */
export async function listPayments({ orgId, membership, days = 60 }) {
  const { commerceAccess } = await import("../commerce/store.js"); const denied = await commerceAccess({ orgId, membership, need: "supervise" }); if (denied) return denied;
  const c = await ccol(); const since = new Date(Date.now() - Math.min(366, Math.max(1, days)) * 86400000).toISOString();
  const rows = await c.find({ orgId: oid(orgId), kind: OK.payment, createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(500).toArray();
  const { salesOrders } = await getOrgCollections(); const ords = new Map((await salesOrders.find({ _id: { $in: rows.map((r) => r.orderId) } }, { projection: { orderNumber: 1 } }).toArray()).map((o) => [sid(o._id), o.orderNumber]));
  const view = rows.map((p) => ({ id: sid(p._id), orderId: sid(p.orderId), orderNumber: ords.get(sid(p.orderId)) || null, provider: p.provider, mode: p.mode, reference: p.providerPaymentRef || p.providerRef, amount: fromMinor(p.amountMinor), currency: p.currency, state: p.state, fee: p.fee === null || p.fee === undefined ? null : fromMinor(p.fee), net: p.net === null || p.net === undefined ? null : fromMinor(p.net), createdAt: p.createdAt, paidAt: p.paidAt || null }));
  const paidRows = view.filter((x) => x.state === "PAID");
  return { payments: view, totals: { paid: paidRows.reduce((n, x) => n + x.amount, 0), fees: paidRows.reduce((n, x) => n + (x.fee || 0), 0), net: paidRows.reduce((n, x) => n + (x.net ?? x.amount), 0), pending: view.filter((x) => x.state === "CREATED").length, mismatched: view.filter((x) => x.state === "MISMATCH").length } };
}
export { systemMembership };
