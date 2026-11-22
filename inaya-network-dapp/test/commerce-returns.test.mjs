// test/commerce-returns.test.mjs -- Inaya Commerce, Batch 3 gate: refunds are linked, bounded and auditable; voids and
// refunds need the right role or an approval from someone else; exchanges are atomic; shift reconciliation is exact.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import * as S from "../src/lib/commerce/store.js";
import * as TAX from "../src/lib/commerce/tax.js";
import * as SALE from "../src/lib/commerce/sale.js";
import * as RET from "../src/lib/commerce/returns.js";
import * as SH from "../src/lib/commerce/shifts.js";
import { recordStockMovement, getStockLevel } from "../src/lib/inventory.js";

const orgId = new ObjectId(); const ORG = String(orgId); const other = new ObjectId();
const owner = { role: "owner", email: "owner@ret.example" };
const manager2 = { role: "member", commerceRole: "manager", email: "mgr2@ret.example" };
const cashier = { role: "member", commerceRole: "cashier", email: "cash@ret.example" };
const supervisor = { role: "member", commerceRole: "supervisor", email: "sup@ret.example" };
let c, w, q, pShirt, pCap, pSvc, customer, register;
const key = () => SALE.newIdempotencyKey();
const stock = (p, wh = w) => getStockLevel(ORG, String(p), String(wh));
const sell = (m, input) => SALE.completeSale({ orgId: ORG, membership: m, actorEmail: m.email, input: { warehouseId: String(w), idempotencyKey: key(), ...input } });
const ret = (m, input) => RET.processReturn({ orgId: ORG, membership: m, actorEmail: m.email, input: { idempotencyKey: key(), reason: "customer changed mind", ...input } });
const approve = async (requester, approver, req) => { assert.ok(!req.error, req.error); const d = await SALE.decideApproval({ orgId: ORG, membership: approver, actorEmail: approver.email, approvalId: req.approvalId, approve: true }); assert.equal(d.status, "APPROVED"); return req.approvalId; };

before(async () => {
  await ensureOrgIndexes(); c = await getOrgCollections(); const now = new Date().toISOString(); const dep = new ObjectId();
  await c.orgs.insertMany([{ _id: orgId, name: "commerce-returns", features: { FEATURE_COMMERCE: true }, createdAt: now }, { _id: other, name: "other-ret", features: { FEATURE_COMMERCE: true }, createdAt: now }]);
  w = (await c.warehouses.insertOne({ orgId, departmentId: dep, name: "Shop", createdAt: now })).insertedId;
  q = (await c.warehouses.insertOne({ orgId, departmentId: dep, name: "Quarantine", createdAt: now })).insertedId;
  const mk = (x) => c.products.insertOne({ orgId, departmentId: dep, status: "ACTIVE", deletedAt: null, createdAt: now, ...x }).then((r) => r.insertedId);
  pShirt = await mk({ sku: `RS-${Date.now()}`, name: "Shirt", unitPrice: 1000 });
  pCap = await mk({ sku: `RC-${Date.now()}`, name: "Cap", unitPrice: 333.33 });
  pSvc = await mk({ sku: `RV-${Date.now()}`, name: "Alteration", unitPrice: 300, productType: "SERVICE" });
  customer = (await c.crmContacts.insertOne({ orgId, departmentId: dep, name: "Regular", createdAt: now })).insertedId;
  await S.updateSettings({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { currency: "PKR", taxMode: "exclusive", rounding: { mode: "line", cashIncrement: 100 }, quarantineWarehouseId: String(q), cashVarianceTolerance: 1000 } });
  await TAX.saveTaxCategory({ orgId: ORG, membership: owner, actorEmail: owner.email, code: "GST", name: "GST", rate: 18, isDefault: true });
  for (const p of [pShirt, pCap]) await recordStockMovement({ orgId: ORG, productId: String(p), warehouseId: String(w), delta: 50, type: "RECEIPT", actorEmail: "t", unitCost: 400 });
  register = (await SH.saveRegister({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { code: "T1", name: "Till 1", warehouseId: String(w) } })).id;
});
after(async () => {
  for (const n of ["orgs", "warehouses", "products", "crm_contacts", "calendar_records", "stock_levels", "stock_movements", "sales_orders", "journal_entries", "ledger_accounts", "org_activity", "webhook_deliveries"]) await c.db.collection(n).deleteMany(n === "orgs" ? { _id: { $in: [orgId, other] } } : { orgId }).catch(() => {});
  await (await mongoClientPromise).close();
});

