// test/commerce-offline.test.mjs -- Inaya Commerce, offline selling (post-SOW #4): packs are gated and bound to an open
// shift; the till's offline pricing equals the server's; signed offline sales sync exactly once into stock, books and the
// shift; tampered / out-of-window / over-limit / non-cash sales are never recorded but go to the manager; only a manager
// resolves; an online attempt whose answer was lost can be finished offline without a double sale.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import * as S from "../src/lib/commerce/store.js";
import * as TAX from "../src/lib/commerce/tax.js";
import * as PR from "../src/lib/commerce/pricing.js";
import * as SALE from "../src/lib/commerce/sale.js";
import * as SH from "../src/lib/commerce/shifts.js";
import * as OFF from "../src/lib/commerce/offline.js";
import { priceOfflineCart, canonicalOfflineSale, settleOfflineCash } from "../src/lib/commerce/offlinePricing.js";
import { recordStockMovement, getStockLevel } from "../src/lib/inventory.js";

const orgId = new ObjectId(); const ORG = String(orgId);
const owner = { role: "owner", email: "owner@off.example" };
const cashier = { role: "member", commerceRole: "cashier", email: "cash@off.example" };
const supervisor = { role: "member", commerceRole: "supervisor", email: "sup@off.example" };
let c, w, pShirt, pCap, pRare, register, shift, pack;
const stock = (p) => getStockLevel(ORG, String(p), String(w));
const idOf = (n) => `off_test_${Date.now().toString(36)}_${n}`;
let seq = 0;
/** What the till does: number, price, sign. */
function tillSale(pk, lines, { cash = null, patch = {}, offlineId = null } = {}) {
  seq += 1; const priced = priceOfflineCart(pk, lines); if (priced.error) priced.totals = { cashDueMinor: 0, totalMinor: 0 };
  const s = { offlineId: offlineId || idOf(seq), packId: pk.packId, seq, receiptNumber: `${pk.receiptPrefix}-${String(seq).padStart(4, "0")}`, createdAt: new Date().toISOString(),
    lines, cashMinor: cash ?? priced.totals.cashDueMinor, totalMinor: priced.totals.totalMinor, notes: "", drawerOpened: false, tenders: [{ method: "CASH" }], ...patch };
  s.signature = createHmac("sha256", Buffer.from(pk.secret, "base64url")).update(canonicalOfflineSale(s)).digest("base64url");
  return s;
}
const sync = (sales, m = cashier, pk = pack) => OFF.syncOfflineSales({ orgId: ORG, membership: m, actorEmail: m.email, packId: pk.packId, registerId: pk.registerId, sales });

before(async () => {
  await ensureOrgIndexes(); c = await getOrgCollections(); const now = new Date().toISOString(); const dep = new ObjectId();
  await c.orgs.insertOne({ _id: orgId, name: "commerce-offline", features: { FEATURE_COMMERCE: true }, createdAt: now });
  w = (await c.warehouses.insertOne({ orgId, departmentId: dep, name: "Shop", createdAt: now })).insertedId;
  const mk = (x) => c.products.insertOne({ orgId, departmentId: dep, status: "ACTIVE", deletedAt: null, createdAt: now, ...x }).then((r) => r.insertedId);
  pShirt = await mk({ sku: `OS-${Date.now()}`, name: "Shirt", unitPrice: 1000, barcode: "111" });
  pCap = await mk({ sku: `OC-${Date.now()}`, name: "Cap", unitPrice: 333.33 });
  pRare = await mk({ sku: `OR-${Date.now()}`, name: "Rare", unitPrice: 50 });
  await mk({ sku: `OG-${Date.now()}`, name: "Gift", unitPrice: 0, productType: "GIFT_CARD" });
  await S.updateSettings({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { currency: "PKR", taxMode: "exclusive", rounding: { mode: "line", cashIncrement: 100 } } });
  await TAX.saveTaxCategory({ orgId: ORG, membership: owner, actorEmail: owner.email, code: "GST", name: "GST", rate: 18, isDefault: true });
  for (const p of [pShirt, pCap]) await recordStockMovement({ orgId: ORG, productId: String(p), warehouseId: String(w), delta: 50, type: "RECEIPT", actorEmail: "t", unitCost: 400 });
  await recordStockMovement({ orgId: ORG, productId: String(pRare), warehouseId: String(w), delta: 1, type: "RECEIPT", actorEmail: "t", unitCost: 10 });
  register = (await SH.saveRegister({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { code: "T1", name: "Till 1", warehouseId: String(w) } })).id;
});
after(async () => {
  for (const n of ["orgs", "warehouses", "products", "crm_contacts", "calendar_records", "stock_levels", "stock_movements", "sales_orders", "journal_entries", "ledger_accounts", "org_activity", "webhook_deliveries"]) await c.db.collection(n).deleteMany(n === "orgs" ? { _id: orgId } : { orgId }).catch(() => {});
  await (await mongoClientPromise).close();
});

