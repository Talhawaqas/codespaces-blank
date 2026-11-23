// Seeds ONE demo company on the TEST database for the Commerce SOW demo videos (Phases 1-6): two branches, products and stock,
// a till with a shift and sales (one refunded), a transfer, a sales order, a supplier, loyalty + an active promotion, a published
// online store, and staff with branches, shifts, a commission rule and a clock-in. Prints sessions for the recorder.
// Run: $env:INAYA_USE_TEST_DB="1"; node --env-file=.env.local --import ./test/_next-loader.mjs test/_demo_commerce_seed.mjs [cleanup <orgId>]
import { getOrgCollections, ensureOrgIndexes, createSession, SESSION_COOKIE } from "../src/lib/orgs.js";
import { recordStockMovement } from "../src/lib/inventory.js";
import * as S from "../src/lib/commerce/store.js";
import * as TAX from "../src/lib/commerce/tax.js";
import * as SALE from "../src/lib/commerce/sale.js";
import * as RET from "../src/lib/commerce/returns.js";
import * as SH from "../src/lib/commerce/shifts.js";
import * as TR from "../src/lib/stock-control/transfers.js";
import * as LOY from "../src/lib/growth/loyalty.js";
import * as PRO from "../src/lib/growth/promotions.js";
import * as ST from "../src/lib/online/stores.js";
import * as SC from "../src/lib/workforce/scope.js";
import * as T from "../src/lib/workforce/time.js";
import * as C from "../src/lib/workforce/commissions.js";
import { createSalesOrder } from "../src/lib/sales-orders.js";
import { ObjectId } from "mongodb";
if (process.env.INAYA_USE_TEST_DB !== "1") throw new Error("TEST database only");
await ensureOrgIndexes();
const c = await getOrgCollections();
if (process.argv[2] === "cleanup") {
  const orgId = new ObjectId(process.argv[3]);
  for (const n of ["warehouses", "products", "crm_contacts", "calendar_records", "stock_levels", "stock_movements", "sales_orders", "journal_entries", "ledger_accounts", "org_activity", "webhook_deliveries", "departments", "org_members", "suppliers", "purchase_orders", "employees"]) await c.db.collection(n).deleteMany({ orgId });
  await c.orgs.deleteMany({ _id: orgId }); console.log("cleaned", String(orgId)); process.exit(0);
}
const must = (r, what) => { if (r?.error) throw new Error(`${what}: ${r.error}`); return r; };
const now = new Date().toISOString(); const run = Date.now().toString(36);
const E = (k) => `${k}.${run}@lahorehome.example`;
const owner = { role: "owner", email: E("owner") }, admin = { role: "admin", email: E("admin") };
const orgId = new ObjectId(); const ORG = String(orgId);
await c.orgs.insertOne({ _id: orgId, name: "Lahore Home Goods", ownerEmail: owner.email, plan: "business", features: { FEATURE_COMMERCE: true }, createdAt: now });
const dep = (await c.departments.insertOne({ orgId, name: "Shops", createdAt: now })).insertedId;
const lhr = (await c.warehouses.insertOne({ orgId, departmentId: dep, name: "Lahore - Gulberg", city: "Lahore", createdAt: now })).insertedId;
const khi = (await c.warehouses.insertOne({ orgId, departmentId: dep, name: "Karachi - Clifton", city: "Karachi", createdAt: now })).insertedId;
const L = String(lhr), K = String(khi);
const people = [[owner.email, "owner"], [admin.email, "admin"], [E("sara"), "member"], [E("ali"), "member"], [E("hina"), "member"]];
for (const [email, role] of people) await c.orgMembers.insertOne({ orgId, email, name: email.split(".")[0].replace(/^./, (x) => x.toUpperCase()), role, status: "active", departmentIds: [dep], createdAt: now });
await SC.updateUser({ orgId: ORG, membership: owner, actorEmail: owner.email, email: E("sara"), input: { template: "cashier", locationIds: [L] } });
await SC.updateUser({ orgId: ORG, membership: owner, actorEmail: owner.email, email: E("ali"), input: { template: "store_manager", locationIds: [L] } });
await SC.updateUser({ orgId: ORG, membership: owner, actorEmail: owner.email, email: E("hina"), input: { template: "cashier", locationIds: [K] } });
const m = async (email) => c.orgMembers.findOne({ orgId, email });
const sara = await m(E("sara")), ali = await m(E("ali"));
await c.employees.insertMany([{ orgId, memberEmail: E("sara"), name: "Sara", hourlyCost: 600, createdAt: now }, { orgId, memberEmail: E("ali"), name: "Ali", hourlyCost: 900, createdAt: now }]).catch(() => null);