test("a partial return refunds proportionally with tax reversal, restocks once, is linked, posts to the ledger and is audited", { timeout: 120000 }, async () => {
  const s = (await sell(owner, { customerId: String(customer), lines: [{ productId: String(pShirt), quantity: 3 }, { productId: String(pSvc), quantity: 1 }], tenders: [{ method: "CASH", amount: 4000 }] })).sale;
  assert.equal(s.totals.total, 3894); // (3000 + 300) * 1.18
  const before = await stock(pShirt);
  const r = await ret(owner, { saleId: s.id, lines: [{ lineIndex: 0, quantity: 1 }] });
  assert.ok(!r.error, r.error);
  assert.match(r.refund.refundNumber, /^R-\d{6}$/);
  assert.equal(r.refund.net, 1000); assert.equal(r.refund.tax, 180); assert.equal(r.refund.total, 1180);
  assert.deepEqual(r.refund.tenders.map((t) => [t.method, t.amount]), [["CASH", 1180]], "back to the original (cash) payment");
  assert.equal(await stock(pShirt), before + 1, "restocked exactly once");
  assert.equal(r.sale.status, "PARTIALLY_REFUNDED"); assert.equal(r.sale.refunded, 1180); assert.equal(r.sale.lines[0].returnedQty, 1);
  const cust = await c.crmContacts.findOne({ _id: customer }); assert.equal(cust.commerce.spendMinor, 389400 - 118000); assert.equal(cust.commerce.returnCount, 1);
  const je = await c.db.collection("journal_entries").findOne({ orgId, "source.type": "POS_REFUND", "source.id": `${s.id}:${r.refund.refundNumber}` });
  assert.ok(je, "ledger has the refund"); const d = je.lines.reduce((a, l) => a + l.debit, 0), cr = je.lines.reduce((a, l) => a + l.credit, 0); assert.ok(Math.abs(d - cr) < 0.01, "balanced");
  assert.ok(await c.db.collection("org_activity").findOne({ orgId, action: "REFUND_COMPLETED" }), "audited");
  const rc = await RET.refundReceipt({ orgId: ORG, membership: cashier, saleId: s.id, refundNumber: r.refund.refundNumber });
  assert.equal(rc.receipt.total, 1180); assert.equal(rc.receipt.saleNumber, s.saleNumber, "refund receipt links the original sale");
});

test("bounded: cannot return more than sold, cannot exceed the refundable balance, last unit takes the exact remainder", { timeout: 120000 }, async () => {
  const s = (await sell(owner, { lines: [{ productId: String(pCap), quantity: 3 }], tenders: [{ method: "CASH", amount: 1500 }] })).sale;
  const total = s.totals.total;
  const over = await ret(owner, { saleId: s.id, lines: [{ lineIndex: 0, quantity: 4 }] }); assert.equal(over.code, "OVER_RETURN");
  const a = await ret(owner, { saleId: s.id, lines: [{ lineIndex: 0, quantity: 1 }] }); const b = await ret(owner, { saleId: s.id, lines: [{ lineIndex: 0, quantity: 1 }] });
  const last = await ret(owner, { saleId: s.id, lines: [{ lineIndex: 0, quantity: 1 }] });
  assert.ok(!last.error, last.error); assert.equal(last.sale.status, "REFUNDED");
  assert.equal(Math.round((a.refund.total + b.refund.total + last.refund.total) * 100), Math.round(total * 100), "three thirds add up to exactly what was paid");
  const again = await ret(owner, { saleId: s.id, lines: [{ lineIndex: 0, quantity: 1 }] }); assert.equal(again.code, "NOT_RETURNABLE");
});

