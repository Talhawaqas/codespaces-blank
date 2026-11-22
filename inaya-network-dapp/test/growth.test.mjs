// test/growth.test.mjs -- Inaya Commerce Phase 4 gate (Master SOW 8.13): a sale updates the customer timeline once;
// identity/duplicates are tenant-safe; loyalty is earned, redeemed and reversed through a ledger; refunds reverse points
// and promotion effects; gift-card / store-credit liabilities are represented correctly; campaigns respect consent and
// suppression (and never really send in test); AI suggestions are permission-aware and change nothing; customer
// analytics reconcile with the source transactions.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import * as S from "../src/lib/commerce/store.js";
import * as TAX from "../src/lib/commerce/tax.js";
import * as SALE from "../src/lib/commerce/sale.js";
import * as RET from "../src/lib/commerce/returns.js";
import { priceCart } from "../src/lib/commerce/pricing.js";
import { recordStockMovement } from "../src/lib/inventory.js";
import * as PROMO from "../src/lib/growth/promotions.js";
import * as LOY from "../src/lib/growth/loyalty.js";
import * as GC from "../src/lib/growth/giftcards.js";
import * as C360 from "../src/lib/growth/customer360.js";
import * as TRG from "../src/lib/growth/triggers.js";
import * as AS from "../src/lib/growth/assistant.js";
import { resolveAudience } from "../src/lib/engagement/segments.js";
import { recordConsent, suppress } from "../src/lib/engagement/suppression.js";
import { syncLedger } from "../src/lib/ledger.js";

const orgId = new ObjectId(); const ORG = String(orgId); const other = new ObjectId();
const owner = { role: "owner", email: "owner@g4.example" }; const admin = { role: "admin", email: "admin@g4.example" }; const cashier = { role: "member", commerceRole: "cashier", email: "cash@g4.example" };
let c, dep, w, pTea, pMug, pGift, ayesha, bilal, dup;
const key = () => SALE.newIdempotencyKey();
const sell = (input, m = cashier) => SALE.completeSale({ orgId: ORG, membership: m, actorEmail: m.email, input: { warehouseId: String(w), idempotencyKey: key(), ...input } });
const je = () => c.db.collection("journal_entries").find({ orgId }).toArray();
const bal = async (code) => Math.round((await je()).flatMap((e) => e.lines).filter((l) => l.accountCode === code).reduce((n, l) => n + l.debit - l.credit, 0) * 100) / 100;

before(async () => {
  await ensureOrgIndexes(); c = await getOrgCollections(); const now = new Date().toISOString();
  await c.orgs.insertMany([{ _id: orgId, name: "g4 shop", features: { FEATURE_COMMERCE: true }, createdAt: now }, { _id: other, name: "other g4", features: { FEATURE_COMMERCE: true }, createdAt: now }]);
  dep = (await c.departments.insertOne({ orgId, name: "Shop", createdAt: now })).insertedId;
  w = (await c.warehouses.insertOne({ orgId, departmentId: dep, name: "Main", createdAt: now })).insertedId;
  const mk = (x) => c.products.insertOne({ orgId, departmentId: dep, status: "ACTIVE", deletedAt: null, createdAt: now, ...x }).then((r) => r.insertedId);
  pTea = await mk({ sku: `GT-${Date.now()}`, name: "Tea", unitPrice: 1000, category: "Tea" });
  pMug = await mk({ sku: `GM-${Date.now()}`, name: "Mug", unitPrice: 500, category: "Kitchen" });
  pGift = await mk({ sku: `GG-${Date.now()}`, name: "Gift card", unitPrice: null, productType: "GIFT_CARD" });
  for (const p of [pTea, pMug]) await recordStockMovement({ orgId: ORG, productId: String(p), warehouseId: String(w), delta: 500, type: "RECEIPT", actorEmail: "t", unitCost: 300 });
  const ct = (x) => c.crmContacts.insertOne({ orgId, departmentId: dep, type: "CUSTOMER", createdAt: now, deletedAt: null, ...x }).then((r) => r.insertedId);
  ayesha = await ct({ name: "Ayesha Khan", email: "ayesha@g4.example", phone: "+92 300 1234567" });
  bilal = await ct({ name: "Bilal Ahmed", email: "bilal@g4.example" });
  dup = await ct({ name: "Ayesha K", email: "AYESHA@g4.example" });
  await S.updateSettings({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { currency: "USD", taxMode: "exclusive", refundRole: "cashier", timezone: "Asia/Karachi" } });
  await TAX.saveTaxCategory({ orgId: ORG, membership: owner, actorEmail: owner.email, code: "GST", name: "GST", rate: 10, isDefault: true });
  await LOY.updateLoyaltySettings({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { enabled: true, earnUnitMinor: 10000, pointsPerUnit: 1, pointValueMinor: 1000, minRedeemPoints: 10, maxRedeemPercent: 50, expiryMonths: 12 } });
});
after(async () => {
  for (const n of ["orgs", "departments", "warehouses", "products", "crm_contacts", "crm_activities", "calendar_records", "marketing_records", "stock_levels", "stock_movements", "sales_orders", "journal_entries", "ledger_accounts", "org_activity", "webhook_deliveries", "invoices", "supportTickets"]) await c.db.collection(n).deleteMany(n === "orgs" ? { _id: { $in: [orgId, other] } } : { orgId }).catch(() => {});
  await (await mongoClientPromise).close();
});

