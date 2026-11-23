// src/lib/commerce/offline.js -- Inaya Commerce, offline selling (post-SOW #4).
//
// How it stays safe and accurate:
//  1. A manager switches offline selling on (commerce settings `offlineSelling`). Off by default.
//  2. While online, each till with an OPEN shift downloads an "offline pack" (issueOfflinePack): its products, shelf prices
//     and tax rates, the company's tax/rounding settings, a receipt-number prefix, limits (hours, number of sales, largest
//     sale) and a random per-pack secret. The pack is bound to the till, the shift and the cashier who downloaded it.
//  3. Offline, the till sells at those shelf prices, CASH ONLY, no discounts / customers / gift cards / loyalty. Each sale gets
//     a unique offline id, a per-pack sequence number (OFF-<till>-<pack>-<seq> receipt number) and an HMAC-SHA256 signature
//     with the pack secret. The queue is kept encrypted on the device (offlineStore.js).
//  4. Back online, the till sends the queue (syncOfflineSales). Every sale is checked again on the server: signature, pack
//     window and limits, cash only, products in the pack, and the totals re-computed from the SERVER's copy of the pack with
//     the same pricing code (offlinePricing.js). A sale that passes is recorded exactly like a till sale (stock, books,
//     shift cash, audit, events) at the prices actually charged. Anything that fails is NOT recorded: it goes to the manager
//     (Offline review) with the reason. Re-sending is safe: the offline id is the sale's idempotency key.
//  5. A recorded sale that needs a second look (its shift had already closed, or stock went below zero) is recorded and
//     ALSO listed for review.
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { ccol, ensureCommerceIndexes, fail, clean, nowIso, oid, sid, commerceAccess, commerceRoleOf, getSettings, nextNumber, audit, correlationId as newCorrelation } from "./store.js";
import { loadTaxResolver } from "./tax.js";
import { priceOfflineCart, settleOfflineCash, canonicalOfflineSale, OFFLINE_ID_RE } from "./offlinePricing.js";
import { withStockTransaction, recordStockMovement, StockError } from "../inventory.js";
import { stockLegs } from "./catalogue.js";
import { getOrgCollections } from "../orgs.js";
import { afterSale, saleView } from "./sale.js";

export const PACK_KIND = "c_offline_pack"; export const ISSUE_KIND = "c_offline_issue";
const SKEW_MS = 5 * 60 * 1000; // allowed clock difference between till and server
const MAX_PACK_PRODUCTS = 5000; const MAX_SYNC_BATCH = 50;
const SYNC_BUDGET_MS = 12000; // stop well inside the hosting time limit; sales not answered stay queued and come next time

export const DEFAULT_OFFLINE = { enabled: false, maxHours: 12, maxSales: 300, maxSaleMinor: 0 }; // maxSaleMinor 0 = no limit (validated in store.js validateSettings)
export function offlineSettingsOf(settings) { return { ...DEFAULT_OFFLINE, ...(settings?.offlineSelling || {}) }; }

const hmac = (secret, s) => createHmac("sha256", Buffer.from(secret, "base64url")).update(s).digest("base64url");
function sigOk(secret, s, sig) {
  if (typeof sig !== "string" || sig.length > 100) return false;
  const a = Buffer.from(hmac(secret, s)); const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}
let idxReady = null;
async function ensureOfflineIndexes() {
  await ensureCommerceIndexes(); if (idxReady) return idxReady;
  idxReady = (async () => { const c = await ccol(); await Promise.all([
    c.createIndex({ orgId: 1, kind: 1, packId: 1 }, { unique: true, partialFilterExpression: { kind: PACK_KIND }, name: "c_offline_pack_unique" }),
    c.createIndex({ orgId: 1, kind: 1, offlineId: 1, type: 1 }, { unique: true, partialFilterExpression: { kind: ISSUE_KIND }, name: "c_offline_issue_unique" }),
  ]); })().catch((e) => { idxReady = null; throw e; });
  return idxReady;
}