test("duplicate submissions and concurrent returns never refund twice", { timeout: 120000 }, async () => {
  const s = (await sell(owner, { lines: [{ productId: String(pShirt), quantity: 2 }], tenders: [{ method: "CASH", amount: 2360 }] })).sale;
  const k = key(); const input = { saleId: s.id, lines: [{ lineIndex: 0, quantity: 1 }], idempotencyKey: k };
  const r1 = await ret(owner, input); const r2 = await ret(owner, input);
  assert.equal(r2.duplicate, true); assert.equal(r2.refund.refundNumber, r1.refund.refundNumber);
  const before = await stock(pShirt);
  const race = await Promise.all([1, 2, 3].map(() => ret(owner, { saleId: s.id, lines: [{ lineIndex: 0, quantity: 1 }] })));
  assert.equal(race.filter((x) => !x.error).length, 1, "only one unit was left, so only one concurrent return succeeds");
  assert.equal(await stock(pShirt), before + 1);
  const doc = await c.salesOrders.findOne({ _id: new ObjectId(s.id) }); assert.equal(doc.refunds.length, 2); assert.equal(doc.lines[0].returnedQty, 2); assert.equal(doc.refundedMinor, doc.totals.totalMinor);
});

test("permissions: a cashier needs a supervisor's approval to refund; out-of-window needs a manager; nobody approves themselves", { timeout: 120000 }, async () => {
  const s = (await sell(cashier, { lines: [{ productId: String(pShirt), quantity: 1 }], tenders: [{ method: "CASH", amount: 1180 }] })).sale;
  const input = { saleId: s.id, lines: [{ lineIndex: 0, quantity: 1, disposition: "DAMAGED" }], reason: "torn seam" };
  const no = await ret(cashier, input); assert.equal(no.code, "APPROVAL_REQUIRED");
  const req = await RET.requestReturnApproval({ orgId: ORG, membership: cashier, actorEmail: cashier.email, input });
  const self = await SALE.decideApproval({ orgId: ORG, membership: supervisor, actorEmail: cashier.email, approvalId: req.approvalId, approve: true }); assert.equal(self.code, "SELF_APPROVAL");
  const approvalId = await approve(cashier, supervisor, req);
  const other = await ret(cashier, { ...input, lines: [{ lineIndex: 0, quantity: 1, disposition: "RESTOCK" }], approvalId }); assert.equal(other.code, "APPROVAL_INVALID", "the approval is bound to the exact request");
  const before = await stock(pShirt);
  const ok = await ret(cashier, { ...input, approvalId }); assert.ok(!ok.error, ok.error);
  assert.equal(await stock(pShirt), before, "damaged: returned and written off, net zero on the shelf");
  const mv = await c.db.collection("stock_movements").find({ orgId, relatedSaleId: new ObjectId(s.id) }).toArray();
  assert.deepEqual(mv.map((x) => x.type).sort(), ["RETURN", "SALE", "WRITE_OFF"]);
  const reuse = await ret(cashier, { ...input, approvalId }); assert.ok(reuse.error, "single use");
  // out of the return window: manager only
  await c.salesOrders.updateOne({ _id: new ObjectId((await sell(owner, { lines: [{ productId: String(pCap), quantity: 1 }], tenders: [{ method: "CASH", amount: 400 }] })).sale.id) }, { $set: { completedAt: new Date(Date.now() - 40 * 86400000).toISOString() } });
  const old = await c.salesOrders.find({ orgId, channel: "POS" }).sort({ completedAt: 1 }).limit(1).next();
  const late = await ret(supervisor, { saleId: String(old._id), lines: [{ lineIndex: 0, quantity: 1 }] }); assert.equal(late.code, "APPROVAL_REQUIRED");
  const lr = await RET.requestReturnApproval({ orgId: ORG, membership: supervisor, actorEmail: supervisor.email, input: { saleId: String(old._id), lines: [{ lineIndex: 0, quantity: 1 }], reason: "customer changed mind" } });
  assert.equal(lr.needed, "manager");
  const bySup = await SALE.decideApproval({ orgId: ORG, membership: { ...supervisor, email: "sup2@ret.example" }, actorEmail: "sup2@ret.example", approvalId: lr.approvalId, approve: true }); assert.equal(bySup.code, "APPROVER_ROLE");
});