// Phase 1-3: catalogue, stock in two branches, costs
must(await S.updateSettings({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { currency: "PKR", taxMode: "inclusive", rounding: { mode: "line", cashIncrement: 100 } } }), "settings");
must(await TAX.saveTaxCategory({ orgId: ORG, membership: owner, actorEmail: owner.email, code: "GST", name: "Sales tax", rate: 18, isDefault: true }), "tax");
const items = [["MUG-01", "Ceramic mug", 1200, "Kitchen", 40, 12], ["TEA-02", "Green tea 100g", 450, "Grocery", 60, 4], ["CUSH-1", "Cotton cushion", 2400, "Living room", 18, 6], ["LAMP-1", "Desk lamp", 5200, "Living room", 6, 2], ["TOWL-1", "Bath towel", 1800, "Bath", 25, 3], ["CAND-1", "Scented candle", 950, "Living room", 30, 0]];
const P = {};
for (const [sku, name, price, category, qL, qK] of items) {
  const id = (await c.products.insertOne({ orgId, departmentId: dep, status: "ACTIVE", deletedAt: null, productType: "STOCK", sku, name, unitPrice: price, costPrice: Math.round(price * 0.45), category, unit: "each", reorderAt: 8, createdAt: now })).insertedId;
  P[sku] = String(id);
  if (qL) await recordStockMovement({ orgId: ORG, productId: String(id), warehouseId: L, delta: qL, type: "RECEIPT", actorEmail: owner.email, unitCost: Math.round(price * 0.45) });
  if (qK) await recordStockMovement({ orgId: ORG, productId: String(id), warehouseId: K, delta: qK, type: "RECEIPT", actorEmail: owner.email, unitCost: Math.round(price * 0.45) });
}
const cust = (await c.crmContacts.insertOne({ orgId, departmentId: dep, name: "Ayesha Khan", email: "ayesha@example.com", phone: "+92 300 1234567", createdAt: now })).insertedId;
await c.crmContacts.insertOne({ orgId, departmentId: dep, name: "Bilal Ahmed", email: "bilal@example.com", createdAt: now });
await c.suppliers.insertOne({ orgId, departmentId: dep, name: "Sialkot Ceramics", email: "orders@sialkot.example", createdAt: now }).catch(() => null);

// Phase 4: loyalty + an active promotion (made by the owner, approved by the admin)
must(await LOY.updateLoyaltySettings({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { enabled: true, earnUnitMinor: 10000, pointsPerUnit: 1, pointValueMinor: 1000, minRedeemPoints: 10, maxRedeemPercent: 50, expiryMonths: 12 } }), "loyalty");
const promo = must(await PRO.savePromotion({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { name: "Winter cushions 10% off", type: "PERCENT", value: 10, categories: ["Living room"] } }), "promo").promotion;
await PRO.transitionPromotion({ orgId: ORG, membership: admin, actorEmail: admin.email, id: promo.id, action: "approve" });

// Phase 2: a till at Lahore, an open shift and a few sales (one refunded)
const reg = must(await SH.saveRegister({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { code: "LHR-1", name: "Lahore till 1", warehouseId: L } }), "register");
must(await SH.saveRegister({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { code: "KHI-1", name: "Karachi till 1", warehouseId: K } }), "register2");
must(await SH.openShift({ orgId: ORG, membership: sara, actorEmail: sara.email, registerId: reg.id, openingFloat: 5000 }), "shift");
const sell = async (lines, method = "CASH", customerId = null) => must(await SALE.completeSale({ orgId: ORG, membership: sara, actorEmail: sara.email, input: { warehouseId: L, registerId: reg.id, idempotencyKey: SALE.newIdempotencyKey(), ...(customerId ? { customerId: String(customerId) } : {}), lines, tenders: [{ method, amount: method === "CASH" ? 50000 : 1200, ...(method === "BANK_TRANSFER" ? { reference: "IBFT-20931" } : {}) }] } }), "sale"); // one mug (PKR 1,200, tax inclusive, no promotion) is the bank-transfer sale
const s1 = await sell([{ productId: P["MUG-01"], quantity: 2 }, { productId: P["TEA-02"], quantity: 3 }], "CASH", cust);
await sell([{ productId: P["CUSH-1"], quantity: 2 }], "CASH");
await sell([{ productId: P["LAMP-1"], quantity: 1 }], "CASH");
await sell([{ productId: P["MUG-01"], quantity: 1 }], "BANK_TRANSFER");
await sell([{ productId: P["TOWL-1"], quantity: 2 }, { productId: P["CAND-1"], quantity: 1 }], "CASH", cust);
await RET.processReturn({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { saleId: s1.sale.id, idempotencyKey: SALE.newIdempotencyKey(), reason: "Chipped mug", lines: [{ lineIndex: 0, quantity: 1 }] } });

