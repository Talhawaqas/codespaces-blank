// test/commerce-orders-reports.test.mjs -- Inaya Commerce, Batch 4 gate: the extended order lifecycle (quote, deposit,
// part-paid/paid, backorder, reservation, picking/packing, ready for pickup, dispatched, delivered/collected, cancelled,
// returned) keeps stock and money exact; commerce report totals reconcile to the transactions and drill down to them;
// receipts render as PDFs and never pretend to email without a provider.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import * as S from "../src/lib/commerce/store.js";
import * as TAX from "../src/lib/commerce/tax.js";
import * as SALE from "../src/lib/commerce/sale.js";
import * as RET from "../src/lib/commerce/returns.js";
import * as REP from "../src/lib/commerce/reports.js";
import * as RC from "../src/lib/commerce/receipts.js";
import { recordStockMovement, getFreeStock, reconcileStockLevels } from "../src/lib/inventory.js";
import { createSalesOrder, transitionSalesOrder } from "../src/lib/sales-orders.js";

const orgId = new ObjectId(); const ORG = String(orgId);
const owner = { role: "owner", email: "owner@b4.example" };
const cashier = { role: "member", commerceRole: "cashier", email: "cash@b4.example" };
const cashier2 = { role: "member", commerceRole: "cashier", email: "cash2@b4.example" };
let c, dep, w, pA, pB, pSvc, customer;
const free = (p) => getFreeStock(ORG, String(p), String(w));
const t = (orderId, action, input = {}) => transitionSalesOrder({ orgId: ORG, orderId, action, membership: owner, actorEmail: owner.email, input });
const order = (lines, extra = {}) => createSalesOrder({ orgId: ORG, membership: owner, actorEmail: owner.email, departmentId: String(dep), contactId: String(customer), warehouseId: String(w), currency: "PKR", lines, ...extra });
const sell = (m, input) => SALE.completeSale({ orgId: ORG, membership: m, actorEmail: m.email, input: { warehouseId: String(w), idempotencyKey: SALE.newIdempotencyKey(), ...input } });

before(async () => {
  await ensureOrgIndexes(); c = await getOrgCollections(); const now = new Date().toISOString();
  await c.orgs.insertOne({ _id: orgId, name: "b4 shop", features: { FEATURE_COMMERCE: true }, createdAt: now });
  dep = (await c.departments.insertOne({ orgId, name: "Sales", createdAt: now })).insertedId;
  w = (await c.warehouses.insertOne({ orgId, departmentId: dep, name: "Main", createdAt: now })).insertedId;
  const mk = (x) => c.products.insertOne({ orgId, departmentId: dep, status: "ACTIVE", deletedAt: null, createdAt: now, ...x }).then((r) => r.insertedId);
  pA = await mk({ sku: `A-${Date.now()}`, name: "Kettle", unitPrice: 2000, category: "Kitchen" });
  pB = await mk({ sku: `B-${Date.now()}`, name: "Mug", unitPrice: 300, category: "Kitchen" });
  pSvc = await mk({ sku: `S-${Date.now()}`, name: "Gift wrap", unitPrice: 100, productType: "SERVICE", category: "Services" });
  customer = (await c.crmContacts.insertOne({ orgId, departmentId: dep, name: "Bulk buyer", createdAt: now, deletedAt: null })).insertedId;
  await S.updateSettings({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { currency: "PKR", taxMode: "exclusive", timezone: "Asia/Karachi", refundRole: "cashier" } });
  await TAX.saveTaxCategory({ orgId: ORG, membership: owner, actorEmail: owner.email, code: "GST", name: "GST", rate: 10, isDefault: true });
  await recordStockMovement({ orgId: ORG, productId: String(pA), warehouseId: String(w), delta: 10, type: "RECEIPT", actorEmail: "t", unitCost: 1200 });
  await recordStockMovement({ orgId: ORG, productId: String(pB), warehouseId: String(w), delta: 50, type: "RECEIPT", actorEmail: "t", unitCost: 100 });
});
after(async () => {
  for (const n of ["orgs", "departments", "warehouses", "products", "crm_contacts", "calendar_records", "stock_levels", "stock_movements", "stock_lots", "sales_orders", "invoices", "journal_entries", "ledger_accounts", "org_activity", "webhook_deliveries"]) await c.db.collection(n).deleteMany(n === "orgs" ? { _id: orgId } : { orgId }).catch(() => {});
  await (await mongoClientPromise).close();
});

