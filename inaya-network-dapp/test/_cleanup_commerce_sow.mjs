// TEST database only: removes the companies created for the Commerce SOW browser checks and demo videos.
// Run: $env:INAYA_USE_TEST_DB="1"; node --env-file=.env.local --import ./test/_next-loader.mjs test/_cleanup_commerce_sow.mjs [--apply]
const prodUri = process.env.MONGODB_URI;
if (process.env.INAYA_USE_TEST_DB !== "1") throw new Error("TEST database only");
const { getOrgCollections } = await import("../src/lib/orgs.js");
if (!process.env.MONGODB_URI || process.env.MONGODB_URI === prodUri) throw new Error("not switched to the test database");
const c = await getOrgCollections(); const APPLY = process.argv.includes("--apply");
const { ObjectId } = await import("mongodb");
const named = await c.orgs.find({ name: { $regex: "^(Lahore Home Goods|Two Branch Mart|Karachi Corner Store|w6 chain|p5 )" } }, { projection: { name: 1 } }).toArray();
const fixed = ["6b02ee244ba7dfb8b54f3969", "6b024794140ccd306e6a88fb"].map((x) => new ObjectId(x));
const extra = await c.orgs.find({ _id: { $in: fixed } }, { projection: { name: 1 } }).toArray();
const orgs = [...new Map([...named, ...extra].map((o) => [String(o._id), o])).values()];
console.log(`${orgs.length} test companies:`, orgs.map((o) => o.name).join(" | ").slice(0, 600));
const colls = ["warehouses", "products", "crm_contacts", "calendar_records", "stock_levels", "stock_movements", "sales_orders", "journal_entries", "ledger_accounts", "org_activity", "webhook_deliveries", "departments", "org_members", "suppliers", "purchase_orders", "employees", "invoices", "rate_limit_hits"];
if (APPLY) {
  const ids = orgs.map((o) => o._id); let n = 0;
  for (const coll of colls) n += (await c.db.collection(coll).deleteMany({ orgId: { $in: ids } }).catch(() => ({ deletedCount: 0 }))).deletedCount;
  await c.orgs.deleteMany({ _id: { $in: ids } }); console.log(`deleted ${orgs.length} companies and ${n} records`);
} else console.log("DRY RUN");
process.exit(0);