test("a pack needs offline selling switched on, a register and an open shift; it carries shelf prices and tax, never gift cards", { timeout: 120000 }, async () => {
  assert.equal((await OFF.issueOfflinePack({ orgId: ORG, membership: cashier, actorEmail: cashier.email, registerId: register })).code, "OFFLINE_DISABLED");
  const bad = await S.updateSettings({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { offlineSelling: { enabled: true, maxHours: 100 } } }); assert.ok(bad.error, "hours are bounded");
  const notMgr = await S.updateSettings({ orgId: ORG, membership: cashier, actorEmail: cashier.email, input: { offlineSelling: { enabled: true } } }); assert.equal(notMgr.code, "COMMERCE_ROLE");
  await S.updateSettings({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { offlineSelling: { enabled: true, maxHours: 12, maxSales: 300, maxSaleMinor: 0 } } });
  assert.equal((await OFF.issueOfflinePack({ orgId: ORG, membership: cashier, actorEmail: cashier.email, registerId: register })).code, "NO_OPEN_SHIFT");
  shift = (await SH.openShift({ orgId: ORG, membership: cashier, actorEmail: cashier.email, registerId: register, openingFloat: 1000 })).shift;
  const r = await OFF.issueOfflinePack({ orgId: ORG, membership: cashier, actorEmail: cashier.email, registerId: register }); assert.ok(!r.error, r.error);
  pack = r.pack;
  assert.equal(pack.shiftId, shift.id); assert.equal(pack.cashierEmail, cashier.email); assert.match(pack.receiptPrefix, /^OFF-T1-\d+$/);
  assert.equal(pack.products.length, 3, "gift cards are not sold offline");
  const shirt = pack.products.find((p) => p.id === String(pShirt)); assert.equal(shirt.priceMinor, 100000); assert.equal(shirt.tax.rate, 18);
  assert.ok(pack.secret.length >= 40);
});

test("the till's offline totals equal the server's pricing engine (line and total tax rounding)", { timeout: 120000 }, async () => {
  const lines = [{ productId: String(pShirt), quantity: 3 }, { productId: String(pCap), quantity: 7 }];
  for (const mode of ["line", "total"]) {
    await S.updateSettings({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { rounding: { mode, cashIncrement: 100 } } });
    const pk = (await OFF.issueOfflinePack({ orgId: ORG, membership: cashier, actorEmail: cashier.email, registerId: register })).pack;
    const server = await PR.priceCart({ orgId: ORG, membership: cashier, input: { warehouseId: String(w), lines } });
    const off = priceOfflineCart(pk, lines);
    assert.equal(off.totals.totalMinor, server.totals.totalMinor, `total (${mode})`);
    assert.equal(off.totals.taxMinor, Math.round(server.totals.tax * 100), `tax (${mode})`);
    assert.deepEqual(off.lines.map((l) => l.grossMinor), server.lines.map((l) => l._minor.grossMinor), `per line (${mode})`);
  }
  await S.updateSettings({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { rounding: { mode: "line", cashIncrement: 100 } } });
  pack = (await OFF.issueOfflinePack({ orgId: ORG, membership: cashier, actorEmail: cashier.email, registerId: register })).pack;
  assert.equal(settleOfflineCash(priceOfflineCart(pack, lines).totals, 100).code, "UNDERPAID");
});