test("quarantine returns go to the quarantine location; refunds to a different method need approval", { timeout: 120000 }, async () => {
  const s = (await sell(owner, { lines: [{ productId: String(pShirt), quantity: 1 }], tenders: [{ method: "BANK_TRANSFER", amount: 1180, reference: "TXN-1" }] })).sale;
  const beforeQ = await stock(pShirt, q);
  const pv = await RET.previewReturn({ orgId: ORG, membership: cashier, input: { saleId: s.id, reason: "faulty", lines: [{ lineIndex: 0, quantity: 1, disposition: "QUARANTINE" }], refundTo: [{ method: "CASH" }] } });
  assert.ok(pv.exceptions.some((x) => x.kind === "refund_method" && x.needed === "supervisor"), "paid by bank, refunded in cash: an exception a supervisor must allow");
  assert.equal(pv.approvalNeeded, "supervisor");
  const r = await ret(supervisor, { saleId: s.id, lines: [{ lineIndex: 0, quantity: 1, disposition: "QUARANTINE" }], refundTo: [{ method: "BANK_TRANSFER", amount: 1180, reference: "RF-1" }] });
  assert.ok(!r.error, r.error); assert.equal(await stock(pShirt, q), beforeQ + 1);
  const store = await ret(owner, { saleId: s.id, lines: [{ lineIndex: 0, quantity: 1 }], refundTo: [{ method: "STORE_CREDIT" }] }); assert.ok(store.error);
});

test("an exchange returns and sells in one transaction; the credit pays first and only the difference changes hands", { timeout: 120000 }, async () => {
  const s = (await sell(owner, { customerId: String(customer), lines: [{ productId: String(pCap), quantity: 2 }], tenders: [{ method: "CASH", amount: 800 }] })).sale; // 2 x 333.33 x 1.18 = 786.66
  const capBefore = await stock(pCap), shirtBefore = await stock(pShirt);
  const fail1 = await ret(owner, { saleId: s.id, lines: [{ lineIndex: 0, quantity: 2 }], exchange: { lines: [{ productId: String(pShirt), quantity: 1 }], tenders: [] } });
  assert.ok(fail1.error, "the shirt costs more, the difference must be paid");
  assert.equal(await stock(pCap), capBefore, "a failed exchange leaves no partial return");
  const r = await ret(owner, { saleId: s.id, lines: [{ lineIndex: 0, quantity: 2 }], exchange: { lines: [{ productId: String(pShirt), quantity: 1 }], tenders: [{ method: "CASH", amount: 400 }] } });
  assert.ok(!r.error, r.error);
  assert.equal(r.exchangeSale.tenders[0].method, "EXCHANGE_CREDIT"); assert.equal(r.exchangeSale.tenders[0].amount, r.refund.total);
  assert.equal(r.refund.tenders.find((t) => t.method === "EXCHANGE").amount, r.refund.total, "all the credit went to the new sale");
  assert.equal(await stock(pCap), capBefore + 2); assert.equal(await stock(pShirt), shirtBefore - 1);
  const ex = await c.salesOrders.findOne({ _id: new ObjectId(r.exchangeSale.id) }); assert.equal(String(ex.exchangeOf), s.id);
});

