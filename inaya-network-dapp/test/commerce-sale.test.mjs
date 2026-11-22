// test/commerce-sale.test.mjs -- Inaya Commerce, Batch 2: the Master SOW 6.12 acceptance criteria for a sale.
// A permitted employee completes a sale end to end; price and tax are recalculated server-side; stock and customer history
// change exactly once; finance receives a balanced entry; the receipt matches; a duplicate submission does not create a
// second sale; concurrent sales preserve stock; restricted discounts need an approval from someone else; failures leave
// no partial transaction; tenants are isolated.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import * as S from "../src/lib/commerce/store.js";
import * as TAX from "../src/lib/commerce/tax.js";
import * as SALE from "../src/lib/commerce/sale.js";
import { recordStockMovement, getStockLevel } from "../src/lib/inventory.js";

const orgId = new ObjectId(); const ORG = String(orgId); const other = new ObjectId();
const owner = { role: "owner", email: "owner@shop.example" };
const cashier = { role: "member", commerceRole: "cashier", email: "cash@shop.example" };
const supervisor = { role: "member", commerceRole: "supervisor", email: "sup@shop.example" };
let c, w, pShirt, pCap, pService, customer;
const key = () => SALE.newIdempotencyKey();
const sell = (membership, input) => SALE.completeSale({ orgId: ORG, membership, actorEmail: membership.email, input: { warehouseId: String(w), idempotencyKey: key(), ...input } });
const stock = (p) => getStockLevel(ORG, String(p), String(w));
before(async () => {
  await ensureOrgIndexes(); c = await getOrgCollections(); const now = new Date().toISOString(); const dep = new ObjectId();
  await c.orgs.insertOne({ _id: orgId, name: "commerce-sale", features: { FEATURE_COMMERCE: true }, createdAt: now });
  await c.orgs.insertOne({ _id: other, name: "other-co", features: { FEATURE_COMMERCE: true }, createdAt: now });
  w = (await c.warehouses.insertOne({ orgId, departmentId: dep, name: "Shop", createdAt: now })).insertedId;
  const mk = (x) => c.products.insertOne({ orgId, departmentId: dep, status: "ACTIVE", deletedAt: null, createdAt: now, ...x }).then((r) => r.insertedId);
  pShirt = await mk({ sku: `SH-${Date.now()}`, name: "Shirt", unitPrice: 1000 });
  pCap = await mk({ sku: `CP-${Date.now()}`, name: "Cap", unitPrice: 500 });
  pService = await mk({ sku: `SV-${Date.now()}`, name: "Alteration", unitPrice: 300, productType: "SERVICE" });
  customer = (await c.crmContacts.insertOne({ orgId, departmentId: dep, name: "Walk-in regular", createdAt: now })).insertedId;
  await S.updateSettings({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { currency: "PKR", taxMode: "exclusive", rounding: { mode: "line", cashIncrement: 100 } } });
  await TAX.saveTaxCategory({ orgId: ORG, membership: owner, actorEmail: owner.email, code: "GST", name: "GST", rate: 18, isDefault: true });
  await recordStockMovement({ orgId: ORG, productId: String(pShirt), warehouseId: String(w), delta: 20, type: "RECEIPT", actorEmail: "t", unitCost: 600 });
  await recordStockMovement({ orgId: ORG, productId: String(pCap), warehouseId: String(w), delta: 5, type: "RECEIPT", actorEmail: "t", unitCost: 200 });
});
after(async () => {
  for (const n of ["orgs", "warehouses", "products", "crm_contacts", "calendar_records", "stock_levels", "stock_movements", "sales_orders", "journal_entries", "ledger_accounts", "org_activity", "webhook_deliveries"]) await c.db.collection(n).deleteMany(n === "orgs" ? { _id: { $in: [orgId, other] } } : { orgId }).catch(() => {});
  await (await mongoClientPromise).close();
});