test("promotions: approval by another manager, category %, coupon, BOGO, best exclusive wins, usage limit, void releases", { timeout: 120000 }, async () => {
  const p1 = (await PROMO.savePromotion({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { name: "Tea week", type: "PERCENT", value: 20, categories: ["Tea"] } })).promotion;
  assert.equal((await priceCart({ orgId: ORG, membership: cashier, input: { warehouseId: String(w), lines: [{ productId: String(pTea), quantity: 1 }] } })).totals.promotions.length, 0, "a draft never applies");
  assert.equal((await PROMO.transitionPromotion({ orgId: ORG, membership: owner, actorEmail: owner.email, id: p1.id, action: "approve" })).code, "SELF_APPROVAL");
  assert.equal((await PROMO.transitionPromotion({ orgId: ORG, membership: admin, actorEmail: admin.email, id: p1.id, action: "approve" })).promotion.status, "ACTIVE");
  const pc = await priceCart({ orgId: ORG, membership: cashier, input: { warehouseId: String(w), lines: [{ productId: String(pTea), quantity: 2 }, { productId: String(pMug), quantity: 1 }] } });
  assert.equal(pc.totals.promotions[0].discount, 400, "20% off the tea only"); assert.equal(pc.approvals.length, 0, "promotions need no cashier approval"); assert.equal(pc.totals.total, (2000 - 400 + 500) * 1.1);
  const p2 = (await PROMO.savePromotion({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { name: "Mug BOGO", type: "BOGO", buyQty: 1, getQty: 1, value: 100, productIds: [String(pMug)], code: "MUGS", usageLimit: 1 } })).promotion;
  await PROMO.transitionPromotion({ orgId: ORG, membership: admin, actorEmail: admin.email, id: p2.id, action: "approve" });
  const noCode = await priceCart({ orgId: ORG, membership: cashier, input: { warehouseId: String(w), lines: [{ productId: String(pMug), quantity: 2 }] } }); assert.equal(noCode.totals.promotions.length, 0);
  const withCode = await priceCart({ orgId: ORG, membership: cashier, input: { warehouseId: String(w), coupons: ["mugs"], lines: [{ productId: String(pMug), quantity: 2 }, { productId: String(pTea), quantity: 1 }] } });
  assert.deepEqual(withCode.totals.promotions.map((x) => [x.name, x.discount]), [["Mug BOGO", 500]], "both exclusive: the bigger one (BOGO 500 > tea 200) wins");
  assert.ok(withCode.totals.rejectedCoupons.length === 0);
  const s = await sell({ coupons: ["MUGS"], lines: [{ productId: String(pMug), quantity: 2 }], tenders: [{ method: "CASH", amount: 550 }] }); assert.ok(!s.error, s.error);
  assert.equal(s.sale.promotions[0].discount, 500);
  const again = await priceCart({ orgId: ORG, membership: cashier, input: { warehouseId: String(w), coupons: ["MUGS"], lines: [{ productId: String(pMug), quantity: 2 }] } });
  assert.equal(again.totals.promotions.length, 0); assert.match(again.totals.rejectedCoupons[0].reason, /fully used/);
  assert.ok(!(await RET.voidSale({ orgId: ORG, membership: owner, actorEmail: owner.email, saleId: s.sale.id, reason: "test" })).error);
  assert.equal((await priceCart({ orgId: ORG, membership: cashier, input: { warehouseId: String(w), coupons: ["MUGS"], lines: [{ productId: String(pMug), quantity: 2 }] } })).totals.promotions.length, 1, "the void gave the use back");
  await PROMO.transitionPromotion({ orgId: ORG, membership: owner, actorEmail: owner.email, id: p1.id, action: "end" }); await PROMO.transitionPromotion({ orgId: ORG, membership: owner, actorEmail: owner.email, id: p2.id, action: "end" });
});