test("void: a cashier needs a supervisor; stock, customer and ledger are reversed; a sale with returns cannot be voided", { timeout: 120000 }, async () => {
  const s = (await sell(cashier, { customerId: String(customer), lines: [{ productId: String(pShirt), quantity: 2 }], tenders: [{ method: "CASH", amount: 2360 }] })).sale;
  const before = await stock(pShirt); const cust0 = (await c.crmContacts.findOne({ _id: customer })).commerce;
  const no = await RET.voidSale({ orgId: ORG, membership: cashier, actorEmail: cashier.email, saleId: s.id, reason: "wrong item scanned" }); assert.equal(no.code, "APPROVAL_REQUIRED");
  const req = await RET.requestVoidApproval({ orgId: ORG, membership: cashier, actorEmail: cashier.email, saleId: s.id, reason: "wrong item scanned" });
  const approvalId = await approve(cashier, supervisor, req);
  const v = await RET.voidSale({ orgId: ORG, membership: cashier, actorEmail: cashier.email, saleId: s.id, reason: "wrong item scanned", approvalId });
  assert.ok(!v.error, v.error); assert.equal(v.sale.status, "VOIDED"); assert.equal(v.sale.voided.approvedBy, supervisor.email);
  assert.equal(await stock(pShirt), before + 2);
  const cust1 = (await c.crmContacts.findOne({ _id: customer })).commerce; assert.equal(cust1.purchaseCount, cust0.purchaseCount - 1); assert.equal(cust1.spendMinor, cust0.spendMinor - 236000);
  assert.ok(await c.db.collection("journal_entries").findOne({ orgId, "source.type": "POS_SALE", "source.id": s.id, "source.event": "VOIDED" }), "ledger reversal");
  const twice = await RET.voidSale({ orgId: ORG, membership: owner, actorEmail: owner.email, saleId: s.id, reason: "again" }); assert.equal(twice.code, "NOT_VOIDABLE");
  const back = await ret(owner, { saleId: s.id, lines: [{ lineIndex: 0, quantity: 1 }] }); assert.equal(back.code, "NOT_RETURNABLE");
});