// ---------------------------------------------------------------- the pack
/** Issues a fresh offline pack for a till with an OPEN shift. Returns the pack the till keeps (encrypted) on the device. */
export async function issueOfflinePack({ orgId, membership, actorEmail, registerId }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  const settings = await getSettings(orgId); const off = offlineSettingsOf(settings);
  if (!off.enabled) return fail("Offline selling is switched off for this company. A manager can switch it on in Point of Sale > Setup.", 409, "OFFLINE_DISABLED");
  if (!registerId) return fail("Choose this till's register first. Offline selling works per register.", 400, "NO_REGISTER");
  await ensureOfflineIndexes(); const c = await ccol(); const o = oid(orgId);
  const register = await c.findOne({ _id: oid(registerId), orgId: o, kind: "c_register", active: { $ne: false } });
  if (!register) return fail("Register not found.", 404);
  const shift = await c.findOne({ orgId: o, kind: "c_shift", registerId: register._id, status: "OPEN" });
  if (!shift) return fail("Open a shift on this register first.", 409, "NO_OPEN_SHIFT");
  const { products, warehouses, orgs } = await getOrgCollections();
  const wh = await warehouses.findOne({ _id: register.warehouseId, orgId: o }); if (!wh) return fail("The register's location was not found.", 404);
  const org = await orgs.findOne({ _id: o }, { projection: { name: 1 } });
  const taxOf = await loadTaxResolver(orgId); const whId = sid(wh._id);
  const rows = await products.find({ orgId: o, deletedAt: null, status: "ACTIVE", posVisible: { $ne: false }, productType: { $ne: "GIFT_CARD" } }, { projection: { sku: 1, name: 1, barcode: 1, category: 1, productType: 1, unitPrice: 1, taxCategoryId: 1, availableWarehouseIds: 1, variantGroupId: 1, variantGroupName: 1, variantAttributes: 1 } }).limit(MAX_PACK_PRODUCTS + 1).toArray();
  if (rows.length > MAX_PACK_PRODUCTS) return fail(`Offline selling supports up to ${MAX_PACK_PRODUCTS} till products.`, 409, "TOO_MANY_PRODUCTS");
  const list = rows.filter((p) => Number.isFinite(p.unitPrice) && p.unitPrice >= 0 && (!p.availableWarehouseIds?.length || p.availableWarehouseIds.includes(whId)))
    .map((p) => { const t = taxOf(p.taxCategoryId, whId); const va = Object.values(p.variantAttributes || {}).filter(Boolean).join(" / ");
      return { id: sid(p._id), sku: p.sku, name: va && p.variantGroupName ? `${p.variantGroupName} ${va}` : p.name, barcode: p.barcode || null, category: p.category || null, productType: p.productType || "STOCK", priceMinor: Math.round(p.unitPrice * 100), tax: { code: t.code, name: t.name, rate: t.rate } }; });
  const now = Date.now(); const seqNo = await nextNumber(orgId, `offline_pack:${sid(register._id)}`);
  const packId = `opk_${randomBytes(12).toString("hex")}`; const secret = randomBytes(32).toString("base64url");
  const pack = { packId, registerId: sid(register._id), registerCode: register.code, warehouseId: whId, shiftId: sid(shift._id), cashierEmail: actorEmail,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + off.maxHours * 3600000).toISOString(), receiptPrefix: `OFF-${register.code}-${seqNo}`, maxSales: off.maxSales, maxSaleMinor: off.maxSaleMinor,
    currency: settings.currency, taxMode: settings.taxMode, rounding: { mode: settings.rounding.mode, cashIncrement: settings.rounding.cashIncrement },
    company: org?.name || "", location: wh.name || "", footer: settings.receiptFooter || "", returnPolicy: settings.returnPolicy?.text || "", products: list };
  await c.insertOne({ orgId: o, kind: PACK_KIND, ...pack, secret, status: "ACTIVE", createdAt: nowIso() });
  await c.updateMany({ orgId: o, kind: PACK_KIND, registerId: pack.registerId, cashierEmail: actorEmail, status: "ACTIVE", packId: { $ne: packId } }, { $set: { status: "SUPERSEDED", supersededAt: nowIso() } });
  await audit({ orgId, actorEmail, recordType: "COMMERCE_OFFLINE", recordId: register._id, action: "OFFLINE_PACK_ISSUED", newState: { packId, register: register.code, products: list.length, expiresAt: pack.expiresAt } });
  return { pack: { ...pack, secret } };
}