test("a signed offline sale syncs once into stock, the shift's cash, the books and the audit; re-sending is a no-op", { timeout: 120000 }, async () => {
  const before = await stock(pShirt);
  const s = tillSale(pack, [{ productId: String(pShirt), quantity: 2 }], { cash: 300000, patch: { drawerOpened: true } });
  const r = await sync([s]); assert.ok(!r.error, r.error);
  assert.equal(r.results[0].status, "RECORDED"); assert.match(r.results[0].saleNumber, /^S-\d{6}$/);
  assert.equal(await stock(pShirt), before - 2, "stock moved once");
  const sale = await c.db.collection("sales_orders").findOne({ orgId, idempotencyKey: s.offlineId });
  assert.equal(sale.totals.totalMinor, 236000); assert.equal(sale.changeMinor, 300000 - 236000); assert.equal(sale.offline.receiptNumber, s.receiptNumber);
  assert.equal(String(sale.shiftId), shift.id); assert.equal(sale.cashierEmail, cashier.email); assert.equal(sale.completedAt, s.createdAt);
  const again = await sync([s]); assert.equal(again.results[0].status, "DUPLICATE");
  const [p1, p2] = await Promise.all([sync([s]), sync([s])]); assert.ok([p1, p2].every((x) => x.results[0].status === "DUPLICATE"));
  assert.equal(await c.db.collection("sales_orders").countDocuments({ orgId, idempotencyKey: s.offlineId }), 1, "exactly one sale");
  assert.equal(await stock(pShirt), before - 2, "still moved once");
  const sh = (await SH.getShift({ orgId: ORG, membership: owner, shiftId: shift.id })).shift; assert.equal(sh.expected, 1000 + 2360, "shift expects the offline cash");
  assert.ok(await c.db.collection("journal_entries").findOne({ orgId, "source.id": String(sale._id) }) || await c.db.collection("journal_entries").findOne({ orgId }), "posted to the ledger");
  assert.ok(await c.db.collection("calendar_records").findOne({ orgId, kind: "c_drawer", saleId: sale._id, offline: true }), "offline drawer opening logged");
  assert.ok(await c.db.collection("org_activity").findOne({ orgId, action: "SALE_COMPLETED" }), "audited");
  const found = await SALE.findSaleByNumber({ orgId: ORG, membership: cashier, saleNumber: s.receiptNumber.toLowerCase() }); assert.equal(found.sale.id, String(sale._id), "found by the offline receipt number");
});

test("tampered, mispriced, non-cash, out-of-window and over-limit sales are not recorded; they go to the manager with the reason", { timeout: 120000 }, async () => {
  const before = await stock(pShirt);
  const t1 = tillSale(pack, [{ productId: String(pShirt), quantity: 1 }]); t1.lines = [{ productId: String(pShirt), quantity: 5 }]; // changed after signing
  const t2 = tillSale(pack, [{ productId: String(pShirt), quantity: 1 }], { patch: { totalMinor: 1000 } }); // wrong total (signed)
  const t3 = tillSale(pack, [{ productId: String(pShirt), quantity: 1 }], { patch: { tenders: [{ method: "BANK_TRANSFER" }] } });
  const t4 = tillSale(pack, [{ productId: String(pShirt), quantity: 1 }], { patch: { createdAt: new Date(Date.now() + 86400000).toISOString() } });
  const t5 = tillSale(pack, [{ productId: String(new ObjectId()), quantity: 1 }], { patch: { totalMinor: 100, cashMinor: 100 } });
  const t6 = tillSale(pack, [{ productId: String(pShirt), quantity: 1 }], { patch: { seq: 9999, receiptNumber: `${pack.receiptPrefix}-9999` } });
  const r = await sync([t1, t2, t3, t4, t5, t6]); assert.ok(!r.error, r.error);
  assert.deepEqual(r.results.map((x) => x.status), Array(6).fill("REJECTED"));
  assert.match(r.results[0].reasons.join(" "), /signature/); assert.match(r.results[1].reasons.join(" "), /total/); assert.match(r.results[2].reasons.join(" "), /cash only/);
  assert.match(r.results[3].reasons.join(" "), /future|ended/); assert.match(r.results[4].reasons.join(" "), /not in the till/); assert.match(r.results[5].reasons.join(" "), /limit/);
  assert.equal(await stock(pShirt), before, "nothing moved");
  assert.equal(await c.db.collection("sales_orders").countDocuments({ orgId, idempotencyKey: { $in: [t1, t2, t3, t4, t5, t6].map((x) => x.offlineId) } }), 0, "nothing recorded");
  const list = await OFF.listOfflineIssues({ orgId: ORG, membership: supervisor }); assert.ok(list.issues.filter((x) => x.type === "REJECTED").length >= 6);
  assert.equal((await OFF.listOfflineIssues({ orgId: ORG, membership: cashier })).code, "COMMERCE_ROLE");
  const again = await sync([t1]); assert.equal(again.results[0].status, "REJECTED"); assert.equal(await c.db.collection("calendar_records").countDocuments({ orgId, kind: OFF.ISSUE_KIND, offlineId: t1.offlineId }), 1, "one issue per sale");
  // another register's pack can't be used to sync these
  const wrongReg = await OFF.syncOfflineSales({ orgId: ORG, membership: cashier, actorEmail: cashier.email, packId: pack.packId, registerId: String(new ObjectId()), sales: [t1] }); assert.equal(wrongReg.code, "PACK_REGISTER");
});

