// Seeds a throwaway shop on the TEST database for the Point of Sale browser check; prints ids and owner/cashier/supervisor sessions.
// Run: $env:INAYA_USE_TEST_DB="1"; node --env-file=.env.local --import ./test/_next-loader.mjs test/_pos_ui_seed.mjs [cleanup <orgId>]
import { getOrgCollections, ensureOrgIndexes, createSession, SESSION_COOKIE } from "../src/lib/orgs.js";
import { recordStockMovement } from "../src/lib/inventory.js";
import * as S from "../src/lib/commerce/store.js";
import * as TAX from "../src/lib/commerce/tax.js";
import { ObjectId } from "mongodb";
if (process.env.INAYA_USE_TEST_DB !== "1") throw new Error("TEST database only");
await ensureOrgIndexes();
const c = await getOrgCollections();
if (process.argv[2] === "cleanup") {
  const orgId = new ObjectId(process.argv[3]);
  for (const n of ["warehouses", "products", "crm_contacts", "calendar_records", "stock_levels", "stock_movements", "sales_orders", "journal_entries", "ledger_accounts", "org_activity", "webhook_deliveries", "departments", "org_members"]) await c.db.collection(n).deleteMany({ orgId }).catch(() => {});
  await c.orgs.deleteMany({ _id: orgId });
  console.log("cleaned", String(orgId)); process.exit(0);
}
const now = new Date().toISOString(); const run = Date.now().toString(36);
const owner = `pos-owner-${run}@example.com`, cashier = `pos-cashier-${run}@example.com`, supervisor = `pos-super-${run}@example.com`;
const orgId = new ObjectId(); const ORG = String(orgId);
await c.orgs.insertOne({ _id: orgId, name: `Karachi Corner Store ${run}`, ownerEmail: owner, plan: "business", features: { FEATURE_COMMERCE: true }, createdAt: now });
const dep = (await c.departments.insertOne({ orgId, name: "Shop", createdAt: now })).insertedId;
for (const [email, role, commerceRole] of [[owner, "owner", null], [cashier, "member", "cashier"], [supervisor, "member", "supervisor"]])
  await c.orgMembers.insertOne({ orgId, email, role, status: "active", departmentIds: [dep], ...(commerceRole ? { commerceRole } : {}), createdAt: now });
const w = (await c.warehouses.insertOne({ orgId, departmentId: dep, name: "Main shop", createdAt: now })).insertedId;
const mk = (x) => c.products.insertOne({ orgId, departmentId: dep, status: "ACTIVE", deletedAt: null, productType: "STOCK", createdAt: now, ...x }).then((r) => r.insertedId);
const items = [
  ["TEA-01", "Green tea 100g", 450, "Grocery", "8964000000011"], ["RICE-5", "Basmati rice 5kg", 2400, "Grocery", "8964000000028"],
  ["SOAP-1", "Bath soap", 180, "Personal care", "8964000000035"], ["SHMP-1", "Shampoo 400ml", 950, "Personal care", "8964000000042"],
];
const ids = [];
for (const [sku, name, unitPrice, category, barcode] of items) ids.push(await mk({ sku, name, unitPrice, category, barcode }));
const vg = `vg-${run}`;
for (const size of ["S", "M", "L"]) ids.push(await mk({ sku: `TSHIRT-${size}`, name: `T-shirt ${size}`, unitPrice: 1200, category: "Clothing", variantGroupId: vg, variantGroupName: "T-shirt", variantAttributes: { size } }));
await mk({ sku: "ALT-1", name: "Alteration service", unitPrice: 300, category: "Clothing", productType: "SERVICE" });
for (const p of ids) await recordStockMovement({ orgId: ORG, productId: String(p), warehouseId: String(w), delta: 25, type: "RECEIPT", actorEmail: owner, unitCost: 100 });
await c.crmContacts.insertOne({ orgId, departmentId: dep, name: "Ayesha Khan", email: "ayesha@example.com", createdAt: now });
const om = { role: "owner", email: owner };
await S.updateSettings({ orgId: ORG, membership: om, actorEmail: owner, input: { currency: "PKR", taxMode: "exclusive", rounding: { mode: "line", cashIncrement: 100 } } });
await TAX.saveTaxCategory({ orgId: ORG, membership: om, actorEmail: owner, code: "GST", name: "Sales tax", rate: 18, isDefault: true });
const tok = async (e) => (await createSession(e)).sessionToken;
console.log("SEED " + JSON.stringify({ orgId: ORG, cookie: SESSION_COOKIE, owner: await tok(owner), cashier: await tok(cashier), supervisor: await tok(supervisor) }));
process.exit(0);