test("reservations: a confirmed order holds stock the till cannot sell; dispatch consumes it; cancel releases it; reconciliation agrees", { timeout: 120000 }, async () => {
  const o = (await order([{ productId: String(pA), quantity: 8, unitPrice: 1900 }])).order;
  assert.equal((await t(o.id, "confirm")).order.status, "CONFIRMED");
  assert.deepEqual(await free(pA), { onHand: 10, reserved: 8, free: 2 });
  const tooMuch = await sell(cashier, { lines: [{ productId: String(pA), quantity: 3 }], tenders: [{ method: "CASH", amount: 10000 }] });
  assert.equal(tooMuch.code, "INSUFFICIENT_STOCK", "the till can't sell reserved stock");
  assert.ok(!(await sell(cashier, { lines: [{ productId: String(pA), quantity: 2 }], tenders: [{ method: "CASH", amount: 10000 }] })).error, "free stock still sells");
  const rec = await reconcileStockLevels({ orgId: ORG }); assert.equal(rec.reservationIssues.length, 0);
  assert.equal((await t(o.id, "cancel")).order.status, "CANCELLED");
  assert.deepEqual(await free(pA), { onHand: 8, reserved: 0, free: 8 }, "cancel released the reservation");
});

test("backorder: confirm reserves what exists, the rest waits; after a receipt it is reserved and the order dispatches exactly once", { timeout: 120000 }, async () => {
  const o = (await order([{ productId: String(pA), quantity: 12, unitPrice: 1900 }, { productId: String(pSvc), quantity: 1, unitPrice: 100 }])).order;
  assert.equal((await t(o.id, "confirm")).status, 409, "without allowBackorder nothing is reserved");
  assert.equal((await free(pA)).reserved, 0);
  const b = (await t(o.id, "confirm", { allowBackorder: true })).order;
  assert.equal(b.status, "BACKORDERED"); assert.equal(b.lines[0].reservedQty, 8); assert.equal(b.lines[0].backorderQty, 4);
  assert.equal((await t(o.id, "fulfil")).status, 409, "a backordered order can't dispatch");
  await recordStockMovement({ orgId: ORG, productId: String(pA), warehouseId: String(w), delta: 6, type: "RECEIPT", actorEmail: "t", unitCost: 1250 });
  assert.equal((await t(o.id, "reserve")).order.status, "CONFIRMED");
  assert.deepEqual(await free(pA), { onHand: 14, reserved: 12, free: 2 });
  for (const a of ["pick", "pack"]) assert.ok(!(await t(o.id, a)).error);
  assert.equal((await t(o.id, "ready")).status, 409, "a delivery order isn't 'ready for pickup'");
  const f = (await t(o.id, "fulfil")).order; assert.equal(f.status, "FULFILLED"); assert.equal(f.stage, "DISPATCHED");
  assert.deepEqual(await free(pA), { onHand: 2, reserved: 0, free: 2 });
  assert.equal((await t(o.id, "fulfil")).status, 409, "no second dispatch");
  assert.equal((await t(o.id, "deliver")).order.stage, "DELIVERED");
});

test("quote -> accept -> pickup flow ends COLLECTED; expired quotes can't be accepted", { timeout: 120000 }, async () => {
  const q = (await order([{ productId: String(pB), quantity: 5, unitPrice: 280 }], { quote: true, validUntil: "2099-01-01", fulfilmentMethod: "PICKUP" })).order;
  assert.equal(q.status, "QUOTE"); assert.match(q.orderNumber, /^QT-/);
  assert.equal((await t(q.id, "payment", { method: "CASH", amount: 100 })).status, 409, "quotes take no money");
  assert.equal((await t(q.id, "accept")).order.status, "DRAFT");
  await t(q.id, "confirm"); for (const a of ["pick", "pack", "ready"]) assert.ok(!(await t(q.id, a)).error, a);
  const done = (await t(q.id, "fulfil")).order; assert.equal(done.stage, "COLLECTED");
  const old = (await order([{ productId: String(pB), quantity: 1, unitPrice: 280 }], { quote: true, validUntil: "2020-01-01" })).order;
  assert.equal((await t(old.id, "accept")).status, 409);
});