test("a cashier completes a sale end to end: stock, customer history, finance and receipt each change exactly once", { timeout: 120000 }, async () => {
  const r = await sell(cashier, { customerId: String(customer), lines: [{ productId: String(pShirt), quantity: 2 }, { productId: String(pService), quantity: 1 }], tenders: [{ method: "CASH", amount: 3000 }] });
  assert.ok(!r.error, r.error);
  const s = r.sale;
  assert.match(s.saleNumber, /^S-\d{6}$/);
  assert.equal(s.totals.net, 2300); assert.equal(s.totals.tax, 414); assert.equal(s.totals.total, 2714, "server-side: (2x1000 + 300) + 18%");
  assert.equal(s.cashRounding, 0, "2714.00 is already a whole 1.00"); assert.equal(s.change, 286, "3000 - 2714");
  assert.ok(s.tenders.every((t) => t.manual && t.label === "Recorded manually"));
  assert.equal(await stock(pShirt), 18, "stock moved once"); assert.equal(await c.stockMovements.countDocuments({ orgId, relatedSaleId: new ObjectId(s.id) }), 1, "services don't move stock");
  const mv = await c.stockMovements.findOne({ orgId, relatedSaleId: new ObjectId(s.id) }); assert.equal(mv.unitCost, 600, "COGS cost recorded");
  const cust = await c.crmContacts.findOne({ _id: customer }); assert.equal(cust.commerce.purchaseCount, 1); assert.equal(cust.commerce.spendMinor, 271400);
  const entry = await c.db.collection("journal_entries").findOne({ orgId, "source.type": "POS_SALE", "source.id": s.id });
  assert.ok(entry, "the ledger received the sale");
  const debit = entry.lines.reduce((x, l) => x + l.debit, 0), credit = entry.lines.reduce((x, l) => x + l.credit, 0);
  assert.ok(Math.abs(debit - credit) < 0.005, "balanced"); assert.ok(entry.lines.some((l) => l.accountCode === "2100" && l.credit > 0), "tax payable credited");
  const rec = (await SALE.receiptFor({ orgId: ORG, membership: cashier, saleId: s.id })).receipt;
  assert.equal(rec.saleNumber, s.saleNumber); assert.equal(rec.totals.total, s.totals.total); assert.equal(rec.lines.length, 2); assert.ok(rec.returnPolicy);
});

test("a duplicate submission never creates a second sale (even concurrently)", { timeout: 120000 }, async () => {
  const k = key(); const before = await stock(pShirt);
  const runs = await Promise.all([1, 2, 3].map(() => SALE.completeSale({ orgId: ORG, membership: cashier, actorEmail: cashier.email, input: { warehouseId: String(w), idempotencyKey: k, lines: [{ productId: String(pShirt), quantity: 1 }], tenders: [{ method: "CASH", amount: 1200 }] } })));
  const ok = runs.filter((x) => !x.error); assert.ok(ok.length >= 1, JSON.stringify(runs.map((x) => x.error)));
  assert.equal(new Set(ok.map((x) => x.sale.id)).size, 1, "all answers are the same sale");
  assert.equal(await c.salesOrders.countDocuments({ orgId, idempotencyKey: k }), 1);
  assert.equal(await stock(pShirt), before - 1, "stock changed exactly once");
});

test("concurrent sales cannot oversell, and a failed sale leaves nothing behind", { timeout: 180000 }, async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => sell(cashier, { lines: [{ productId: String(pCap), quantity: 1 }], tenders: [{ method: "CASH", amount: 600 }] })));
  assert.equal(results.filter((r) => !r.error).length, 5, "only the 5 caps in stock were sold");
  assert.ok(results.filter((r) => r.error).every((r) => r.status === 409));
  assert.equal(await stock(pCap), 0);
  const shirtsBefore = await stock(pShirt); const salesBefore = await c.salesOrders.countDocuments({ orgId });
  const bad = await sell(cashier, { lines: [{ productId: String(pShirt), quantity: 1 }, { productId: String(pCap), quantity: 1 }], tenders: [{ method: "CASH", amount: 2000 }] });
  assert.equal(bad.status, 409);
  assert.equal(await stock(pShirt), shirtsBefore, "the shirt line was rolled back with the failed cap line");
  assert.equal(await c.salesOrders.countDocuments({ orgId }), salesBefore, "no partial sale");
});