// ---------------------------------------------------------------- checking and recording
/** Checks one offline sale against its pack. Returns { priced, pay } or { reasons: [...] }. */
export function checkOfflineSale(pack, s, { now = Date.now(), skipSignature = false } = {}) {
  const reasons = [];
  if (!OFFLINE_ID_RE.test(String(s?.offlineId || ""))) return { reasons: ["The sale has no valid offline id."] };
  if (!skipSignature && !sigOk(pack.secret, canonicalOfflineSale(s), s.signature)) reasons.push("The sale's signature does not match: it was changed after it was made, or it is not from this till.");
  const t = Date.parse(s.createdAt);
  if (!Number.isFinite(t)) reasons.push("The sale has no valid time.");
  else {
    if (t < Date.parse(pack.issuedAt) - SKEW_MS) reasons.push("The sale is dated before the till's offline price list was issued.");
    if (t > Date.parse(pack.expiresAt) + SKEW_MS) reasons.push("The sale was made after the till's offline period ended.");
    if (t > now + SKEW_MS) reasons.push("The sale is dated in the future (check the till's clock).");
  }
  if (!(Number.isInteger(s.seq) && s.seq >= 1 && s.seq <= pack.maxSales)) reasons.push(`The till went over its limit of ${pack.maxSales} offline sales.`);
  if (s.receiptNumber !== `${pack.receiptPrefix}-${String(s.seq).padStart(4, "0")}`) reasons.push("The receipt number does not match the till's offline numbering.");
  if (Array.isArray(s.tenders) && s.tenders.some((x) => x?.method && x.method !== "CASH")) reasons.push("Offline sales are cash only.");
  const priced = priceOfflineCart(pack, s.lines);
  if (priced.error) { reasons.push(priced.error); return { reasons }; }
  if (priced.totals.totalMinor !== Number(s.totalMinor)) reasons.push("The sale total does not match the till's offline prices.");
  if (pack.maxSaleMinor > 0 && priced.totals.totalMinor > pack.maxSaleMinor) reasons.push("The sale is larger than the company's offline limit.");
  const pay = settleOfflineCash(priced.totals, Number(s.cashMinor)); if (pay.error) reasons.push(pay.error);
  return reasons.length ? { reasons, priced } : { priced, pay };
}

/** Records a checked offline sale in one transaction, like completeSale (stock + sale + customer-free), then the after-sale
 *  steps (books, audit, events). Idempotent on the offline id. */