test("deposits: part-paid then paid; bounded; the ledger holds them as customer deposits and applies them when the invoice is paid", { timeout: 180000 }, async () => {
  const o = (await order([{ productId: String(pB), quantity: 10, unitPrice: 300 }])).order; // 3000, no default tax in document settings
  await t(o.id, "confirm");
  const d1 = (await t(o.id, "payment", { method: "BANK_TRANSFER", amount: 1000, reference: "DEP-1" })).order;
  assert.equal(d1.paymentStatus, "PART_PAID"); assert.equal(d1.payments[0].kind, "DEPOSIT"); assert.equal(d1.balance, 2000);
  assert.equal((await t(o.id, "payment", { method: "CASH", amount: 2500 })).status, 409, "no overpayment");
  assert.equal((await t(o.id, "payment", { method: "BANK_TRANSFER", amount: 10 })).status, 400, "non-cash needs a reference");
  assert.equal((await t(o.id, "cancel")).status, 409, "can't cancel while holding a deposit");
  const dep = await c.db.collection("journal_entries").findOne({ orgId, "source.type": "ORDER_PAYMENT", "source.event": "RECEIVED" });
  assert.ok(dep.lines.some((l) => l.accountCode === "2200" && l.credit > 0), "deposit is a liability");
  await t(o.id, "fulfil"); await t(o.id, "invoice");
  const ord = await c.salesOrders.findOne({ _id: new ObjectId(o.id) });
  await c.invoices.updateOne({ _id: ord.invoiceId }, { $set: { status: "SENT" } });
  const paid = (await t(o.id, "payment", { method: "CASH", amount: 2000 })).order; assert.equal(paid.paymentStatus, "PAID");
  assert.equal((await c.invoices.findOne({ _id: ord.invoiceId })).status, "PAID", "paying the order paid its sent invoice");
  const { syncLedger } = await import("../src/lib/ledger.js"); await syncLedger(ORG);
  const je = await c.db.collection("journal_entries").find({ orgId }).toArray();
  const bal = (code) => Math.round(je.flatMap((e) => e.lines).filter((l) => l.accountCode === code).reduce((n, l) => n + l.debit - l.credit, 0) * 100) / 100;
  const cashFromOrder = je.filter((e) => ["ORDER_PAYMENT"].includes(e.source.type) || (e.source.type === "INVOICE" && e.source.event === "PAID")).flatMap((e) => e.lines).filter((l) => l.accountCode === "1000").reduce((n, l) => n + l.debit - l.credit, 0);
  assert.equal(bal("2200"), 0, "deposits fully applied"); assert.equal(bal("1100"), 0, "receivable cleared");
  assert.ok(Math.abs(cashFromOrder - 3000 / (je.find((e) => e.source.type === "ORDER_PAYMENT").lines[0].fxRate ? 1 / je.find((e) => e.source.type === "ORDER_PAYMENT").lines[0].fxRate : 1)) < 1, "cash counted once (no double count from the invoice payment)");
  assert.equal((await t(o.id, "refund", { method: "CASH", amount: 100, reason: "goodwill" })).status, 409, "applied deposits are refunded through Accounting");
});

test("order returns: bounded per line, restock vs damaged, RETURNED when everything is back", { timeout: 120000 }, async () => {
  const o = (await order([{ productId: String(pB), quantity: 4, unitPrice: 300 }])).order; await t(o.id, "confirm"); await t(o.id, "fulfil");
  const before = (await free(pB)).onHand;
  assert.equal((await t(o.id, "return", { reason: "wrong colour", lines: [{ lineIndex: 0, quantity: 5 }] })).status, 409);
  assert.ok(!(await t(o.id, "return", { reason: "wrong colour", lines: [{ lineIndex: 0, quantity: 3 }] })).error);
  const r = (await t(o.id, "return", { reason: "broken", lines: [{ lineIndex: 0, quantity: 1, disposition: "DAMAGED" }] })).order;
  assert.equal(r.status, "RETURNED"); assert.equal(r.returns.length, 2);
  assert.equal((await free(pB)).onHand, before + 3, "3 restocked, 1 damaged written off");
});