test("shift: one open shift per register, sales tied to it, exact expected cash, over/short, flagged review and audited corrections", { timeout: 180000 }, async () => {
  const noShift = await sell(cashier, { registerId: register, lines: [{ productId: String(pShirt), quantity: 1 }], tenders: [{ method: "CASH", amount: 1180 }] }); assert.equal(noShift.code, "NO_OPEN_SHIFT");
  const open = await SH.openShift({ orgId: ORG, membership: cashier, actorEmail: cashier.email, registerId: register, openingFloat: 5000 }); assert.ok(!open.error, open.error);
  const dup = await SH.openShift({ orgId: ORG, membership: supervisor, actorEmail: supervisor.email, registerId: register, openingFloat: 0 }); assert.equal(dup.code, "SHIFT_OPEN");
  const sh = open.shift.id;
  const a = (await sell(cashier, { registerId: register, lines: [{ productId: String(pShirt), quantity: 1 }], tenders: [{ method: "CASH", amount: 2000 }] })).sale; // 1180 cash, 820 change
  await sell(cashier, { registerId: register, lines: [{ productId: String(pShirt), quantity: 1 }], tenders: [{ method: "BANK_TRANSFER", amount: 1180, reference: "B-9" }] });
  const v = (await sell(cashier, { registerId: register, lines: [{ productId: String(pCap), quantity: 1 }], tenders: [{ method: "CASH", amount: 400 }] })).sale;
  assert.ok(!(await RET.voidSale({ orgId: ORG, membership: supervisor, actorEmail: supervisor.email, saleId: v.id, reason: "test void" })).error);
  const rr = await ret(supervisor, { saleId: a.id, registerId: register, lines: [{ lineIndex: 0, quantity: 1 }] }); assert.ok(!rr.error, rr.error); // 1180 cash back
  const cm = await SH.cashMove({ orgId: ORG, membership: cashier, actorEmail: cashier.email, shiftId: sh, type: "OUT", amount: 1000, reason: "bank drop" }); assert.equal(cm.code, "COMMERCE_ROLE", "cashiers cannot move cash");
  assert.ok(!(await SH.cashMove({ orgId: ORG, membership: supervisor, actorEmail: supervisor.email, shiftId: sh, type: "IN", amount: 500, reason: "change top-up" })).error);
  assert.ok(!(await SH.cashMove({ orgId: ORG, membership: supervisor, actorEmail: supervisor.email, shiftId: sh, type: "OUT", amount: 2000, reason: "bank drop" })).error);
  const live = (await SH.getShift({ orgId: ORG, membership: cashier, shiftId: sh })).shift;
  assert.equal(live.expected, 5000 + 1180 - 1180 + 500 - 2000, "float + cash sales (voided excluded) - cash refunds + in - out");
  assert.equal(live.report.sales, 2); assert.equal(live.report.voids, 1); assert.equal(live.report.refunds, 1); assert.equal(live.report.byTender.BANK_TRANSFER, 1180);
  const closed = await SH.closeShift({ orgId: ORG, membership: cashier, actorEmail: cashier.email, shiftId: sh, countedCash: 3480, note: "short 20" });
  assert.ok(!closed.error, closed.error); assert.equal(closed.shift.overShort, -20); assert.equal(closed.shift.flagged, true, "tolerance is 10.00");
  const late = await sell(cashier, { registerId: register, lines: [{ productId: String(pShirt), quantity: 1 }], tenders: [{ method: "CASH", amount: 1180 }] }); assert.equal(late.code, "NO_OPEN_SHIFT");
  assert.equal((await SH.listShifts({ orgId: ORG, membership: owner, status: "NEEDS_REVIEW" })).shifts.length, 1);
  const supReview = await SH.reviewShift({ orgId: ORG, membership: supervisor, actorEmail: supervisor.email, shiftId: sh }); assert.equal(supReview.code, "COMMERCE_ROLE");
  const fix = await SH.correctShiftCount({ orgId: ORG, membership: owner, actorEmail: owner.email, shiftId: sh, countedCash: 3500, reason: "20 found under the tray" });
  assert.equal(fix.shift.overShort, 0); assert.equal(fix.shift.flagged, false); assert.equal(fix.shift.corrections.length, 1);
  const rev = await SH.reviewShift({ orgId: ORG, membership: manager2, actorEmail: manager2.email, shiftId: sh, note: "ok" }); assert.ok(!rev.error, rev.error);
  assert.ok(await c.db.collection("org_activity").findOne({ orgId, action: "SHIFT_COUNT_CORRECTED" }));
});

test("tenant isolation: another company cannot see, return or void this company's sales or shifts", { timeout: 60000 }, async () => {
  const s = (await sell(owner, { lines: [{ productId: String(pShirt), quantity: 1 }], tenders: [{ method: "CASH", amount: 1180 }] })).sale;
  const outsider = { role: "owner", email: "boss@other.example" };
  const r = await RET.processReturn({ orgId: String(other), membership: outsider, actorEmail: outsider.email, input: { saleId: s.id, idempotencyKey: key(), reason: "steal", lines: [{ lineIndex: 0, quantity: 1 }] } });
  assert.equal(r.status, 404);
  const v = await RET.voidSale({ orgId: String(other), membership: outsider, actorEmail: outsider.email, saleId: s.id, reason: "steal" }); assert.equal(v.status, 404);
  const o = await SH.openShift({ orgId: String(other), membership: outsider, actorEmail: outsider.email, registerId: register, openingFloat: 0 }); assert.equal(o.status, 404);
});