async function recordOfflineSale({ orgId, pack, s, priced, pay, actorEmail, resolvedBy = null, skipLedger = false }) {
  const { salesOrders } = await getOrgCollections(); const o = oid(orgId);
  const prior = await salesOrders.findOne({ orgId: o, idempotencyKey: s.offlineId }); if (prior) return { sale: prior, duplicate: true };
  const c = await ccol(); const cid = newCorrelation(); const at = new Date(Math.min(Date.parse(s.createdAt), Date.now())).toISOString();
  const shift = pack.shiftId ? await c.findOne({ _id: oid(pack.shiftId), orgId: o, kind: "c_shift" }) : null;
  let negative = [];
  let doc;
  try {
    doc = await withStockTransaction(async (session) => {
      negative = [];
      const saleId = new (await import("mongodb")).ObjectId();
      const saleNumber = `S-${String(await nextNumber(orgId, "pos_sale", session)).padStart(6, "0")}`;
      const lines = [];
      for (const [i, l] of priced.lines.entries()) {
        let movement = null; let kitCost = null;
        const legs = await stockLegs({ orgId, productId: l.productId, productType: l.productType, quantity: l.quantity, session });
        for (const [k, leg] of legs.entries()) {
          // the goods have already left the shop, so the movement is recorded even if it takes stock below zero (flagged)
          const mv = await recordStockMovement({ orgId, productId: leg.productId, warehouseId: pack.warehouseId, delta: -leg.quantity, type: "SALE", relatedSaleId: saleId, actorEmail: pack.cashierEmail, session,
            idempotencyKey: legs.length === 1 && leg.productId === l.productId ? `${s.offlineId}:${i}` : `${s.offlineId}:${i}:k${k}`, note: `POS ${saleNumber} (offline ${s.receiptNumber})`,
            allowNegative: { reason: `Offline sale ${s.receiptNumber}: sold while the till was offline` } });
          if (mv.error) throw new StockError(mv.error, mv.status || 409, mv.code || "STOCK");
          if (mv.newQuantity < 0) negative.push({ sku: l.sku, name: l.name, quantity: mv.newQuantity });
          if (leg.productId === l.productId) movement = mv;
          else if (mv.movement?.unitCost !== undefined && mv.movement?.unitCost !== null) kitCost = (kitCost || 0) + (mv.movement.unitCost * leg.quantity) / l.quantity;
        }
        if (!movement && kitCost !== null) movement = { movement: { unitCost: Math.round(kitCost * 10000) / 10000, _id: null } };
        lines.push({ productId: oid(l.productId), sku: l.sku, name: l.name, productType: l.productType, category: l.category, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, priceSource: "offline",
          lineDiscountMinor: 0, orderShareMinor: 0, promoMinor: 0, memberMinor: 0, loyaltyMinor: 0, netMinor: l.netMinor, taxMinor: l.taxMinor, grossMinor: l.grossMinor,
          taxCategory: l.taxCategory, taxRate: l.taxRate, note: null, unitCost: movement?.movement?.unitCost ?? null, movementId: movement?.movement?._id || null, returnedQty: 0 });
      }
      const t = priced.totals;
      const d = {
        _id: saleId, orgId: o, channel: "POS", status: "COMPLETED", saleNumber, idempotencyKey: s.offlineId, correlationId: cid,
        departmentId: null, warehouseId: oid(pack.warehouseId), registerId: oid(pack.registerId), shiftId: shift?._id || null,
        contactId: null, cashierEmail: pack.cashierEmail, cashierRole: "cashier", currency: pack.currency, taxMode: pack.taxMode,
        lines, totals: { subtotalMinor: t.subtotalMinor, discountMinor: 0, netMinor: t.netMinor, taxMinor: t.taxMinor, totalMinor: t.totalMinor,
          taxBreakdown: t.taxBreakdown.map((b) => ({ category: b.category, name: b.name, rate: b.rate, taxable: b.taxableMinor / 100, tax: b.taxMinor / 100 })) },
        tenders: [{ method: "CASH", amountMinor: pay.cashMinor, reference: null, manual: true, status: "RECORDED" }], changeMinor: pay.changeMinor, cashRoundingMinor: pay.roundingMinor, paidMinor: pay.paidMinor,
        approval: null, notes: clean(s.notes, 500) || null, refundedMinor: 0, refunds: [], exchangeOf: null, deletedAt: null, createdAt: at, completedAt: at, updatedAt: nowIso(),
        promotions: [], member: null, loyalty: null,
        offline: { receiptNumber: s.receiptNumber, packId: pack.packId, seq: s.seq, clientCreatedAt: s.createdAt, syncedAt: nowIso(), syncedBy: actorEmail, resolvedBy },
      };
      await salesOrders.insertOne(d, { session });
      return d;
    });
  } catch (e) {
    if (e?.code === 11000 && /idempotency/.test(e.message || "")) { const again = await salesOrders.findOne({ orgId: o, idempotencyKey: s.offlineId }); if (again) return { sale: again, duplicate: true }; }
    if (e instanceof StockError || e.status) return { error: e.message, status: e.status || 409 };
    throw e;
  }
  await afterSale({ orgId, actorEmail: pack.cashierEmail, saleDoc: doc, cid, idem: s.offlineId, skipLedger });
  if (s.drawerOpened === true) { // the drawer opening that happened offline goes into the drawer log like any other
    try { await c.insertOne({ orgId: o, kind: "c_drawer", type: "SALE", registerId: oid(pack.registerId), warehouseId: oid(pack.warehouseId), shiftId: doc.shiftId, saleId: doc._id, reason: `Offline sale ${s.receiptNumber}`, byEmail: pack.cashierEmail, at: doc.completedAt, offline: true });
      await audit({ orgId, actorEmail: pack.cashierEmail, recordType: "CASH_DRAWER", recordId: doc._id, action: "DRAWER_OPENED_SALE", metadata: { register: pack.registerCode, offline: true, receiptNumber: s.receiptNumber } }); }
    catch (e) { console.error("offline drawer log failed:", e?.message); }
  }
  return { sale: doc, negative, shiftClosed: !!shift && shift.status !== "OPEN" };
}

