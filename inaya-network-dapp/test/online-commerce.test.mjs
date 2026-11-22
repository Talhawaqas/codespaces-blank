// test/online-commerce.test.mjs -- Inaya Commerce Phase 5 gate (Master SOW 9.10 + exit gate "a test customer can complete a full
// order lifecycle without data divergence"): browse -> order -> confirmation; price / availability validated server-side; no
// overselling; payment only on provider evidence or explicit staff confirmation; idempotent orders and stock; auditable
// fulfilment and cancellation; customer + finance records correct; no cross-tenant exposure; channel failures visible and
// recoverable. Payment providers and Shopify / WooCommerce are simulated with an injected fetch (no network, no real money).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import * as S from "../src/lib/commerce/store.js";
import * as TAX from "../src/lib/commerce/tax.js";
import { recordStockMovement } from "../src/lib/inventory.js";
import { transitionSalesOrder } from "../src/lib/sales-orders.js";
import * as ST from "../src/lib/online/stores.js";
import * as PUB from "../src/lib/online/public.js";
import * as CO from "../src/lib/online/checkout.js";
import * as ORD from "../src/lib/online/orders.js";
import * as PAY from "../src/lib/online/payments.js";
import * as CH from "../src/lib/online/channels.js";
import { syncLedger } from "../src/lib/ledger.js";