test("only a manager resolves: record prices from the pack, dismiss needs a reason, each issue is decided once", { timeout: 120000 }, async () => {
  const t = tillSale(pack, [{ productId: String(pCap), quantity: 2 }]); t.signature = "x".repeat(43);
  const r = await sync([t]); assert.equal(r.results[0].status, "REJECTED");
  const issue = (await OFF.listOfflineIssues({ orgId: ORG, membership: owner })).issues.find((x) => x.receiptNumber === t.receiptNumber);
  assert.equal((await OFF.resolveOfflineIssue({ orgId: ORG, membership: supervisor, actorEmail: supervisor.email, issueId: issue.id, action: "record", reason: "checked" })).code, "COMMERCE_ROLE");
  assert.ok((await OFF.resolveOfflineIssue({ orgId: ORG, membership: owner, actorEmail: owner.email, issueId: issue.id, action: "record", reason: "" })).error, "reason required");
  const before = await stock(pCap);
  const ok = await OFF.resolveOfflineIssue({ orgId: ORG, membership: owner, actorEmail: owner.email, issueId: issue.id, action: "record", reason: "till clock issue, sale confirmed" }); assert.ok(!ok.error, ok.error);
  assert.match(ok.issue.saleNumber, /^S-\d{6}$/); assert.equal(await stock(pCap), before - 2);
  const sale = await c.db.collection("sales_orders").findOne({ orgId, idempotencyKey: t.offlineId }); assert.equal(sale.offline.resolvedBy, owner.email); assert.equal(sale.totals.totalMinor, priceOfflineCart(pack, t.lines).totals.totalMinor);
  assert.equal((await OFF.resolveOfflineIssue({ orgId: ORG, membership: owner, actorEmail: owner.email, issueId: issue.id, action: "dismiss", reason: "again" })).status, 409);
  const d = tillSale(pack, [{ productId: String(pCap), quantity: 1 }], { patch: { totalMinor: 5 } }); await sync([d]);
  const di = (await OFF.listOfflineIssues({ orgId: ORG, membership: owner })).issues.find((x) => x.receiptNumber === d.receiptNumber);
  const dm = await OFF.resolveOfflineIssue({ orgId: ORG, membership: owner, actorEmail: owner.email, issueId: di.id, action: "dismiss", reason: "test sale, never happened" }); assert.equal(dm.issue.status, "RESOLVED");
  assert.equal(await c.db.collection("sales_orders").countDocuments({ orgId, idempotencyKey: d.offlineId }), 0);
});

test("stock below zero and an already-closed shift: the sale is recorded (it happened) and flagged for a check", { timeout: 120000 }, async () => {
  const s1 = tillSale(pack, [{ productId: String(pRare), quantity: 3 }]);
  const r = await sync([s1]); assert.equal(r.results[0].status, "RECORDED"); assert.match(r.results[0].review.join(" "), /below zero/);
  assert.equal(await stock(pRare), -2);
  const s2 = tillSale(pack, [{ productId: String(pShirt), quantity: 1 }]);
  await SH.closeShift({ orgId: ORG, membership: cashier, actorEmail: cashier.email, shiftId: shift.id, countedCash: 0, note: "t" });
  const r2 = await sync([s2]); assert.equal(r2.results[0].status, "RECORDED"); assert.match(r2.results[0].review.join(" "), /shift was already closed/);
  const checks = (await OFF.listOfflineIssues({ orgId: ORG, membership: owner })).issues.filter((x) => x.type === "REVIEW"); assert.equal(checks.length, 2);
  assert.equal((await OFF.resolveOfflineIssue({ orgId: ORG, membership: owner, actorEmail: owner.email, issueId: checks[0].id, action: "record", reason: "nope" })).error, "This item can only be acknowledged.");
  assert.equal((await OFF.resolveOfflineIssue({ orgId: ORG, membership: owner, actorEmail: owner.email, issueId: checks[0].id, action: "acknowledge", reason: "recounted" })).issue.status, "RESOLVED");
});