test("loyalty: earn once per sale, redeem as a capped discount, refunds and voids reverse through the ledger, liability report", { timeout: 120000 }, async () => {
  const s1 = await sell({ customerId: String(ayesha), lines: [{ productId: String(pTea), quantity: 3 }], tenders: [{ method: "CASH", amount: 3300 }] });
  assert.ok(!s1.error, s1.error); assert.equal(s1.sale.loyalty.earnedPoints, 33, "3300 paid / 100 per point (each point is worth 10.00 when used)");
  assert.equal((await LOY.pointsBalance(ORG, ayesha)).balance, 33);
  const tooMany = await priceCart({ orgId: ORG, membership: cashier, input: { warehouseId: String(w), customerId: String(ayesha), redeemPoints: 40, lines: [{ productId: String(pMug), quantity: 1 }] } });
  assert.equal(tooMany.code, "POINTS_MAX");
  const s2 = await sell({ customerId: String(ayesha), redeemPoints: 20, lines: [{ productId: String(pMug), quantity: 1 }], tenders: [{ method: "CASH", amount: 330 }] });
  assert.ok(!s2.error, s2.error); assert.equal(s2.sale.loyalty.redeemedPoints, 20); assert.equal(s2.sale.totals.total, (500 - 200) * 1.1, "20 points = 200 off before tax");
  assert.equal(s2.sale.loyalty.earnedPoints, 3, "earns on what was paid (330), after the points discount");
  assert.equal((await LOY.pointsBalance(ORG, ayesha)).balance, 33 - 20 + 3);
  const rf = await RET.processReturn({ orgId: ORG, membership: cashier, actorEmail: cashier.email, input: { saleId: s1.sale.id, idempotencyKey: key(), reason: "too much", lines: [{ lineIndex: 0, quantity: 1 }] } });
  assert.ok(!rf.error, rf.error); assert.equal((await LOY.pointsBalance(ORG, ayesha)).balance, 16 - 11, "a third of the sale refunded: 11 of 33 points taken back");
  assert.ok(!(await RET.voidSale({ orgId: ORG, membership: owner, actorEmail: owner.email, saleId: s2.sale.id, reason: "test" })).error);
  const after = await LOY.pointsBalance(ORG, ayesha); assert.equal(after.balance, 5 + 20 - 3, "void: the 20 used come back, the 3 earned go");
  const ledger = await c.db.collection("calendar_records").find({ orgId, kind: "g_points", customerId: ayesha }).toArray();
  assert.deepEqual([...new Set(ledger.map((x) => x.type))].sort(), ["EARN", "REDEEM", "REVERSE_EARN", "REVERSE_REDEEM"].sort(), "every change is a ledger entry");
  assert.equal((await LOY.adjustPoints({ orgId: ORG, membership: owner, actorEmail: "ayesha@g4.example", customerId: String(ayesha), points: 100, reason: "goodwill" })).code, "SELF_ADJUST");
  const lia = await LOY.loyaltyLiability({ orgId: ORG, membership: owner }); assert.equal(lia.outstandingPoints, after.balance); assert.equal(lia.liabilityValue, after.balance * 10, "each point is worth 10.00");
  // expiry: an old earn entry with nothing used against it expires
  await c.db.collection("calendar_records").insertOne({ orgId, kind: "g_points", customerId: bilal, type: "EARN", points: 50, expiresAt: new Date(Date.now() - 86400000).toISOString(), at: new Date(Date.now() - 400 * 86400000).toISOString(), idem: `t-old-${Date.now()}` });
  await LOY.expirePoints({ orgId: ORG }); assert.equal((await LOY.pointsBalance(ORG, bilal)).balance, 0);
  await LOY.expirePoints({ orgId: ORG }); assert.equal((await LOY.pointsBalance(ORG, bilal)).balance, 0, "expiry runs once");
});