const orgId = new ObjectId(); const ORG = String(orgId); const other = new ObjectId(); const OTHER = String(other);
const owner = { role: "owner", email: "owner@p5.example" }; const fin = { role: "member", financeRole: "staff", commerceRole: "supervisor", email: "fin@p5.example", departmentIds: [] };
let c, dep, w, pShirt, pMug, pService, store, lShirt, lMug, otherStore;
const T = Date.now().toString(36);
const key = () => `chk_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
const so = (id) => c.salesOrders.findOne({ _id: new ObjectId(id) });
const lvl = (p) => c.stockLevels.findOne({ orgId, productId: p, warehouseId: w });
const baseInput = (over = {}) => ({ idempotencyKey: key(), lines: [{ listingId: lShirt.id, quantity: 2 }], customer: { name: "Sara Ali", email: `sara-${T}@p5.example`, phone: "+92 300 1112223" }, address: { line1: "1 Mall Rd", city: "Lahore", country: "PK" }, fulfilment: "DELIVERY", zoneId: "lhr", paymentMethod: "BANK_TRANSFER", acceptTerms: true, ...over });

before(async () => {
  await ensureOrgIndexes(); c = await getOrgCollections(); const now = new Date().toISOString();
  await c.orgs.insertMany([{ _id: orgId, name: "p5 shop", plan: "business", features: { FEATURE_COMMERCE: true }, createdAt: now }, { _id: other, name: "other p5", plan: "business", features: { FEATURE_COMMERCE: true }, createdAt: now }]);
  dep = (await c.departments.insertOne({ orgId, name: "Online", createdAt: now })).insertedId; fin.departmentIds = [dep];
  w = (await c.warehouses.insertOne({ orgId, departmentId: dep, name: "Main", createdAt: now })).insertedId;
  const mk = (x) => c.products.insertOne({ orgId, departmentId: dep, status: "ACTIVE", deletedAt: null, createdAt: now, ...x }).then((r) => r.insertedId);
  pShirt = await mk({ sku: `SH-${T}`, name: "Shirt", unitPrice: 1000, costPrice: 400, notes: "secret supplier note", category: "Clothes" });
  pMug = await mk({ sku: `MG-${T}`, name: "Mug", unitPrice: 500, costPrice: 150, category: "Kitchen" });
  pService = await mk({ sku: `SV-${T}`, name: "Gift wrap", unitPrice: 100, productType: "SERVICE" });
  await recordStockMovement({ orgId: ORG, productId: String(pShirt), warehouseId: String(w), delta: 5, type: "RECEIPT", actorEmail: "t", unitCost: 400 });
  await recordStockMovement({ orgId: ORG, productId: String(pMug), warehouseId: String(w), delta: 50, type: "RECEIPT", actorEmail: "t", unitCost: 150 });
  await S.updateSettings({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { currency: "PKR", taxMode: "exclusive" } });
  await TAX.saveTaxCategory({ orgId: ORG, membership: owner, actorEmail: owner.email, code: "GST", name: "GST", rate: 10, isDefault: true });
  // the other tenant's store
  const od = (await c.departments.insertOne({ orgId: other, name: "X", createdAt: now })).insertedId; await c.warehouses.insertOne({ orgId: other, departmentId: od, name: "X", createdAt: now });
  otherStore = (await ST.createStore({ orgId: OTHER, membership: owner, actorEmail: owner.email, name: "Other", slug: `other-${T}` })).store;
});
after(async () => {
  for (const n of ["orgs", "departments", "warehouses", "products", "crm_contacts", "calendar_records", "stock_levels", "stock_movements", "sales_orders", "journal_entries", "ledger_accounts", "org_activity", "webhook_deliveries", "invoices"]) await c.db.collection(n).deleteMany(n === "orgs" ? { _id: { $in: [orgId, other] } } : { orgId: { $in: [orgId, other] } }).catch(() => {});
  await (await mongoClientPromise).close();
});

test("store setup, publishing gates and a public view that leaks nothing internal or cross-tenant", { timeout: 120000 }, async () => {
  assert.equal((await ST.createStore({ orgId: ORG, membership: { role: "member", email: "x@p5.example" }, actorEmail: "x", name: "Nope" })).status, 403, "only a commerce manager");
  store = (await ST.createStore({ orgId: ORG, membership: owner, actorEmail: owner.email, name: "P5 Shop", slug: `p5-shop-${T}` })).store; assert.ok(store?.id);
  assert.equal((await ST.createStore({ orgId: ORG, membership: owner, actorEmail: owner.email, name: "Again" })).status, 409, "one store per company");
  assert.equal((await ST.createStore({ orgId: OTHER, membership: owner, actorEmail: owner.email, name: "dup", slug: `p5-shop-${T}` })).status, 409, "slugs are unique across companies");
  lShirt = (await ST.saveListing({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { productId: String(pShirt), status: "PUBLISHED", description: "Cotton shirt", images: ["https://img.example/shirt.jpg", "http://insecure.example/x.jpg"], weightKg: 0.5 } })).listing;
  assert.deepEqual(lShirt.images, ["https://img.example/shirt.jpg"], "only https images");
  lMug = (await ST.saveListing({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { productId: String(pMug), status: "PUBLISHED", onlinePrice: 450, compareAtPrice: 500 } })).listing;
  assert.equal(lMug.onlinePrice, 450);
  assert.match((await ST.publishStore({ orgId: ORG, membership: owner, actorEmail: owner.email, action: "publish" })).error, /way to pay/);
  await ST.updatePayments({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { bankTransfer: { enabled: true, instructions: "Meezan Bank, P5 Shop, PK00MEZN0000000000000000" }, cod: { enabled: true, maxOrder: 2500 } } });
  await ST.updateStore({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { shipping: { zones: [{ id: "lhr", name: "Lahore", countries: ["PK"], cities: ["Lahore"], rateType: "flat", flat: 200, freeOver: 5000 }, { id: "pk", name: "Pakistan", countries: ["PK"], rateType: "weight", flat: 100, perKg: 200 }], pickup: { enabled: true, warehouseIds: [String(w)] } } } });
  assert.match((await ST.publishStore({ orgId: ORG, membership: owner, actorEmail: owner.email, action: "publish" })).error, /privacy policy/);
  await ST.updateStore({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { content: { pages: { privacy: "We keep your data safe.", terms: "Standard terms." } } } });
  assert.equal(await PUB.resolveStore({ slug: `p5-shop-${T}` }), null, "a draft store is invisible");
  assert.equal((await ST.publishStore({ orgId: ORG, membership: owner, actorEmail: owner.email, action: "publish" })).store.status, "PUBLISHED");
  const s = await PUB.resolveStore({ slug: `p5-shop-${T}` }); const cat = await PUB.publicCatalogue(s, {});
  assert.equal(cat.items.length, 2);
  const blob = JSON.stringify(cat) + JSON.stringify(await PUB.publicProduct(s, lShirt.slug)) + JSON.stringify(PUB.publicStore(s));
  for (const bad of ["costPrice", "400", "secret supplier", "Meezan", "quantity\":5"]) assert.ok(!blob.includes(bad), `public view must not contain ${bad}`);
  assert.equal(cat.items.find((x) => x.title === "Mug").price, 450, "online price from the store's price list");
  assert.equal((await PUB.publicProduct(s, lShirt.slug)).available.label, "In stock");
  const os = await PUB.resolveStore({ slug: `other-${T}`, preview: true });
  assert.equal((await PUB.publicCatalogue(os, {})).items.length, 0, "another company's store sees none of these listings");
  assert.equal(await PUB.publicProduct(os, lShirt.slug), null);
});

test("bank-transfer checkout: server-side pricing, delivery, reservation, idempotency, staff confirmation, invoice = charged, ledger", { timeout: 180000 }, async () => {
  const s = await PUB.resolveStore({ slug: `p5-shop-${T}` });
  const inp = baseInput({ lines: [{ listingId: lShirt.id, quantity: 2, price: 1 }, { listingId: lMug.id, quantity: 1 }] }); // a tampered price is ignored
  const r = await CO.placeCheckout({ store: s, input: inp, baseUrl: "https://shop.test" }); assert.ok(!r.error, r.error);
  assert.equal(r.total, (2000 + 450) * 1.1 + 200, "goods + 10% tax + Lahore flat delivery");
  const again = await CO.placeCheckout({ store: s, input: inp, baseUrl: "https://shop.test" }); assert.equal(again.orderNumber, r.orderNumber, "a double submit returns the same order"); assert.ok(again.duplicate);
  assert.equal(await c.salesOrders.countDocuments({ orgId, channel: "ONLINE", status: { $ne: "CANCELLED" } }), 1, "only one order exists");
  const o = await so(r.orderId); assert.equal(o.status, "CONFIRMED"); assert.equal(o.onlinePayment.state, "PENDING_BANK_TRANSFER");
  assert.equal((await lvl(pShirt)).reserved, 2, "stock reserved for the order");
  const contact = await c.crmContacts.findOne({ _id: o.contactId }); assert.equal(contact.email, `sara-${T}@p5.example`); assert.equal(contact.orgId.toString(), ORG);
  const st = await ORD.orderByToken({ orgId: ORG, orderNumber: r.orderNumber, token: r.token }); assert.equal(st.payment.state, "PENDING_BANK_TRANSFER"); assert.match(st.payment.instructions, /Meezan/);
  assert.equal(await ORD.orderByToken({ orgId: ORG, orderNumber: r.orderNumber, token: "wrong" }), null, "the status page needs the private token");
  // staff confirm the transfer arrived (finance access) -> payment recorded as a customer deposit
  const pay = await transitionSalesOrder({ orgId: ORG, orderId: r.orderId, action: "payment", membership: fin, actorEmail: fin.email, input: { method: "BANK_TRANSFER", amount: r.total, reference: "MEZN-778" } }); assert.ok(!pay.error, pay.error);
  // fulfil -> invoice equals what was charged (lines at net + per-line tax + delivery)
  assert.ok(!(await transitionSalesOrder({ orgId: ORG, orderId: r.orderId, action: "fulfil", membership: owner, actorEmail: owner.email })).error);
  assert.equal((await lvl(pShirt)).quantity, 3); assert.equal((await lvl(pShirt)).reserved, 0);
  const inv = await transitionSalesOrder({ orgId: ORG, orderId: r.orderId, action: "invoice", membership: owner, actorEmail: owner.email }); assert.ok(!inv.error, inv.error);
  const invoice = await c.invoices.findOne({ relatedSalesOrderId: new ObjectId(r.orderId) }); assert.equal(invoice.total, r.total, "invoice total = checkout total");
  await syncLedger(ORG);
  const lines = (await c.db.collection("journal_entries").find({ orgId }).toArray()).flatMap((e) => e.lines);
  assert.ok(lines.some((l) => l.accountCode === "2200"), "the payment sits in Customer Deposits");
});

test("no overselling, delivery rules, COD limit, unpaid orders expire and release stock", { timeout: 180000 }, async () => {
  const s = await PUB.resolveStore({ slug: `p5-shop-${T}` });
  const over = await CO.placeCheckout({ store: s, input: baseInput({ lines: [{ listingId: lShirt.id, quantity: 4 }] }), baseUrl: "https://shop.test" });
  assert.equal(over.code, "OUT_OF_STOCK"); assert.equal((await lvl(pShirt)).reserved, 0, "nothing reserved by a failed checkout");
  assert.equal((await CO.placeCheckout({ store: s, input: baseInput({ address: { line1: "x", city: "Karachi", country: "PK" } }), baseUrl: "https://shop.test" })).code, "NO_ZONE", "the Lahore zone doesn't cover Karachi");
  const ship = await CO.cartSummary(s, { lines: [{ listingId: lShirt.id, quantity: 1 }], zoneId: "pk", address: { city: "Karachi", country: "PK" } });
  assert.equal(ship.totals.shipping, 100 + 0.5 * 200, "weight-based zone");
  assert.match((await CO.placeCheckout({ store: s, input: baseInput({ paymentMethod: "COD", lines: [{ listingId: lShirt.id, quantity: 3 }] }), baseUrl: "https://shop.test" })).error, /up to/);
  assert.match((await CO.placeCheckout({ store: s, input: baseInput({ paymentMethod: "STRIPE" }), baseUrl: "https://shop.test" })).error, /payment options/, "a provider that isn't switched on can't be used");
  const cod = await CO.placeCheckout({ store: s, input: baseInput({ paymentMethod: "COD", lines: [{ listingId: lMug.id, quantity: 2 }] }), baseUrl: "https://shop.test" }); assert.ok(!cod.error, cod.error);
  assert.equal((await so(cod.orderId)).onlinePayment.state, "COD_DUE");
  const bank = await CO.placeCheckout({ store: s, input: baseInput({ lines: [{ listingId: lShirt.id, quantity: 1 }] }), baseUrl: "https://shop.test" }); assert.ok(!bank.error);
  assert.equal((await lvl(pShirt)).reserved, 1);
  const r = await ORD.expireDueOrders({ now: new Date(Date.now() + 49 * 3600000), orgId: ORG }); // only this test company: never touch other data in the test database assert.ok(r.expired >= 1);
  const o = await so(bank.orderId); assert.equal(o.status, "CANCELLED"); assert.equal(o.onlinePayment.state, "EXPIRED"); assert.equal((await lvl(pShirt)).reserved, 0, "expiry released the reservation");
  assert.equal((await so(cod.orderId)).status, "CONFIRMED", "cash-on-delivery orders don't expire");
});

function stripeMock(state) {
  return async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/v1/checkout/sessions") && init.method === "POST") { state.created = new URLSearchParams(init.body); state.idem = init.headers["Idempotency-Key"]; return new Response(JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.test/cs_test_1" }), { status: 200 }); }
    if (u.includes("/v1/checkout/sessions/cs_test_1")) return new Response(JSON.stringify({ id: "cs_test_1", payment_status: state.paid ? "paid" : "unpaid", status: state.paid ? "complete" : "open", amount_total: state.amount, currency: "pkr", client_reference_id: state.orderId, metadata: { orderId: state.orderId }, payment_intent: state.paid ? { id: "pi_1", latest_charge: { refunded: !!state.refunded, disputed: false, amount_refunded: state.refunded ? state.amount : 0, balance_transaction: { fee: 1234, net: state.amount - 1234 } } } : null }), { status: 200 });
    return new Response("{}", { status: 404 });
  };
}
const stripeSig = (body, secret, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

test("Stripe: hosted checkout, signed webhook, money only after the provider confirms, exactly once, mismatch held", { timeout: 180000 }, async () => {
  const WH = "whsec_testsecret1234567890";
  assert.match((await ST.updatePayments({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { stripe: { enabled: true } } })).error, /secret key/);
  const set = await ST.updatePayments({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { stripe: { secretKey: "sk_test_abcdefghijklmnop", webhookSecret: WH, enabled: true } } });
  assert.equal(set.store.payments.stripe.keyHint, "…mnop"); assert.ok(!JSON.stringify(set).includes("sk_test_abcdefghijklmnop"), "the key is never echoed");
  const s = await PUB.resolveStore({ slug: `p5-shop-${T}` }); const state = { paid: false };
  const r = await CO.placeCheckout({ store: s, input: baseInput({ paymentMethod: "STRIPE", lines: [{ listingId: lMug.id, quantity: 1 }] }), baseUrl: "https://shop.test", fetchImpl: stripeMock(state) });
  assert.ok(!r.error, r.error); assert.equal(r.redirectUrl, "https://checkout.stripe.test/cs_test_1");
  assert.equal(state.created.get("line_items[0][price_data][unit_amount]"), String(Math.round(r.total * 100))); assert.equal(state.idem, `inaya-${r.orderId}`);
  Object.assign(state, { orderId: r.orderId, amount: Math.round(r.total * 100) });
  const body = JSON.stringify({ type: "checkout.session.completed", data: { object: { object: "checkout.session", id: "cs_test_1" } } });
  assert.equal((await PAY.stripeWebhook({ storeId: s._id, rawBody: body, signature: stripeSig(body, "whsec_wrong") })).status, 400, "bad signature rejected");
  assert.equal((await PAY.stripeWebhook({ storeId: s._id, rawBody: body, signature: stripeSig(body, WH, Math.floor(Date.now() / 1000) - 600) })).status, 400, "stale timestamp rejected");
  const early = await PAY.stripeWebhook({ storeId: s._id, rawBody: body, signature: stripeSig(body, WH), fetchImpl: stripeMock(state) }); assert.equal(early.state, "PENDING", "unpaid at Stripe -> nothing recorded");
  assert.equal((await so(r.orderId)).payments.length, 0);
  state.paid = true;
  for (let i = 0; i < 2; i++) assert.equal((await PAY.stripeWebhook({ storeId: s._id, rawBody: body, signature: stripeSig(body, WH), fetchImpl: stripeMock(state) })).state, "PAID");
  const o = await so(r.orderId); assert.equal(o.payments.length, 1, "recorded exactly once"); assert.equal(o.payments[0].method, "CARD"); assert.equal(o.onlinePayment.state, "PAID");
  const list = await PAY.listPayments({ orgId: ORG, membership: owner }); assert.equal(list.payments[0].fee, 12.34, "settlement fee from Stripe");
  // a session whose amount doesn't match what we asked for is held, not recorded
  const s2 = await CO.placeCheckout({ store: s, input: baseInput({ paymentMethod: "STRIPE", lines: [{ listingId: lMug.id, quantity: 2 }] }), baseUrl: "https://shop.test", fetchImpl: async (u, i) => (String(u).endsWith("/sessions") ? new Response(JSON.stringify({ id: "cs_test_2", url: "https://x" }), { status: 200 }) : new Response("{}")) });
  const p2 = await c.db.collection("calendar_records").findOne({ kind: "o_payment", providerRef: "cs_test_2" });
  const mm = await PAY.reconcilePayment({ paymentId: String(p2._id), fetchImpl: async () => new Response(JSON.stringify({ id: "cs_test_2", payment_status: "paid", amount_total: 1, currency: "pkr", metadata: { orderId: s2.orderId } }), { status: 200 }) });
  assert.equal(mm.state, "MISMATCH"); assert.equal((await so(s2.orderId)).payments.length, 0);
  // refund made in Stripe's dashboard is flagged on the order
  state.refunded = true; await PAY.reconcilePayment({ provider: "stripe", providerRef: "cs_test_1", fetchImpl: stripeMock(state) });
  assert.match((await so(r.orderId)).onlinePayment.attention, /refunded/);
  // a card order is never expired while the provider says it was paid; a payment confirmed after cancellation is flagged, not lost
  const st3 = { paid: true }; const s3 = await CO.placeCheckout({ store: s, input: baseInput({ paymentMethod: "STRIPE", lines: [{ listingId: lMug.id, quantity: 1 }] }), baseUrl: "https://shop.test", fetchImpl: async (u, i) => (String(u).endsWith("/sessions") ? new Response(JSON.stringify({ id: "cs_test_3", url: "https://x" }), { status: 200 }) : new Response("{}")) });
  Object.assign(st3, { orderId: s3.orderId, amount: Math.round(s3.total * 100) });
  const mock3 = async () => new Response(JSON.stringify({ id: "cs_test_3", payment_status: "paid", amount_total: st3.amount, currency: "pkr", metadata: { orderId: st3.orderId }, payment_intent: { id: "pi_3", latest_charge: { refunded: false, disputed: false, balance_transaction: { fee: 100, net: st3.amount - 100 } } } }), { status: 200 });
  const ex = await ORD.expireDueOrders({ now: new Date(Date.now() + 2 * 3600000), orgId: ORG, fetchImpl: mock3 }); assert.equal(ex.keptBecausePaidOrUnconfirmed, 1);
  assert.equal((await so(s3.orderId)).status, "CONFIRMED"); assert.equal((await so(s3.orderId)).payments.length, 1, "paid at the last minute: kept and recorded");
  const s4 = await CO.placeCheckout({ store: s, input: baseInput({ paymentMethod: "STRIPE", lines: [{ listingId: lMug.id, quantity: 1 }] }), baseUrl: "https://shop.test", fetchImpl: async (u) => (String(u).endsWith("/sessions") ? new Response(JSON.stringify({ id: "cs_test_4", url: "https://x" }), { status: 200 }) : new Response("{}")) });
  await ORD.expireOrder({ orgId: ORG, orderId: s4.orderId, reason: "test" });
  const late = await PAY.reconcilePayment({ provider: "stripe", providerRef: "cs_test_4", fetchImpl: async () => new Response(JSON.stringify({ id: "cs_test_4", payment_status: "paid", amount_total: Math.round(s4.total * 100), currency: "pkr", metadata: { orderId: s4.orderId }, payment_intent: { id: "pi_4", latest_charge: {} } }), { status: 200 }) });
  assert.equal(late.state, "PAID_AFTER_CANCEL"); assert.match((await so(s4.orderId)).onlinePayment.attention, /after this order was cancelled/);
});

test("Safepay: tracker + hosted URL, SHA-512 webhook signature, paid only when the reporter API says TRACKER_ENDED", { timeout: 120000 }, async () => {
  const WH = "safepay-endpoint-shared-secret-123";
  await ST.updatePayments({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { safepay: { environment: "sandbox", apiKey: "sec_test_pubkey_123", secretKey: "safepay-secret-key-abcdef", webhookSecret: WH, enabled: true } } });
  const s = await PUB.resolveStore({ slug: `p5-shop-${T}` }); const st = { ended: false };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url); assert.equal(init.headers["X-SFPY-MERCHANT-SECRET"], "safepay-secret-key-abcdef");
    if (u.endsWith("/order/payments/v3/")) { st.init = JSON.parse(init.body); return new Response(JSON.stringify({ data: { tracker: { token: "track_abc" } } }), { status: 200 }); }
    if (u.endsWith("/client/passport/v1/token")) return new Response(JSON.stringify({ data: "tbt_xyz" }), { status: 200 });
    if (u.includes("/reporter/api/v1/payments/track_abc")) return new Response(JSON.stringify({ ok: true, data: { state: st.ended ? "TRACKER_ENDED" : "TRACKER_STARTED", metadata: { order_id: { key: "order_id", value: st.orderId } }, purchase_totals: { quote_amount: { currency: "PKR", amount: st.amount } }, charge: st.ended ? { amount: { currency: "PKR", amount: st.amount }, fees: { currency: "PKR", amount: 1234 }, net: { currency: "PKR", amount: st.amount - 1234 } } : undefined } }), { status: 200 }); // shape as returned by the Safepay sandbox
    return new Response("{}", { status: 404 });
  };
  const r = await CO.placeCheckout({ store: s, input: baseInput({ paymentMethod: "SAFEPAY", lines: [{ listingId: lMug.id, quantity: 1 }] }), baseUrl: "https://shop.test", fetchImpl }); assert.ok(!r.error, r.error);
  assert.equal(st.init.amount, Math.round(r.total * 100), "amount in the lowest denomination"); assert.equal(st.init.merchant_api_key, "sec_test_pubkey_123");
  const u = new URL(r.redirectUrl); assert.equal(u.origin + u.pathname, "https://sandbox.api.getsafepay.com/embedded/"); assert.equal(u.searchParams.get("tracker"), "track_abc"); assert.equal(u.searchParams.get("tbt"), "tbt_xyz");
  Object.assign(st, { orderId: r.orderId, amount: Math.round(r.total * 100) });
  const body = JSON.stringify({ type: "payment.succeeded", data: { tracker: "track_abc", state: "TRACKER_ENDED" } }); const sig = createHmac("sha512", WH).update(body).digest("hex");
  assert.equal((await PAY.safepayWebhook({ storeId: s._id, rawBody: body, signature: "00" + sig.slice(2) })).status, 400);
  assert.equal((await PAY.safepayWebhook({ storeId: s._id, rawBody: body, signature: sig, fetchImpl })).state, "PENDING", "the webhook alone isn't proof: the reporter API still says started");
  st.ended = true; assert.equal((await PAY.safepayWebhook({ storeId: s._id, rawBody: body, signature: sig, fetchImpl })).state, "PAID");
  assert.equal((await so(r.orderId)).payments.length, 1);
});

function shopifyMock(st) {
  return async (url, init = {}) => {
    const q = JSON.parse(init.body || "{}"); const text = q.query || ""; const ok = (data) => new Response(JSON.stringify({ data }), { status: 200 });
    if (st.piiBlock && /customer {/.test(text)) return new Response(JSON.stringify({ errors: [{ message: "This app is not approved to access the Customer object." }] }), { status: 200 });
    if (/shop \{ name/.test(text)) return ok({ shop: { name: "Dev store", currencyCode: "PKR" }, locations: { nodes: [{ id: "gid://shopify/Location/1", name: "Shop", isActive: true }] } });
    if (/products\(first: 50/.test(text)) return ok({ products: { pageInfo: { hasNextPage: false }, nodes: [{ id: "gid://shopify/Product/10", title: "Shirt", status: "ACTIVE", variants: { nodes: [{ id: "gid://shopify/ProductVariant/11", sku: `SH-${T}`, price: st.shopifyPrice || "1000.00", title: "Default Title", inventoryItem: { id: "gid://shopify/InventoryItem/12" } }] } }, { id: "gid://shopify/Product/20", title: "Hat", status: "ACTIVE", variants: { nodes: [{ id: "gid://shopify/ProductVariant/21", sku: `HAT-${T}`, price: "300.00", title: "Default Title", inventoryItem: { id: "gid://shopify/InventoryItem/22" } }] } }] } });
    if (/inventoryActivate/.test(text)) return ok({ inventoryActivate: { userErrors: [] } });
    if (/inventorySetQuantities/.test(text)) { st.stock = q.variables.in.quantities; return ok({ inventorySetQuantities: { userErrors: [] } }); }
    if (/order\(id: \$id\) \{ fulfillmentOrders/.test(text)) return ok({ order: { fulfillmentOrders: { nodes: [{ id: "gid://shopify/FulfillmentOrder/1", status: "OPEN" }] } } });
    if (/fulfillmentCreate/.test(text)) { st.fulfilled = q.variables.f; return ok({ fulfillmentCreate: { fulfillment: { id: "f1" }, userErrors: [] } }); }
    if (/query\(\$id: ID!\) \{ order\(id: \$id\)/.test(text)) return ok({ order: st.order });
    if (/orders\(first: 25/.test(text)) return ok({ orders: { pageInfo: { hasNextPage: false }, nodes: st.order ? [st.order] : [] } });
    return ok({});
  };
}
const shopOrder = (over = {}) => ({ id: "gid://shopify/Order/900", name: "#1001", email: "buyer@p5.example", phone: null, createdAt: new Date().toISOString(), cancelledAt: null, displayFinancialStatus: "PAID", currencyCode: "PKR",
  totalPriceSet: { shopMoney: { amount: "2350.00" } }, totalTaxSet: { shopMoney: { amount: "200.00" } }, totalShippingPriceSet: { shopMoney: { amount: "150.00" } }, customer: { firstName: "Buyer", lastName: "One", email: "buyer@p5.example", phone: null },
  shippingAddress: { name: "Buyer One", address1: "5 Canal Rd", address2: null, city: "Lahore", province: "Punjab", zip: "54000", countryCodeV2: "PK", phone: null },
  lineItems: { nodes: [{ id: "gid://shopify/LineItem/1", sku: `SH-${T}`, name: "Shirt", quantity: 2, variant: { id: "gid://shopify/ProductVariant/11" }, discountedTotalSet: { shopMoney: { amount: "2000.00" } }, taxLines: [{ rate: 0.1, priceSet: { shopMoney: { amount: "200.00" } } }] }] }, ...over });

test("Shopify: plan limit, match by SKU, stock push, order import once (backorder-safe), fulfilment pushed back, channel cancel releases stock", { timeout: 240000 }, async () => {
  const st = {}; const fetchImpl = shopifyMock(st); const realFetch = globalThis.fetch; globalThis.fetch = fetchImpl; // background status sync uses the global fetch: keep it offline
  try {
  const bad = await CH.connectChannel({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { platform: "SHOPIFY", shopDomain: "p5.myshopify.com", accessToken: "nope", apiSecret: "x" }, fetchImpl }); assert.match(bad.error, /shpat_/);
  const ch = (await CH.connectChannel({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { platform: "SHOPIFY", shopDomain: "https://p5.myshopify.com/", accessToken: "shpat_abcdefghijklmnopqrstuvwx", apiSecret: "shopify-app-secret-123456" }, fetchImpl })).channel;
  assert.equal(ch.address, "p5.myshopify.com"); assert.equal(ch.locationId, "gid://shopify/Location/1");
  const second = await CH.connectChannel({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { platform: "SHOPIFY", shopDomain: "p5b.myshopify.com", accessToken: "shpat_abcdefghijklmnopqrstuvwx", apiSecret: "shopify-app-secret-123456" }, fetchImpl });
  assert.equal(second.code, "CHANNEL_LIMIT", "Business includes one Shopify store");
  const pull = await CH.pullProducts({ orgId: ORG, membership: owner, id: ch.id, fetchImpl }); assert.equal(pull.matched, 1); assert.equal(pull.unmatched[0].sku, `HAT-${T}`);
  const imp = await CH.importUnmatched({ orgId: ORG, membership: owner, actorEmail: owner.email, id: ch.id, items: pull.unmatched }); assert.ok(imp.results[0].ok);
  const free = (await lvl(pShirt)).quantity - ((await lvl(pShirt)).reserved || 0);
  await CH.syncStockNow({ orgId: ORG, membership: owner, id: ch.id, force: true, fetchImpl });
  assert.equal(st.stock.find((x) => x.inventoryItemId === "gid://shopify/InventoryItem/12").quantity, free, "Shopify gets Inaya's available stock");
  // price edited in Shopify while Inaya is the price master -> a conflict for a person to resolve
  st.shopifyPrice = "1100.00"; const pull2 = await CH.pullProducts({ orgId: ORG, membership: owner, id: ch.id, fetchImpl }); assert.equal(pull2.conflicts, 1);
  const cf = (await CH.listConflicts({ orgId: ORG, membership: owner })).conflicts[0]; assert.equal(cf.channelValue, 1100);
  assert.ok((await CH.resolveConflict({ orgId: ORG, membership: owner, actorEmail: owner.email, id: cf.id, keep: "channel" })).ok);
  assert.equal((await c.products.findOne({ _id: pShirt })).unitPrice, 1100, "Shopify's price adopted");
  // order webhook: signature, import once, stock reserved, paid on Shopify -> payment recorded
  st.order = shopOrder(); const body = JSON.stringify({ id: 900, admin_graphql_api_id: "gid://shopify/Order/900" });
  const hdr = (sig) => new Headers({ "x-shopify-hmac-sha256": sig, "x-shopify-topic": "orders/create" });
  assert.equal((await CH.channelWebhook({ platform: "SHOPIFY", channelId: ch.id, rawBody: body, headers: hdr("bad"), fetchImpl })).status, 401);
  const sig = createHmac("sha256", "shopify-app-secret-123456").update(body).digest("base64");
  const w1 = await CH.channelWebhook({ platform: "SHOPIFY", channelId: ch.id, rawBody: body, headers: hdr(sig), fetchImpl }); assert.match(w1.summary, /imported as SHP-/);
  await CH.channelWebhook({ platform: "SHOPIFY", channelId: ch.id, rawBody: body, headers: hdr(sig), fetchImpl }); await CH.syncOrdersNow({ orgId: ORG, membership: owner, id: ch.id, fetchImpl });
  const imported = await c.salesOrders.find({ orgId, channel: "SHOPIFY" }).toArray(); assert.equal(imported.length, 1, "webhook twice + polling = one order");
  const o = imported[0]; assert.equal(o.total, 2350); assert.equal(o.payments.length, 1, "paid on Shopify -> recorded"); assert.equal(o.lines[0].reservedQty, 2);
  // fulfil in Inaya -> fulfilment created in Shopify (status sync is asynchronous; wait for it)
  assert.ok(!(await transitionSalesOrder({ orgId: ORG, orderId: String(o._id), action: "fulfil", membership: owner, actorEmail: owner.email })).error);
  for (let i = 0; i < 50 && !st.fulfilled; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(st.fulfilled.lineItemsByFulfillmentOrder[0].fulfillmentOrderId, "gid://shopify/FulfillmentOrder/1");
  // a second order cancelled on Shopify after import: refund recorded, order cancelled, reservation released
  st.order = shopOrder({ id: "gid://shopify/Order/901", name: "#1002", lineItems: { nodes: [{ ...shopOrder().lineItems.nodes[0], quantity: 1, discountedTotalSet: { shopMoney: { amount: "1000.00" } }, taxLines: [{ rate: 0.1, priceSet: { shopMoney: { amount: "100.00" } } }] }] }, totalPriceSet: { shopMoney: { amount: "1250.00" } }, totalTaxSet: { shopMoney: { amount: "100.00" } } });
  await CH.syncOrdersNow({ orgId: ORG, membership: owner, id: ch.id, fetchImpl }); const reservedBefore = (await lvl(pShirt)).reserved; assert.ok(reservedBefore >= 1);
  st.order = { ...st.order, cancelledAt: new Date().toISOString(), displayFinancialStatus: "REFUNDED" };
  await CH.syncOrdersNow({ orgId: ORG, membership: owner, id: ch.id, fetchImpl });
  const o2 = await c.salesOrders.findOne({ orgId, externalOrderId: "gid://shopify/Order/901" }); assert.equal(o2.status, "CANCELLED"); assert.equal((await lvl(pShirt)).reserved, reservedBefore - 1);
  // Basic-plan stores withhold customer details from self-made apps: the order still imports, without them
  st.piiBlock = true; const { customer: _c, shippingAddress: _a, email: _e, ...noPii } = shopOrder({ id: "gid://shopify/Order/902", name: "#1003" }); st.order = noPii;
  await CH.syncOrdersNow({ orgId: ORG, membership: owner, id: ch.id, fetchImpl });
  const o3 = await c.salesOrders.findOne({ orgId, externalOrderId: "gid://shopify/Order/902" }); assert.ok(o3, "imported without customer details"); assert.match(o3.customerEmail, /customer.invalid$/);
  await new Promise((r) => setTimeout(r, 1500)); } finally { globalThis.fetch = realFetch; }
});

test("WooCommerce: signed webhooks, an unmapped SKU fails visibly and recovers on retry, order cap counted", { timeout: 180000 }, async () => {
  const st = { order: null };
  const wooOrder = { id: 77, number: "77", status: "processing", currency: "PKR", date_paid: new Date().toISOString(), date_created_gmt: "2026-11-22T10:00:00", total: "1650.00", total_tax: "150.00", shipping_total: "0.00", shipping_tax: "0.00", billing: { first_name: "Woo", last_name: "Buyer", email: "woo@p5.example", phone: "0300" }, shipping: { address_1: "9 Gulberg", city: "Lahore", country: "PK" }, line_items: [{ id: 1, product_id: 501, variation_id: 0, sku: `MUG-WOO-${T}`, name: "Mug", quantity: 3, total: "1500.00", total_tax: "150.00" }] };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url); assert.ok(init.headers.Authorization.startsWith("Basic "));
    if (u.includes("settings/general/woocommerce_currency")) return new Response(JSON.stringify({ value: "PKR" }), { status: 200 });
    if (u.includes("/orders/77")) return new Response(JSON.stringify(wooOrder), { status: 200 });
    if (u.includes("/products?per_page=100&page=1")) return new Response(JSON.stringify([{ id: 501, type: "simple", name: "Mug", sku: `MUG-WOO-${T}`, regular_price: "500", status: "publish" }]), { status: 200 });
    if (u.includes("/products/batch")) { st.batch = JSON.parse(init.body); return new Response("{}", { status: 200 }); }
    if (u.includes("/webhooks")) return new Response(init.method === "GET" ? "[]" : "{}", { status: 200 });
    return new Response("[]", { status: 200 });
  };
  const ch = (await CH.connectChannel({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { platform: "WOOCOMMERCE", siteUrl: "https://woo.example", consumerKey: "ck_0123456789abcdef0123456789", consumerSecret: "cs_0123456789abcdef0123456789" }, fetchImpl })).channel; assert.ok(ch?.id);
  const reg = await CH.registerWebhooks({ orgId: ORG, membership: owner, actorEmail: owner.email, id: ch.id, baseUrl: "https://app.test", fetchImpl }); assert.match(reg.callbackUrl, /\/api\/shop\/channels\/woocommerce\//);
  const secret = (await import("../src/lib/online/crypto.js")).openSafe((await c.db.collection("calendar_records").findOne({ _id: new ObjectId(ch.id) })).webhookSecretSealed);
  const body = JSON.stringify({ id: 77 }); const sig = createHmac("sha256", secret).update(body).digest("base64"); const hdr = new Headers({ "x-wc-webhook-signature": sig, "x-wc-webhook-topic": "order.created" });
  assert.ok((await CH.channelWebhook({ platform: "WOOCOMMERCE", channelId: ch.id, rawBody: "webhook_id=5", headers: new Headers(), fetchImpl })).ping);
  const first = await CH.channelWebhook({ platform: "WOOCOMMERCE", channelId: ch.id, rawBody: body, headers: hdr, fetchImpl }); assert.ok(first.queued, "unmapped SKU -> queued, not lost");
  const log = await CH.syncLog({ orgId: ORG, membership: owner, failedOnly: true }); const failed = log.entries.find((e) => e.type === "IMPORT_ORDER" && e.ref === "77"); assert.match(failed.error, /isn't linked/);
  await CH.channelWebhook({ platform: "WOOCOMMERCE", channelId: ch.id, rawBody: body, headers: hdr, fetchImpl });
  assert.equal((await CH.syncLog({ orgId: ORG, membership: owner, failedOnly: true })).entries.filter((e) => e.ref === "77").length, 1, "repeats don't pile up");
  // link the Woo product to Inaya's mug (pull + SKU fix), then retry from the dashboard
  await c.products.updateOne({ _id: pMug }, { $set: { sku: `MUG-WOO-${T}` } }); await CH.pullProducts({ orgId: ORG, membership: owner, id: ch.id, fetchImpl });
  const rr = await CH.retryNow({ orgId: ORG, membership: owner, logId: failed.id, fetchImpl }); assert.equal(rr.fixed, 1);
  const o = await c.salesOrders.findOne({ orgId, channel: "WOOCOMMERCE", externalOrderId: "77" }); assert.equal(o.total, 1650); assert.equal(o.payments.length, 1);
  assert.equal((await CH.syncLog({ orgId: ORG, membership: owner, channelId: ch.id, failedOnly: true })).openFailures, 0, "the failure is resolved");
  assert.ok((await CH.listChannels({ orgId: ORG, membership: owner })).usage.syncedOrdersThisMonth >= 1, "synced orders are counted against the plan");
  await CH.syncStockNow({ orgId: ORG, membership: owner, id: ch.id, force: true, fetchImpl }); assert.equal(st.batch.update[0].id, 501);
  const view = JSON.stringify(await CH.listChannels({ orgId: ORG, membership: owner })); assert.ok(!view.includes("cs_0123456789abcdef") && !view.includes("shpat_"), "credentials are never returned");
});

test("Shopify one-click install (Inaya's app): signed callback, single-use state bound to the person, token exchange, privacy webhooks", { timeout: 120000 }, async () => {
  process.env.SHOPIFY_APP_CLIENT_ID = "inaya-test-client-id"; process.env.SHOPIFY_APP_CLIENT_SECRET = "inaya-test-client-secret-0123456789";
  const APP = await import("../src/lib/online/shopifyApp.js");
  const start = await APP.startShopifyInstall({ orgId: OTHER, membership: owner, actorEmail: owner.email, shopDomain: "other-p5", baseUrl: "https://app.test" });
  assert.ok(!start.error, start.error); const u = new URL(start.url);
  assert.equal(u.host, "other-p5.myshopify.com"); assert.equal(u.searchParams.get("client_id"), "inaya-test-client-id"); assert.equal(u.searchParams.get("redirect_uri"), "https://app.test/api/shop/shopify/callback");
  const signed = (extra) => { const p = new URLSearchParams({ code: "code-1", shop: "other-p5.myshopify.com", state: u.searchParams.get("state"), timestamp: String(Math.floor(Date.now() / 1000)), ...extra }); const msg = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&"); p.set("hmac", createHmac("sha256", "inaya-test-client-secret-0123456789").update(msg).digest("hex")); return p; };
  const st = {}; const base = shopifyMock(st);
  const fetchImpl = async (url, init) => (String(url).endsWith("/admin/oauth/access_token") ? (st.exchange = JSON.parse(init.body), new Response(JSON.stringify({ access_token: "shpua_oauth_token_123456789012345", scope: APP.DEFAULT_SCOPES }), { status: 200 })) : base(url, init));
  const resolve = async () => owner;
  const forged = signed(); forged.set("hmac", "00"); assert.equal((await APP.completeShopifyInstall({ params: forged, sessionEmail: owner.email, resolveMembership: resolve, fetchImpl })).code, "BAD_HMAC");
  assert.match((await APP.completeShopifyInstall({ params: signed(), sessionEmail: "someone-else@p5.example", resolveMembership: resolve, fetchImpl })).error, /signed in as the person/);
  // the state above was consumed by that attempt: a fresh install, then a replay
  const start2 = await APP.startShopifyInstall({ orgId: OTHER, membership: owner, actorEmail: owner.email, shopDomain: "other-p5.myshopify.com", baseUrl: "https://app.test" });
  const p2 = (() => { const st2 = new URL(start2.url).searchParams.get("state"); const p = new URLSearchParams({ code: "code-2", shop: "other-p5.myshopify.com", state: st2, timestamp: String(Math.floor(Date.now() / 1000)) }); const msg = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&"); p.set("hmac", createHmac("sha256", "inaya-test-client-secret-0123456789").update(msg).digest("hex")); return p; })();
  const ok = await APP.completeShopifyInstall({ params: p2, sessionEmail: owner.email, resolveMembership: resolve, fetchImpl }); assert.ok(!ok.error, ok.error);
  assert.equal(st.exchange.code, "code-2"); assert.equal(st.exchange.client_secret, "inaya-test-client-secret-0123456789");
  const doc = await c.db.collection("calendar_records").findOne({ _id: new ObjectId(ok.channel.id) }); assert.equal(doc.connectMethod, "inaya_app");
  assert.equal((await APP.completeShopifyInstall({ params: p2, sessionEmail: owner.email, resolveMembership: resolve, fetchImpl })).code, "BAD_STATE", "a callback link works once");
  assert.equal((await APP.startShopifyInstall({ orgId: OTHER, membership: owner, actorEmail: owner.email, shopDomain: "other-p5", baseUrl: "https://app.test" })).code, "CHANNEL_LIMIT", "Business: one Shopify store");
  // privacy / uninstall webhooks
  const body = JSON.stringify({ shop_domain: "other-p5.myshopify.com" }); const h = createHmac("sha256", "inaya-test-client-secret-0123456789").update(body).digest("base64");
  assert.equal((await APP.shopifyAppWebhook({ topic: "shop/redact", shopDomain: "other-p5.myshopify.com", rawBody: body, hmac: "bad" })).status, 401);
  assert.equal((await APP.shopifyAppWebhook({ topic: "customers/data_request", shopDomain: "other-p5.myshopify.com", rawBody: body, hmac: h })).received, true);
  await APP.shopifyAppWebhook({ topic: "shop/redact", shopDomain: "other-p5.myshopify.com", rawBody: body, hmac: h });
  const gone = await c.db.collection("calendar_records").findOne({ _id: new ObjectId(ok.channel.id) }); assert.ok(gone.deletedAt); assert.equal(gone.tokenSealed, null, "the shop's token is destroyed");
  delete process.env.SHOPIFY_APP_CLIENT_ID; delete process.env.SHOPIFY_APP_CLIENT_SECRET;
});
