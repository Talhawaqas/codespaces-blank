// Seeds a throwaway online store on the TEST database for the storefront browser check; prints the store address and an owner session.
// Run: $env:INAYA_USE_TEST_DB="1"; node --env-file=.env.local --import ./test/_next-loader.mjs test/_online_ui_seed.mjs [cleanup <orgId>]
import { getOrgCollections, ensureOrgIndexes, createSession, SESSION_COOKIE } from "../src/lib/orgs.js";
import { recordStockMovement } from "../src/lib/inventory.js";
import * as S from "../src/lib/commerce/store.js";
import * as TAX from "../src/lib/commerce/tax.js";
import * as ST from "../src/lib/online/stores.js";
import { ObjectId } from "mongodb";
if (process.env.INAYA_USE_TEST_DB !== "1") throw new Error("TEST database only");
await ensureOrgIndexes();
const c = await getOrgCollections();
if (process.argv[2] === "cleanup") {
  const orgId = new ObjectId(process.argv[3]);
  for (const n of ["warehouses", "products", "crm_contacts", "calendar_records", "stock_levels", "stock_movements", "sales_orders", "journal_entries", "ledger_accounts", "org_activity", "webhook_deliveries", "departments", "org_members", "invoices"]) await c.db.collection(n).deleteMany({ orgId }).catch(() => {});
  await c.orgs.deleteMany({ _id: orgId });
  console.log("cleaned", String(orgId)); process.exit(0);
}
const now = new Date().toISOString(); const run = Date.now().toString(36);
const ownerEmail = `shop-owner-${run}@example.com`; const owner = { role: "owner", email: ownerEmail };
const orgId = new ObjectId(); const ORG = String(orgId);
await c.orgs.insertOne({ _id: orgId, name: `Lahore Home Goods ${run}`, ownerEmail, plan: "business", features: { FEATURE_COMMERCE: true }, createdAt: now });
const dep = (await c.departments.insertOne({ orgId, name: "Online", createdAt: now })).insertedId;
await c.orgMembers.insertOne({ orgId, email: ownerEmail, role: "owner", status: "active", departmentIds: [dep], createdAt: now });
const w = (await c.warehouses.insertOne({ orgId, departmentId: dep, name: "Main warehouse", createdAt: now })).insertedId;
await S.updateSettings({ orgId: ORG, membership: owner, actorEmail: ownerEmail, input: { currency: "PKR", taxMode: "inclusive" } });
await TAX.saveTaxCategory({ orgId: ORG, membership: owner, actorEmail: ownerEmail, code: "GST", name: "GST", rate: 18, isDefault: true });
const items = [["MUG-01", "Ceramic mug", 1200, "Kitchen", 40], ["TEA-02", "Green tea 100g", 450, "Grocery", 3], ["CUSH-1", "Cotton cushion", 2400, "Living room", 12], ["LAMP-1", "Desk lamp", 5200, "Living room", 0]];
const store = (await ST.createStore({ orgId: ORG, membership: owner, actorEmail: ownerEmail, name: "Lahore Home Goods", slug: `lahore-home-${run}` })).store;
for (const [sku, name, price, category, stock] of items) {
  const id = (await c.products.insertOne({ orgId, departmentId: dep, status: "ACTIVE", deletedAt: null, productType: "STOCK", sku: `${sku}-${run}`, name, unitPrice: price, costPrice: Math.round(price * 0.4), category, createdAt: now })).insertedId;
  if (stock) await recordStockMovement({ orgId: ORG, productId: String(id), warehouseId: String(w), delta: stock, type: "RECEIPT", actorEmail: "seed", unitCost: Math.round(price * 0.4) });
  await ST.saveListing({ orgId: ORG, membership: owner, actorEmail: ownerEmail, input: { productId: String(id), status: "PUBLISHED", description: `${name}: a seed product for the storefront check.`, featured: sku !== "LAMP-1", weightKg: 0.5 } });
}
await ST.updateStore({ orgId: ORG, membership: owner, actorEmail: ownerEmail, input: { stockPolicy: "show_low_stock", lowStockAt: 5, content: { branding: { tagline: "Everyday things for a calm home" }, pages: { privacy: "We use your details only to deliver your order.", terms: "Prices include GST. Returns within 14 days.", shipping: "Lahore: 1-2 days. Rest of Pakistan: 3-5 days.", contact: "WhatsApp +92 300 0000000" } }, shipping: { zones: [{ id: "lhr", name: "Lahore", countries: ["PK"], cities: ["Lahore"], rateType: "flat", flat: 200, freeOver: 5000, etaText: "1-2 days", windows: ["Morning", "Evening"] }, { id: "pk", name: "Rest of Pakistan", countries: ["PK"], rateType: "weight", flat: 250, perKg: 100, etaText: "3-5 days" }], pickup: { enabled: true, warehouseIds: [String(w)], instructions: "Collect from our Gulberg shop, 10am-8pm." } } } });
await ST.updatePayments({ orgId: ORG, membership: owner, actorEmail: ownerEmail, input: { bankTransfer: { enabled: true, instructions: "Meezan Bank · Lahore Home Goods · PK00 MEZN 0000 0000 0000 0000" }, cod: { enabled: true, maxOrder: 15000 } } });
const pub = await ST.publishStore({ orgId: ORG, membership: owner, actorEmail: ownerEmail, action: "publish" }); if (pub.error) throw new Error(pub.error);
const token = (await createSession(ownerEmail)).sessionToken;
console.log(JSON.stringify({ orgId: ORG, store: `/shop/${store.slug}`, owner: ownerEmail, cookieName: SESSION_COOKIE, session: token }));
process.exit(0);