test("tenders: split, references, underpayment and non-cash overpayment are refused", { timeout: 120000 }, async () => {
  assert.equal((await sell(cashier, { lines: [{ productId: String(pShirt), quantity: 1 }], tenders: [{ method: "CASH", amount: 500 }] })).code, "UNDERPAID");
  assert.equal((await sell(cashier, { lines: [{ productId: String(pShirt), quantity: 1 }], tenders: [{ method: "BANK_TRANSFER", amount: 2000, reference: "TRX1" }] })).code, "OVERPAID");
  assert.equal((await sell(cashier, { lines: [{ productId: String(pShirt), quantity: 1 }], tenders: [{ method: "BANK_TRANSFER", amount: 1180 }] })).status, 400, "a bank transfer needs a reference");
  assert.equal((await sell(cashier, { lines: [{ productId: String(pShirt), quantity: 1 }], tenders: [{ method: "CARD", amount: 1180 }] })).code, "TENDER", "no card without a provider");
  const split = await sell(cashier, { lines: [{ productId: String(pShirt), quantity: 1 }], tenders: [{ method: "BANK_TRANSFER", amount: 1000, reference: "NAYAPAY-778" }, { method: "CASH", amount: 200 }] });
  assert.ok(!split.error, split.error); assert.equal(split.sale.tenders.length, 2); assert.equal(split.sale.change, 20, "180 cash due, 200 given");
});

test("restricted discounts need an approval from a supervisor in their own session, bound to the exact cart", { timeout: 120000 }, async () => {
  const cart = { warehouseId: String(w), lines: [{ productId: String(pShirt), quantity: 1, discount: { type: "percent", value: 25 } }] };
  const blocked = await sell(cashier, { ...cart, tenders: [{ method: "CASH", amount: 900 }] });
  assert.equal(blocked.code, "APPROVAL_REQUIRED");
  const req = await SALE.requestApproval({ orgId: ORG, membership: cashier, actorEmail: cashier.email, input: cart });
  assert.equal(req.needed, "supervisor");
  assert.equal((await SALE.decideApproval({ orgId: ORG, membership: cashier, actorEmail: cashier.email, approvalId: req.approvalId, approve: true })).status, 403, "a cashier cannot approve");
  const ok = await SALE.decideApproval({ orgId: ORG, membership: supervisor, actorEmail: supervisor.email, approvalId: req.approvalId, approve: true, reason: "Loyal customer" });
  assert.equal(ok.status, "APPROVED");
  const changed = await sell(cashier, { ...cart, lines: [{ ...cart.lines[0], quantity: 2 }], approvalId: req.approvalId, tenders: [{ method: "CASH", amount: 1800 }] });
  assert.equal(changed.code, "APPROVAL_INVALID", "an approval is bound to the exact cart");
  const done = await sell(cashier, { ...cart, approvalId: req.approvalId, tenders: [{ method: "CASH", amount: 900 }] });
  assert.ok(!done.error, done.error); assert.equal(done.sale.approvedBy, supervisor.email);
  assert.equal((await sell(cashier, { ...cart, approvalId: req.approvalId, tenders: [{ method: "CASH", amount: 900 }] })).code, "APPROVAL_INVALID", "an approval is used once");
});

test("parked carts resume and disappear when sold; tenants and roles are isolated", { timeout: 120000 }, async () => {
  const p = await SALE.parkSale({ orgId: ORG, membership: cashier, actorEmail: cashier.email, input: { warehouseId: String(w), lines: [{ productId: String(pShirt), quantity: 1 }] }, label: "Table by the door" });
  const list = await SALE.listParked({ orgId: ORG, membership: cashier }); assert.ok(list.parked.some((x) => x.id === p.parkedId));
  const r = await sell(cashier, { lines: [{ productId: String(pShirt), quantity: 1 }], tenders: [{ method: "CASH", amount: 1200 }], parkedId: p.parkedId });
  assert.ok(!r.error); assert.ok(!(await SALE.listParked({ orgId: ORG, membership: cashier })).parked.some((x) => x.id === p.parkedId));
  assert.equal((await SALE.getSale({ orgId: String(other), membership: owner, saleId: r.sale.id })).status, 404, "another company cannot read this sale");
  assert.equal((await sell({ role: "member", email: "nobody@shop.example" }, { lines: [{ productId: String(pShirt), quantity: 1 }], tenders: [{ method: "CASH", amount: 1200 }] })).code, "COMMERCE_ROLE");
  await c.orgs.updateOne({ _id: orgId }, { $set: { "features.FEATURE_COMMERCE": false } });
  assert.equal((await sell(owner, { lines: [{ productId: String(pShirt), quantity: 1 }], tenders: [{ method: "CASH", amount: 1200 }] })).code, "COMMERCE_NOT_ENABLED");
  await c.orgs.updateOne({ _id: orgId }, { $set: { "features.FEATURE_COMMERCE": true } });
});