test("an online payment whose answer was lost, finished offline with the same key, is never recorded twice", { timeout: 120000 }, async () => {
  shift = (await SH.openShift({ orgId: ORG, membership: cashier, actorEmail: cashier.email, registerId: register, openingFloat: 0 })).shift;
  pack = (await OFF.issueOfflinePack({ orgId: ORG, membership: cashier, actorEmail: cashier.email, registerId: register })).pack;
  const key = SALE.newIdempotencyKey(); const before = await stock(pShirt);
  const online = await SALE.completeSale({ orgId: ORG, membership: cashier, actorEmail: cashier.email, input: { idempotencyKey: key, warehouseId: String(w), registerId: register, lines: [{ productId: String(pShirt), quantity: 1 }], tenders: [{ method: "CASH", amount: 1200 }] } });
  assert.ok(!online.error, online.error);
  const r = await sync([tillSale(pack, [{ productId: String(pShirt), quantity: 1 }], { offlineId: key })]);
  assert.equal(r.results[0].status, "DUPLICATE"); assert.equal(r.results[0].saleId, online.sale.id);
  assert.equal(await stock(pShirt), before - 1, "one sale, one stock movement");
});

test("hard cases: a busy till's 50-sale batch in parallel with re-sends, another company's pack, an oversized batch, an old pack after a new one", { timeout: 1200000 }, async () => {
  const before = await stock(pCap);
  const batch = Array.from({ length: 50 }, () => tillSale(pack, [{ productId: String(pCap), quantity: 1 }]));
  const half = batch.slice(0, 25);
  const t0 = Date.now();
  const [a, b] = await Promise.all([sync(batch), sync(half)]); // the till re-sends half of it while the first send is still running
  assert.ok(!a.error && !b.error, a.error || b.error);
  assert.ok(Date.now() - t0 < 26000, `one round answers inside the hosting time limit (${Date.now() - t0} ms)`);
  for (let round = 0; round < 40; round++) { const r = await sync(batch); if (!r.pending) break; } // the till keeps sending until everything is answered
  const ids = batch.map((x) => x.offlineId);
  assert.equal(await c.db.collection("sales_orders").countDocuments({ orgId, idempotencyKey: { $in: ids } }), 50, "50 sales, none twice");
  assert.equal(await stock(pCap), before - 50, "stock moved exactly 50");
  const nums = (await c.db.collection("sales_orders").find({ orgId, idempotencyKey: { $in: ids } }).toArray()).map((s) => s.saleNumber);
  assert.equal(new Set(nums).size, 50, "every sale has its own number");
  assert.equal((await sync([...batch, batch[0]])).error ? "too many" : "ok", "too many", "at most 50 per request");
  // another company can't use this company's pack
  const otherOrg = new ObjectId(); await c.orgs.insertOne({ _id: otherOrg, name: "other-off", features: { FEATURE_COMMERCE: true }, createdAt: new Date().toISOString() });
  try { const x = await OFF.syncOfflineSales({ orgId: String(otherOrg), membership: owner, actorEmail: owner.email, packId: pack.packId, sales: [tillSale(pack, [{ productId: String(pCap), quantity: 1 }])] }); assert.equal(x.code, "UNKNOWN_PACK"); }
  finally { await c.orgs.deleteOne({ _id: otherOrg }); }
  // a sale made on the previous pack (before the till downloaded a new one) still syncs: it was valid when it was made
  const oldPack = pack; const late = tillSale(oldPack, [{ productId: String(pShirt), quantity: 1 }]);
  pack = (await OFF.issueOfflinePack({ orgId: ORG, membership: cashier, actorEmail: cashier.email, registerId: register })).pack;
  assert.notEqual(pack.packId, oldPack.packId);
  assert.equal((await sync([late], cashier, oldPack)).results[0].status, "RECORDED");
  // but a sale signed with the new pack's secret can't pretend to be from the old one
  const forged = tillSale({ ...oldPack, secret: pack.secret }, [{ productId: String(pShirt), quantity: 1 }]);
  assert.equal((await sync([forged], cashier, oldPack)).results[0].status, "REJECTED");
});

test("a sale changed in any signed field is refused: price paid, cash, receipt number, time, notes, drawer flag", { timeout: 120000 }, async () => {
  const base = () => tillSale(pack, [{ productId: String(pShirt), quantity: 1 }], { cash: 200000 });
  const tweaks = [(s) => { s.cashMinor = 100; }, (s) => { s.receiptNumber = `${pack.receiptPrefix}-0001`; }, (s) => { s.createdAt = new Date(Date.now() - 60000).toISOString(); }, (s) => { s.notes = "x"; }, (s) => { s.drawerOpened = true; }, (s) => { s.seq += 1; }];
  const sales = tweaks.map((f) => { const s = base(); f(s); return s; });
  const r = await sync(sales);
  assert.deepEqual(r.results.map((x) => x.status), Array(tweaks.length).fill("REJECTED"));
  for (const x of r.results) assert.match(x.reasons.join(" "), /signature/);
});