// Phase 2c / 3: a sales order and a transfer between branches
await createSalesOrder({ orgId: ORG, membership: owner, actorEmail: owner.email, departmentId: String(dep), contactId: String(cust), warehouseId: L, currency: "PKR", lines: [{ productId: P["CUSH-1"], quantity: 4, unitPrice: 2400 }] });
await TR.createTransfer({ orgId: ORG, membership: ali, actorEmail: ali.email, input: { fromWarehouseId: L, toWarehouseId: K, lines: [{ productId: P["TEA-02"], quantity: 10 }] } });

// Phase 5: a published online store
const store = must(await ST.createStore({ orgId: ORG, membership: owner, actorEmail: owner.email, name: "Lahore Home Goods", slug: `lahore-home-goods-${run}` }), "store").store;
for (const sku of ["MUG-01", "CUSH-1", "LAMP-1", "TOWL-1", "CAND-1"]) await ST.saveListing({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { productId: P[sku], status: "PUBLISHED", description: "Made for calm, everyday living.", featured: sku !== "TOWL-1", weightKg: 0.5 } });
await ST.updateStore({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { stockPolicy: "show_low_stock", lowStockAt: 5, content: { branding: { tagline: "Everyday things for a calm home" }, pages: { privacy: "We use your details only to deliver your order.", terms: "Returns within 14 days with receipt.", returns: "14 days.", delivery: "2-4 days in Pakistan.", contact: "hello@lahorehome.example" } } } });
await ST.updatePayments({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { bankTransfer: { enabled: true, instructions: "Meezan Bank - Lahore Home Goods - PK00 MEZN 0000 0000 0000 0000" }, cod: { enabled: true, maxOrder: 15000 } } });
await ST.publishStore({ orgId: ORG, membership: owner, actorEmail: owner.email, action: "publish" });

// Phase 6: rota, a commission rule, a clock-in and a checklist
const mon = new Date(); mon.setUTCHours(0, 0, 0, 0); mon.setUTCDate(mon.getUTCDate() - ((mon.getUTCDay() + 6) % 7));
const at = (d, h) => new Date(mon.getTime() + d * 86400000 + h * 3600000).toISOString();
for (let d = 0; d < 5; d++) await T.saveShift({ orgId: ORG, membership: ali, actorEmail: ali.email, input: { email: E("sara"), locationId: L, start: at(d, 4), end: at(d, 12), role: "Till" } });
await T.saveShift({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { email: E("ali"), locationId: L, start: at(1, 5), end: at(1, 13), role: "Manager" } });
await T.publishWeek({ orgId: ORG, membership: ali, actorEmail: ali.email, locationId: L, weekStart: mon.toISOString() });
const today = new Date().toISOString().slice(0, 10);
await C.saveRule({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { percent: 2, effectiveFrom: today } });
await C.saveChecklist({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { name: "Opening checks", type: "OPENING", items: ["Count the float", "Lights and music on", "Clean the counter"], locationId: L, dueTime: "10:00" } });
await T.punch({ orgId: ORG, membership: sara, type: "CLOCK_IN", locationId: L, idempotencyKey: T.newKey() });

const tok = async (e) => (await createSession(e)).sessionToken;
console.log("SEED " + JSON.stringify({ orgId: ORG, cookie: SESSION_COOKIE, store: `/shop/${store.slug}`, owner: await tok(owner.email), cashier: await tok(E("sara")) }));
process.exit(0);