async function raiseIssue({ orgId, pack, s, type, reasons, saleDoc = null }) {
  const c = await ccol(); const o = oid(orgId);
  const r = await c.findOneAndUpdate({ orgId: o, kind: ISSUE_KIND, offlineId: String(s.offlineId), type },
    { $setOnInsert: { orgId: o, kind: ISSUE_KIND, offlineId: String(s.offlineId), type, status: "OPEN", reasons, packId: pack?.packId || String(s.packId || ""), registerId: pack?.registerId || null, registerCode: pack?.registerCode || null,
      warehouseId: pack?.warehouseId || null, cashierEmail: pack?.cashierEmail || null, receiptNumber: clean(s.receiptNumber, 60), clientCreatedAt: clean(s.createdAt, 40), totalMinor: Number(s.totalMinor) || 0, cashMinor: Number(s.cashMinor) || 0,
      sale: { lines: (Array.isArray(s.lines) ? s.lines : []).slice(0, 200).map((l) => ({ productId: clean(l?.productId, 40), quantity: Number(l?.quantity) })), seq: s.seq, notes: clean(s.notes, 500), signature: clean(s.signature, 100), createdAt: clean(s.createdAt, 40), cashMinor: Number(s.cashMinor) || 0, totalMinor: Number(s.totalMinor) || 0, receiptNumber: clean(s.receiptNumber, 60), packId: clean(s.packId, 60) },
      saleId: saleDoc?._id || null, saleNumber: saleDoc?.saleNumber || null, createdAt: nowIso() } }, { upsert: true, returnDocument: "after" });
  return r;
}

/** Receives a till's offline queue. Each sale is answered RECORDED / DUPLICATE (already recorded) / REJECTED (not recorded,
 *  sent to the manager) -- the till removes every answered sale from its queue. */
export async function syncOfflineSales({ orgId, membership, actorEmail, packId, registerId, sales }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  if (!Array.isArray(sales) || !sales.length) return fail("Nothing to sync.");
  if (sales.length > MAX_SYNC_BATCH) return fail(`Send at most ${MAX_SYNC_BATCH} sales at a time.`);
  await ensureOfflineIndexes(); const c = await ccol(); const o = oid(orgId);
  const pack = await c.findOne({ orgId: o, kind: PACK_KIND, packId: clean(packId, 60) });
  if (!pack) return fail("This till's offline price list is not known to the server.", 404, "UNKNOWN_PACK");
  if (registerId && sid(registerId) !== pack.registerId) return fail("These sales belong to another register.", 409, "PACK_REGISTER");
  const { salesOrders } = await getOrgCollections(); const results = []; const started = Date.now(); let recordedAny = false;
  for (const s of sales) {
    if (Date.now() - started > SYNC_BUDGET_MS) break; // the rest stay on the till and are sent next time
    const id = String(s?.offlineId || "");
    if (!OFFLINE_ID_RE.test(id)) { results.push({ offlineId: id, status: "REJECTED", reasons: ["No valid offline id."] }); continue; }
    if (String(s.packId) !== pack.packId) { results.push({ offlineId: id, status: "REJECTED", reasons: ["The sale is from another offline price list."] }); continue; }
    const prior = await salesOrders.findOne({ orgId: o, idempotencyKey: id }, { projection: { saleNumber: 1 } });
    if (prior) { results.push({ offlineId: id, status: "DUPLICATE", saleId: sid(prior._id), saleNumber: prior.saleNumber }); continue; }
    const chk = checkOfflineSale(pack, s);
    if (chk.reasons) {
      await raiseIssue({ orgId, pack, s, type: "REJECTED", reasons: chk.reasons });
      await audit({ orgId, actorEmail, recordType: "COMMERCE_OFFLINE", recordId: o, action: "OFFLINE_SALE_REJECTED", newState: { offlineId: id, receiptNumber: clean(s.receiptNumber, 60), reasons: chk.reasons } });
      results.push({ offlineId: id, status: "REJECTED", reasons: chk.reasons }); continue;
    }
    const r = await recordOfflineSale({ orgId, pack, s, priced: chk.priced, pay: chk.pay, actorEmail, skipLedger: true });
    if (r.error) { await raiseIssue({ orgId, pack, s, type: "REJECTED", reasons: [r.error] }); results.push({ offlineId: id, status: "REJECTED", reasons: [r.error] }); continue; }
    const review = [];
    if (r.shiftClosed) review.push("Its shift was already closed when it synced: re-check that shift's cash count.");
    if (r.negative?.length) review.push(`Stock went below zero: ${r.negative.map((n) => `${n.name} (${n.quantity})`).join(", ")}.`);
    if (review.length) await raiseIssue({ orgId, pack, s, type: "REVIEW", reasons: review, saleDoc: r.sale });
    if (!r.duplicate) recordedAny = true;
    results.push({ offlineId: id, status: r.duplicate ? "DUPLICATE" : "RECORDED", saleId: sid(r.sale._id), saleNumber: r.sale.saleNumber, ...(review.length ? { review } : {}) });
  }
  // the books once per batch (not once per sale), skipped when this request is already long: the next round or the
  // nightly ledger sync posts them (the ledger is derived from the sales, so nothing is lost)
  if (recordedAny && Date.now() - started < 18000) try { const { syncLedger } = await import("../ledger.js"); await syncLedger(orgId, { actorEmail: "system:pos" }); } catch (e) { console.error("offline sync: ledger sync failed (nightly sync will retry):", e?.message); }
  return { results, pending: sales.length - results.length };
}