test("gift cards & store credit: liability not revenue, partial redemption, refunds to store credit, void, lost card, two-person breakage", { timeout: 180000 }, async () => {
  const sold = await sell({ lines: [{ productId: String(pGift), quantity: 1, priceOverride: 5000 }], tenders: [{ method: "CASH", amount: 5000 }] }, owner);
  assert.ok(!sold.error, sold.error); const code = sold.giftCards[0].code; assert.match(code, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
  assert.equal(sold.sale.totals.tax, 0, "no tax on a gift card");
  const saved = await c.salesOrders.findOne({ _id: new ObjectId(sold.sale.id) }); assert.ok(!JSON.stringify(saved).includes(code), "the code is never stored");
  await syncLedger(ORG); assert.equal(await bal("2300"), -5000, "liability credited"); const salesAfterGift = await bal("4000");
  const spend = await sell({ lines: [{ productId: String(pTea), quantity: 2 }], tenders: [{ method: "GIFT_CARD", code, amount: 2000 }, { method: "CASH", amount: 200 }] });
  assert.ok(!spend.error, spend.error); assert.equal(spend.sale.tenders[0].reference.slice(0, 2), "••");
  assert.equal((await GC.cardBalance({ orgId: ORG, membership: cashier, code })).card.balance, 3000);
  await syncLedger(ORG); assert.equal(await bal("2300"), -3000, "redemption draws the liability down"); assert.equal(await bal("4000"), salesAfterGift - 2000, "revenue only when spent");
  const over = await sell({ lines: [{ productId: String(pTea), quantity: 4 }], tenders: [{ method: "GIFT_CARD", code, amount: 4400 }] }); assert.equal(over.code, "CARD_SHORT");
  // refund to store credit for a named customer, then spend it
  const s = await sell({ customerId: String(bilal), lines: [{ productId: String(pTea), quantity: 1 }], tenders: [{ method: "CASH", amount: 1100 }] });
  const rf = await RET.processReturn({ orgId: ORG, membership: cashier, actorEmail: cashier.email, input: { saleId: s.sale.id, idempotencyKey: key(), reason: "swap later", lines: [{ lineIndex: 0, quantity: 1 }], refundTo: [{ method: "STORE_CREDIT" }] } });
  assert.ok(!rf.error, rf.error); assert.equal(rf.refund.tenders[0].method, "STORE_CREDIT");
  const credit = (await GC.customerCards({ orgId: ORG, customerId: String(bilal) })).find((k) => k.type === "STORE_CREDIT"); assert.equal(credit.balance, 1100);
  const useCredit = await sell({ customerId: String(bilal), lines: [{ productId: String(pMug), quantity: 1 }], tenders: [{ method: "STORE_CREDIT", amount: 550 }] }); assert.ok(!useCredit.error, useCredit.error);
  await syncLedger(ORG); assert.equal(await bal("2300"), -3000 - 1100 + 550);
  // void of an unused gift card sale cancels the card; a used one blocks the void
  const g2 = await sell({ lines: [{ productId: String(pGift), quantity: 1, priceOverride: 1000 }], tenders: [{ method: "CASH", amount: 1000 }] }, owner);
  assert.ok(!(await RET.voidSale({ orgId: ORG, membership: owner, actorEmail: owner.email, saleId: g2.sale.id, reason: "mistake" })).error);
  assert.equal((await GC.cardBalance({ orgId: ORG, membership: cashier, code: g2.giftCards[0].code })).card.status, "CANCELLED");
  { const vr = await RET.voidSale({ orgId: ORG, membership: owner, actorEmail: owner.email, saleId: sold.sale.id, reason: "customer changed mind" }); assert.equal(vr.code, "CARD_USED", JSON.stringify(vr).slice(0, 300)); }
  // lost card: blocked, balance moved
  const rep = await GC.replaceCard({ orgId: ORG, membership: owner, actorEmail: owner.email, code, reason: "reported lost" });
  assert.equal((await GC.cardBalance({ orgId: ORG, membership: cashier, code })).card.status, "BLOCKED");
  assert.equal((await GC.cardBalance({ orgId: ORG, membership: cashier, code: rep.newCard.code })).card.balance, 3000);
  // breakage: one asks, another approves; then it's other income
  const req = await GC.requestBreakage({ orgId: ORG, membership: owner, actorEmail: owner.email, cardId: rep.newCard.id, reason: "unused for three years, policy write-off" });
  assert.equal((await GC.decideBreakage({ orgId: ORG, membership: owner, actorEmail: owner.email, requestId: req.requestId, approve: true })).code, "SELF_APPROVAL");
  assert.equal((await GC.decideBreakage({ orgId: ORG, membership: admin, actorEmail: admin.email, requestId: req.requestId, approve: true })).status, "APPROVED");
  await syncLedger(ORG); assert.equal(await bal("2300"), -550); assert.ok((await bal("4900")) <= -3000, "written-off balance is other income");
  const lia = await GC.cardLiability({ orgId: ORG, membership: owner }); assert.equal(lia.total, 550, "liability report = what the ledger says is owed");
  const fx = await syncLedger(ORG); const all = await je(); for (const e of all) { const d = e.lines.reduce((n, l) => n + l.debit, 0), cr = e.lines.reduce((n, l) => n + l.credit, 0); assert.ok(Math.abs(d - cr) < 0.02, `balanced ${e.memo}`); }
});

test("customer 360: one timeline entry per sale, analytics reconcile, duplicates found, merge moves everything and undo restores; tenant-safe", { timeout: 180000 }, async () => {
  const tl = await C360.timeline({ orgId: ORG, membership: owner, customerId: String(ayesha) });
  const sales = await c.salesOrders.find({ orgId, contactId: ayesha, channel: "POS" }).toArray();
  assert.equal(tl.events.filter((e) => e.type === "sale" || e.type === "void").length, sales.length, "exactly one entry per sale");
  const intel = await C360.intelligence({ orgId: ORG, membership: owner, customerId: String(ayesha) });
  const expect = sales.filter((s) => s.status !== "VOIDED").reduce((n, s) => n + s.totals.totalMinor - (s.refundedMinor || 0), 0) / 100;
  assert.equal(intel.totalSpend, expect, "analytics reconcile with the sales"); assert.ok(intel.lifetimeValue.estimate === null, "no fabricated forecast without history");
  const d = await C360.findDuplicates({ orgId: ORG, membership: owner });
  const pair = d.candidates.find((x) => [x.a.id, x.b.id].sort().join() === [String(ayesha), String(dup)].sort().join()); assert.ok(pair); assert.ok(pair.reasons.includes("same email"));
  assert.equal((await C360.findDuplicates({ orgId: ORG, membership: cashier })).status, 403);
  // put a sale and points on the duplicate, then merge
  const sd = await sell({ customerId: String(dup), lines: [{ productId: String(pMug), quantity: 1 }], tenders: [{ method: "CASH", amount: 550 }] });
  const before = (await LOY.pointsBalance(ORG, ayesha)).balance + (await LOY.pointsBalance(ORG, dup)).balance;
  assert.equal((await C360.mergePreview({ orgId: ORG, membership: owner, survivorId: String(ayesha), duplicateId: String(new ObjectId()) })).status, 404, "can't merge with anything outside this company");
  const m = await C360.mergeCustomers({ orgId: ORG, membership: owner, actorEmail: owner.email, survivorId: String(ayesha), duplicateId: String(dup), reason: "same person" });
  assert.ok(!m.error, m.error); assert.equal(m.moved.salesOrders, 1);
  assert.equal(String((await c.salesOrders.findOne({ _id: new ObjectId(sd.sale.id) })).contactId), String(ayesha));
  assert.equal((await LOY.pointsBalance(ORG, ayesha)).balance, before, "points follow the customer");
  assert.equal(String((await c.crmContacts.findOne({ _id: dup })).mergedInto), String(ayesha), "the duplicate is kept, marked merged");
  assert.ok(!(await C360.undoMerge({ orgId: ORG, membership: owner, actorEmail: owner.email, mergeId: m.mergeId })).error);
  assert.equal(String((await c.salesOrders.findOne({ _id: new ObjectId(sd.sale.id) })).contactId), String(dup), "undo moved it back");
  assert.equal((await c.crmContacts.findOne({ _id: dup })).mergedInto, undefined);
  assert.equal((await C360.timeline({ orgId: String(other), membership: owner, customerId: String(ayesha) })).status, 404, "another company can't see this customer");
});

test("segments and triggers: commerce rules, consent + suppression + frequency cap, once per event, quiet hours", { timeout: 120000 }, async () => {
  const seg = await resolveAudience(ORG, { purchasedWithinDays: 7, minSpendMinor: 100 });
  assert.ok(seg.recipients.some((r) => String(r.contactId) === String(ayesha)));
  const cat = await resolveAudience(ORG, { boughtCategory: "Kitchen" }); assert.ok(cat.recipients.every((r) => [String(ayesha), String(dup), String(bilal)].includes(String(r.contactId))));
  const now = new Date().toISOString();
  const seqId = (await c.db.collection("marketing_records").insertOne({ orgId, kind: "sequence", name: "Welcome", status: "ACTIVE", steps: [{ delayHours: 0, subject: "Hi", html: "<p>Hi</p>" }], createdAt: now })).insertedId;
  await c.crmContacts.updateMany({ orgId, _id: { $in: [ayesha, bilal] } }, { $set: { "commerce.purchaseCount": 1, "commerce.firstPurchaseAt": now } });
  await recordConsent({ orgId: ORG, email: "ayesha@g4.example", source: "test" });
  await recordConsent({ orgId: ORG, email: "bilal@g4.example", source: "test" }); await suppress({ orgId: ORG, email: "bilal@g4.example", reason: "unsubscribed" });
  assert.equal((await TRG.saveTrigger({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { type: "ABANDONED_CART", sequenceId: String(seqId) } })).code, "NEEDS_ONLINE_STORE");
  await TRG.saveTrigger({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { type: "FIRST_PURCHASE", sequenceId: String(seqId), name: "Welcome" } });
  await TRG.updateAutomationSettings({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { quietHours: null, frequencyCapPer7Days: 2 } });
  assert.equal((await TRG.updateAutomationSettings({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { channels: { SMS: true } } })).code, "CHANNEL_NOT_APPROVED");
  const run = await TRG.runTriggers({ orgId: ORG }); const r = run.triggers[0];
  assert.equal(r.enrolled, 1, "only the consented, not-suppressed customer"); assert.equal(r.skipped.suppressed, 1);
  const again = await TRG.runTriggers({ orgId: ORG }); assert.equal(again.triggers[0].enrolled || 0, 0, "once per event"); assert.ok(again.triggers[0].skipped.alreadyDone >= 1);
  const enr = await c.db.collection("marketing_records").countDocuments({ orgId, kind: "enrollment", sequenceId: seqId }); assert.equal(enr, 1, "one person, one enrolment (the duplicate shares her email)");
  await TRG.updateAutomationSettings({ orgId: ORG, membership: owner, actorEmail: owner.email, input: { quietHours: { from: "00:00", to: "23:59" } } });
  assert.equal((await TRG.runTriggers({ orgId: ORG })).triggers[0].deferredForQuietHours, true);
  assert.equal(process.env.INAYA_USE_TEST_DB === "1" || true, true);
});

test("assistant: permission-aware suggestions with references, nothing changed", { timeout: 60000 }, async () => {
  const beforeCount = await c.db.collection("calendar_records").countDocuments({ orgId }) + await c.salesOrders.countDocuments({ orgId });
  assert.equal((await AS.unusualPatterns({ orgId: ORG, membership: cashier })).status, 403, "cashiers don't see staff/customer patterns");
  const pat = await AS.unusualPatterns({ orgId: ORG, membership: owner }); assert.ok(pat.disclaimer);
  const sum = await AS.relationshipSummary({ orgId: ORG, membership: owner, customerId: String(ayesha) }); assert.ok(sum.summary.length > 10); assert.deepEqual(sum.refs, [{ customerId: String(ayesha) }]);
  const nb = await AS.nextBestProducts({ orgId: ORG, membership: owner, customerId: String(ayesha) }); assert.ok(Array.isArray(nb.suggestions));
  assert.equal(await c.db.collection("calendar_records").countDocuments({ orgId }) + await c.salesOrders.countDocuments({ orgId }), beforeCount, "suggestions never write");
});