test("report totals reconcile to the transactions, every breakdown sums to the headline, and drill-down finds the source sales", { timeout: 180000 }, async () => {
  const t0 = new Date(Date.now() - 60000).toISOString();
  const s1 = (await sell(cashier, { lines: [{ productId: String(pB), quantity: 2 }, { productId: String(pSvc), quantity: 1 }], tenders: [{ method: "CASH", amount: 770 }] })).sale; // (600+100)*1.1 = 770
  const s2 = (await sell(cashier2, { lines: [{ productId: String(pB), quantity: 3, discount: { type: "percent", value: 10 } }], tenders: [{ method: "BANK_TRANSFER", amount: 891, reference: "BT-1" }] })).sale; // 810*1.1
  const s3 = (await sell(cashier, { lines: [{ productId: String(pB), quantity: 1 }], tenders: [{ method: "CASH", amount: 330 }] })).sale;
  assert.ok(!(await RET.voidSale({ orgId: ORG, membership: owner, actorEmail: owner.email, saleId: s3.id, reason: "test" })).error);
  const rf = await RET.processReturn({ orgId: ORG, membership: cashier, actorEmail: cashier.email, input: { saleId: s1.id, idempotencyKey: SALE.newIdempotencyKey(), reason: "changed mind", lines: [{ lineIndex: 0, quantity: 1 }] } });
  assert.ok(!rf.error, rf.error);
  const to = new Date(Date.now() + 60000).toISOString();
  // the report covers this test's transactions plus test 1's two-kettle sale (also within the period) -- isolate by time
  const rep = await REP.commerceReport({ orgId: ORG, membership: owner, input: { from: t0, to } });
  assert.ok(!rep.error, rep.error);
  const T = rep.totals;
  assert.equal(T.sales, 2, "voided sale excluded"); assert.equal(T.voids.count, 1); assert.equal(T.voids.total, 330);
  assert.equal(T.gross, 700 + 900); assert.equal(T.discounts, 90); assert.equal(T.returns, 300);
  assert.equal(T.net, 700 + 810 - 300); assert.equal(T.tax, 70 + 81 - 30); assert.equal(T.totalCollected, 770 + 891 - 330);
  assert.equal(T.atv, (770 + 891) / 2); assert.equal(T.upt, (3 + 3) / 2);
  const sum = (arr, k) => Math.round(arr.reduce((n, x) => n + x[k], 0) * 100) / 100;
  for (const d of ["day", "hour", "employee", "register", "branch", "product", "category"]) {
    assert.equal(sum(rep.by[d], "net"), T.net, `${d} net reconciles`); assert.equal(sum(rep.by[d], "total"), T.totalCollected, `${d} total reconciles`);
  }
  assert.equal(Math.round(Object.values(rep.paymentMethods).reduce((n, v) => n + v, 0) * 100) / 100, T.totalCollected, "payment methods reconcile");
  assert.equal(rep.paymentMethods.BANK_TRANSFER, 891); assert.equal(rep.paymentMethods.CASH, 770 - 330);
  assert.equal(T.grossMargin.reliable, true); assert.equal(T.grossMargin.amount, T.net - (2 * 100 + 3 * 100 - 100), "cost of goods: 5 mugs sold, 1 restocked");
  const mug = rep.by.product.find((x) => x.key.startsWith("Mug"));
  const drill = await REP.reportTransactions({ orgId: ORG, membership: owner, input: { from: t0, to, dimension: "product", value: mug.key } });
  assert.equal(drill.net, mug.net, "drill-down sums to the bucket"); assert.deepEqual(new Set(drill.transactions.filter((x) => x.kind !== "void").map((x) => x.saleId)), new Set([s1.id, s2.id]));
  const byCashier = rep.by.employee.find((x) => x.key === cashier2.email); assert.equal(byCashier.total, 891);
  assert.equal((await REP.commerceReport({ orgId: ORG, membership: cashier, input: {} })).code, "COMMERCE_ROLE", "cashiers don't see reports");
});

test("receipts: a branded PDF that matches the sale; email refuses honestly when no provider is configured", { timeout: 60000 }, async () => {
  const s = (await sell(cashier, { lines: [{ productId: String(pB), quantity: 1 }], tenders: [{ method: "CASH", amount: 330 }], notes: "deliver to back door" })).sale;
  const r = await RC.receiptPdf({ orgId: ORG, membership: cashier, saleId: s.id });
  assert.ok(!r.error, r.error); assert.equal(r.pdf.subarray(0, 4).toString(), "%PDF"); assert.equal(r.filename, `${s.saleNumber}.pdf`);
  assert.equal(r.receipt.notes, undefined, "notes are hidden unless the company turns them on");
  assert.equal(r.receipt.totals.total, 330);
  const saved = process.env.RESEND_API_KEY; process.env.RESEND_API_KEY = "";
  try { const e = await RC.emailReceipt({ orgId: ORG, membership: cashier, actorEmail: cashier.email, saleId: s.id, to: "buyer@example.com" }); assert.equal(e.code, "EMAIL_NOT_CONFIGURED"); }
  finally { if (saved !== undefined) process.env.RESEND_API_KEY = saved; }
  const rr = await RC.receiptPdf({ orgId: ORG, membership: cashier, saleId: (await c.salesOrders.findOne({ orgId, "refunds.0": { $exists: true } }))._id.toString(), refundNumber: "R-000001" });
  assert.ok(!rr.error, rr.error); assert.equal(rr.pdf.subarray(0, 4).toString(), "%PDF");
});