// ---------------------------------------------------------------- manager review
const issueView = (x) => ({ id: sid(x._id), type: x.type, status: x.status, reasons: x.reasons, receiptNumber: x.receiptNumber, register: x.registerCode, warehouseId: x.warehouseId, cashier: x.cashierEmail,
  at: x.clientCreatedAt, total: (x.totalMinor || 0) / 100, cash: (x.cashMinor || 0) / 100, lines: x.sale?.lines || [], saleId: sid(x.saleId), saleNumber: x.saleNumber,
  resolution: x.resolution || null, createdAt: x.createdAt });
export async function listOfflineIssues({ orgId, membership, status = "OPEN" }) {
  const denied = await commerceAccess({ orgId, membership, need: "supervise" }); if (denied) return denied;
  await ensureOfflineIndexes(); const c = await ccol();
  const q = { orgId: oid(orgId), kind: ISSUE_KIND, ...(status === "ALL" ? {} : { status: status === "RESOLVED" ? "RESOLVED" : "OPEN" }) };
  return { issues: (await c.find(q).sort({ createdAt: -1 }).limit(200).toArray()).map(issueView) };
}
/** Manager decision. REJECTED sale: "record" (records it at the pack's prices with the cash the till says it took -- only
 *  when every product is in the pack) or "dismiss" (not recorded; reason required). REVIEW item: "acknowledge". */
export async function resolveOfflineIssue({ orgId, membership, actorEmail, issueId, action, reason }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const why = clean(reason, 300); if (why.length < 3) return fail("Give a reason (at least 3 characters).");
  await ensureOfflineIndexes(); const c = await ccol(); const o = oid(orgId);
  const x = await c.findOne({ _id: oid(issueId), orgId: o, kind: ISSUE_KIND }); if (!x) return fail("Not found.", 404);
  if (x.status !== "OPEN") return fail("This was already resolved.", 409);
  let saleRef = null;
  if (x.type === "REVIEW") { if (action !== "acknowledge") return fail("This item can only be acknowledged."); }
  else if (action === "record") {
    const pack = await c.findOne({ orgId: o, kind: PACK_KIND, packId: x.packId }); if (!pack) return fail("The till's offline price list was not found, so this sale can't be priced. Record it by hand at the till.", 409);
    const s = { ...x.sale, offlineId: x.offlineId };
    const priced = priceOfflineCart(pack, s.lines); if (priced.error) return fail(`${priced.error} Record it by hand at the till.`, 409);
    const cash = Math.max(Number(s.cashMinor) || 0, priced.totals.cashDueMinor); const pay = settleOfflineCash(priced.totals, cash); if (pay.error) return fail(pay.error, 409);
    const r = await recordOfflineSale({ orgId, pack, s: { ...s, createdAt: Number.isFinite(Date.parse(s.createdAt)) ? s.createdAt : nowIso() }, priced, pay, actorEmail, resolvedBy: actorEmail });
    if (r.error) return fail(r.error, r.status || 409);
    saleRef = { saleId: r.sale._id, saleNumber: r.sale.saleNumber };
  } else if (action !== "dismiss") return fail("action must be record or dismiss.");
  const done = await c.findOneAndUpdate({ _id: x._id, status: "OPEN" }, { $set: { status: "RESOLVED", resolution: { action, reason: why, by: actorEmail, role: commerceRoleOf(membership), at: nowIso(), ...(saleRef ? { saleNumber: saleRef.saleNumber } : {}) }, ...(saleRef ? { saleId: saleRef.saleId, saleNumber: saleRef.saleNumber } : {}) } }, { returnDocument: "after" });
  if (!done) return fail("This was already resolved.", 409);
  await audit({ orgId, actorEmail, recordType: "COMMERCE_OFFLINE", recordId: x._id, action: `OFFLINE_ISSUE_${action.toUpperCase()}`, newState: { receiptNumber: x.receiptNumber, type: x.type, reason: why, saleNumber: saleRef?.saleNumber || null } });
  return { issue: issueView(done) };
}
export { saleView };
