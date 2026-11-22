// src/lib/commerce/returns.js -- Inaya Commerce, Batch 3 (Master SOW 6.7, 6.12): returns, exchanges, refunds and voids.
//
// A return always starts from the ORIGINAL sale (receipt number or id) and is stored on it (`sales_orders.refunds[]`),
// so the original sale and its whole return history are preserved together. Inside ONE transaction a return:
//   - re-reads the sale and checks every line against what is still returnable (bounded: returnedQty can never exceed
//     the quantity sold, and the refund can never exceed the refundable balance -- guarded in the update itself)
//   - computes refund and tax reversal proportionally from the stored line amounts (the last unit takes the exact
//     remainder, so a fully returned line refunds exactly what was paid -- no rounding drift)
//   - moves stock by disposition: RESTOCK (back on the shelf), QUARANTINE (into the company's quarantine location),
//     DAMAGED (returned then written off, so the history shows both), NON_RESTOCKABLE (no stock movement)
//   - refunds to the original payment methods (amounts per method are bounded by what that method paid)
//   - for an EXCHANGE, completes the replacement sale in the same transaction, paid first by the return's credit
//   - updates the customer's history and gets a refund number (R-000001); the ledger posts POS_REFUND from the record
// Exceptions need elevated permission (an approval made by someone else, bound to the exact request, single use):
// outside the return window (manager), a refund by someone below the company's refund role, or a refund to a different
// method or a larger amount than the original method paid (supervisor). Duplicate submissions (same idempotencyKey)
// return the first result. Store credit is not offered (approved decision: needs a liability policy first).
//
// A VOID cancels a whole sale while its shift is still open (or on the same day when no register is used); it needs a
// supervisor or manager (a cashier asks for approval). It reverses stock and customer history and the ledger posts a
// reversal. After that, a return is the only way to give money back.
import { createHash } from "node:crypto";
import { ccol, ensureCommerceIndexes, KINDS, fail, clean, nowIso, oid, sid, commerceAccess, commerceRoleOf, getSettings, nextNumber, audit, emitCommerceEvent, fromMinor, toMinor, correlationId as newCorrelation } from "./store.js";
import { roleCovers, cashRounded, priceCart } from "./pricing.js";
import { withStockTransaction, recordStockMovement, StockError } from "../inventory.js";
import { isStocked, isKit, stockLegs } from "./catalogue.js";
import { getOrgCollections } from "../orgs.js";
import { APPROVAL_KIND, saleView, saleContext, registerShift, buildSale, afterSale } from "./sale.js";

export const DISPOSITIONS = ["RESTOCK", "QUARANTINE", "DAMAGED", "NON_RESTOCKABLE"];
export const REFUND_METHODS = ["CASH", "BANK_TRANSFER", "MANUAL_REFERENCE", "STORE_CREDIT", "GIFT_CARD"]; // STORE_CREDIT / GIFT_CARD: liability (Phase 4)
const RETURNABLE = ["COMPLETED", "PARTIALLY_REFUNDED"];
const APPROVAL_TTL_MS = 10 * 60 * 1000;
const boom = (message, status = 400, code) => Object.assign(new Error(message), { status, code });
const maxRole = (list) => (list.some((x) => x.needed === "manager") ? "manager" : list.some((x) => x.needed === "supervisor") ? "supervisor" : "cashier");

/** What each payment method of the sale can still give back: paid (cash net of change) minus earlier refunds. */
export function refundableByMethod(sale) {
  const left = {};
  for (const t of sale.tenders || []) left[t.method] = (left[t.method] || 0) + t.amountMinor;
  if (left.CASH !== undefined) left.CASH = Math.max(0, (sale.tenders || []).filter((t) => t.method === "CASH").reduce((s, t) => s + t.amountMinor, 0) - (sale.changeMinor || 0));
  for (const r of sale.refunds || []) for (const t of r.tenders || []) left[t.method] = (left[t.method] || 0) - t.amountMinor;
  return left;
}

/** Pure: which lines, how much, and which exceptions. `sale` is the stored document. */
export function planReturn({ sale, input, settings, role, now = Date.now() }) {
  if (!RETURNABLE.includes(sale.status)) return fail(sale.status === "VOIDED" ? "This sale was voided; there is nothing to return." : "Everything on this sale has already been returned.", 409, "NOT_RETURNABLE");
  const reason = clean(input.reason, 300); if (!reason || reason.length < 3) return fail("Give a reason for the return.");
  if (!Array.isArray(input.lines) || !input.lines.length) return fail("Choose at least one item to return.");
  const seen = new Set(); const lines = [];
  for (const x of input.lines) {
    const i = Number(x.lineIndex); const l = sale.lines[i];
    if (!Number.isInteger(i) || !l) return fail("Unknown line on this sale.");
    if (l.productType === "GIFT_CARD") return fail("A gift card can't be returned. If it hasn't been used, void the sale instead.", 409, "GIFT_CARD_RETURN");
    if (seen.has(i)) return fail("Each sale line can appear once per return."); seen.add(i);
    const q = Number(x.quantity); const left = l.quantity - (l.returnedQty || 0);
    if (!(q > 0) || Math.round(q * 1000) !== q * 1000) return fail("Return quantities must be positive.");
    if (q > left + 1e-9) return fail(`Only ${left} of ${l.name} can still be returned.`, 409, "OVER_RETURN");
    const disposition = isStocked({ productType: l.productType }) || isKit({ productType: l.productType }) ? (x.disposition || "RESTOCK") : "NON_RESTOCKABLE";
    if (!DISPOSITIONS.includes(disposition)) return fail(`Disposition must be one of ${DISPOSITIONS.join(", ")}.`);
    const last = Math.abs(q - left) < 1e-9;
    const netMinor = last ? l.netMinor - (l.refundedNetMinor || 0) : Math.round((l.netMinor * q) / l.quantity);
    const taxMinor = last ? l.taxMinor - (l.refundedTaxMinor || 0) : Math.round((l.taxMinor * q) / l.quantity);
    lines.push({ lineIndex: i, productId: l.productId, sku: l.sku, name: l.name, productType: l.productType, quantity: q, disposition, netMinor, taxMinor, grossMinor: netMinor + taxMinor, unitCost: l.unitCost ?? null, taxRate: l.taxRate, taxCategory: l.taxCategory });
  }
  const netMinor = lines.reduce((s, l) => s + l.netMinor, 0), taxMinor = lines.reduce((s, l) => s + l.taxMinor, 0), totalMinor = netMinor + taxMinor;
  if (totalMinor > sale.totals.totalMinor - (sale.refundedMinor || 0)) return fail("This is more than the sale's refundable balance.", 409, "OVER_REFUND");
  const exceptions = [];
  const ageDays = (now - Date.parse(sale.completedAt)) / 86400000;
  if (ageDays > settings.returnPolicy.days) exceptions.push({ kind: "return_window", needed: "manager", days: Math.floor(ageDays), policyDays: settings.returnPolicy.days });
  if (!roleCovers(role, settings.refundRole)) exceptions.push({ kind: "refund", needed: settings.refundRole });
  return { lines, netMinor, taxMinor, totalMinor, reason, exceptions };
}

/** Pure: how the refund is paid out. `refundTo`: [{ method, amount?, reference? }] -- non-cash entries need an amount
 *  and a reference; CASH (if listed) takes the remainder, rounded like cash sales. Default: back to the sale's only
 *  method. `exchangeMinor` of the refund is used as credit on the replacement sale instead of being paid out. */
export function planRefundTenders({ sale, totalMinor, refundTo, exchangeMinor = 0, cashIncrement = 0 }) {
  const left = refundableByMethod(sale); const payout = totalMinor - exchangeMinor;
  let wanted = Array.isArray(refundTo) && refundTo.length ? refundTo : null;
  if (!wanted && payout > 0) {
    const methods = Object.keys(left).filter((m) => left[m] > 0 && REFUND_METHODS.includes(m));
    if (methods.length !== 1) return fail("Choose how the refund is paid back (this sale was paid in more than one way).", 400, "REFUND_METHOD_REQUIRED");
    wanted = [{ method: methods[0], amount: methods[0] === "CASH" ? undefined : fromMinor(payout), reference: methods[0] === "CASH" ? null : (sale.tenders.find((t) => t.method === methods[0])?.reference || null) }];
  }
  const out = []; let nonCash = 0; let hasCash = false;
  for (const w of wanted || []) {
    if (!REFUND_METHODS.includes(w.method)) return fail("Refunds can be paid as cash, bank transfer, another referenced method, store credit or back to the gift card.", 400, "REFUND_METHOD");
    if (w.method === "CASH") { if (hasCash) return fail("List cash once."); hasCash = true; continue; }
    if (w.method === "STORE_CREDIT" || w.method === "GIFT_CARD") {
      const m = toMinor(w.amount ?? fromMinor(payout - nonCash)); if (!(m > 0)) return fail("Enter the amount for store credit / the gift card.");
      const card = w.method === "GIFT_CARD" ? (sale.tenders || []).find((t) => t.method === "GIFT_CARD" && t.cardId) : null;
      if (w.method === "GIFT_CARD" && !card) return fail("This sale wasn't paid by gift card.", 400, "REFUND_METHOD");
      out.push({ method: w.method, amountMinor: m, reference: card?.reference || null, cardId: card?.cardId || null, manual: false, status: "RECORDED" }); nonCash += m; continue;
    }
    const m = toMinor(w.amount ?? (wanted.length === 1 ? fromMinor(payout) : NaN)); if (!(m > 0)) return fail("Each non-cash refund needs an amount.");
    const ref = clean(w.reference, 120); if (!ref) return fail(`${w.method === "BANK_TRANSFER" ? "A bank transfer" : "A manual"} refund needs a reference.`);
    out.push({ method: w.method, amountMinor: m, reference: ref, manual: true, status: "RECORDED" }); nonCash += m;
  }
  if (nonCash > payout) return fail("Non-cash refunds are more than the refund.", 400, "OVER_REFUND");
  const cashDue = payout - nonCash; let roundingMinor = 0;
  if (cashDue > 0) {
    if (!hasCash) return fail(`The refund amounts are short by ${fromMinor(cashDue).toFixed(2)}.`, 400, "REFUND_SHORT");
    const rounded = cashRounded(cashDue, cashIncrement); roundingMinor = rounded - cashDue;
    out.unshift({ method: "CASH", amountMinor: rounded, reference: null, manual: true, status: "RECORDED" });
  }
  if (exchangeMinor > 0) out.push({ method: "EXCHANGE", amountMinor: exchangeMinor, reference: null, manual: true, status: "RECORDED" });
  const exceptions = [];
  for (const t of out) if (t.method !== "EXCHANGE" && t.method !== "STORE_CREDIT" && t.amountMinor > (left[t.method] || 0)) exceptions.push({ kind: "refund_method", needed: "supervisor", method: t.method, amount: fromMinor(t.amountMinor), originalLeft: fromMinor(Math.max(0, left[t.method] || 0)) });
  return { tenders: out, roundingMinor, exceptions };
}

export function returnHash(saleId, input) {
  const norm = { s: String(saleId), l: (input.lines || []).map((l) => [Number(l.lineIndex), Number(l.quantity), l.disposition || null]), r: (input.refundTo || []).map((t) => [t.method, t.amount ?? null]),
    x: input.exchange ? (input.exchange.lines || []).map((l) => [String(l.productId), Number(l.quantity), l.priceOverride ?? null, l.discount || null]) : null, w: sid(input.warehouseId) };
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex");
}

async function loadSale(orgId, input) {
  const { salesOrders } = await getOrgCollections(); const o = oid(orgId);
  const q = input.saleId ? { _id: oid(input.saleId), orgId: o, channel: "POS" } : { orgId: o, channel: "POS", saleNumber: clean(input.saleNumber, 20).toUpperCase() };
  if (!input.saleId && !input.saleNumber) return fail("Find the original sale first (receipt number).");
  const sale = await salesOrders.findOne(q);
  return sale ? { sale } : fail("Original sale not found.", 404);
}

/** Everything a return will do, without doing it: amounts, payout and the exceptions that need approval. */
async function evaluate({ orgId, membership, input, sale, settings, session = null }) {
  const role = commerceRoleOf(membership);
  const plan = planReturn({ sale, input, settings, role }); if (plan.error) return plan;
  let exchangeMinor = 0, exchangeTotal = null;
  if (input.exchange) {
    const ex = { ...input.exchange, warehouseId: input.warehouseId || sid(sale.warehouseId), customerId: sid(sale.contactId) };
    const priced = await priceCart({ orgId, membership, input: ex, session }); if (priced.error) return priced;
    exchangeTotal = priced.totals.totalMinor; exchangeMinor = Math.min(plan.totalMinor, exchangeTotal);
  }
  const pay = planRefundTenders({ sale, totalMinor: plan.totalMinor, refundTo: input.refundTo, exchangeMinor, cashIncrement: settings.rounding.cashIncrement }); if (pay.error) return pay;
  const exceptions = [...plan.exceptions, ...pay.exceptions];
  return { plan, pay, exchangeMinor, exchangeTotal, exceptions, needed: exceptions.length ? maxRole(exceptions) : null, covered: !exceptions.length || exceptions.every((x) => roleCovers(role, x.needed)) };
}

// ---------------------------------------------------------------- preview and approvals
export async function previewReturn({ orgId, membership, input }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  const s = await loadSale(orgId, input); if (s.error) return s;
  const settings = await getSettings(orgId);
  const e = await evaluate({ orgId, membership, input, sale: s.sale, settings }); if (e.error) return e;
  return { sale: saleView(s.sale), refund: { net: fromMinor(e.plan.netMinor), tax: fromMinor(e.plan.taxMinor), total: fromMinor(e.plan.totalMinor), lines: e.plan.lines.map(lineView), tenders: e.pay.tenders.map(tenderView), cashRounding: fromMinor(e.pay.roundingMinor) },
    exchange: e.exchangeTotal === null ? null : { total: fromMinor(e.exchangeTotal), credit: fromMinor(e.exchangeMinor), toPay: fromMinor(Math.max(0, e.exchangeTotal - e.exchangeMinor)) },
    exceptions: e.exceptions, approvalNeeded: !e.covered ? e.needed : null };
}
async function createApproval({ orgId, actorEmail, subject, subjectHash, saleId, needed, items, total, currency }) {
  await ensureCommerceIndexes(); const c = await ccol(); const exp = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  const r = await c.insertOne({ orgId: oid(orgId), kind: APPROVAL_KIND, subject, subjectHash, saleId: oid(saleId), status: "PENDING", needed, items, total, currency, requestedBy: actorEmail, createdAt: nowIso(), expiresAt: exp });
  return { approvalId: sid(r.insertedId), needed, items, expiresAt: exp };
}
export async function requestReturnApproval({ orgId, membership, actorEmail, input }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  const s = await loadSale(orgId, input); if (s.error) return s;
  const e = await evaluate({ orgId, membership, input, sale: s.sale, settings: await getSettings(orgId) }); if (e.error) return e;
  if (e.covered) return fail("This return needs no approval.", 409, "NO_APPROVAL_NEEDED");
  return createApproval({ orgId, actorEmail, subject: "return", subjectHash: returnHash(s.sale._id, input), saleId: s.sale._id, needed: e.needed, items: e.exceptions, total: fromMinor(e.plan.totalMinor), currency: s.sale.currency });
}
export async function requestVoidApproval({ orgId, membership, actorEmail, saleId, reason }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  const s = await loadSale(orgId, { saleId }); if (s.error) return s;
  const v = voidCheck(s.sale); if (v.error) return v;
  if (roleCovers(commerceRoleOf(membership), "supervisor")) return fail("You can void this sale yourself.", 409, "NO_APPROVAL_NEEDED");
  return createApproval({ orgId, actorEmail, subject: "void", subjectHash: `void:${sid(s.sale._id)}`, saleId: s.sale._id, needed: "supervisor", items: [{ kind: "void", needed: "supervisor", saleNumber: s.sale.saleNumber, reason: clean(reason, 300) }], total: fromMinor(s.sale.totals.totalMinor), currency: s.sale.currency });
}
/** Consumes a matching approval inside the transaction; throws if it isn't valid for exactly this request. */
async function consumeApproval({ orgId, approvalId, subject, subjectHash, needed, actorEmail, session }) {
  const c = await ccol();
  if (!approvalId) throw boom(`This needs a ${needed}'s approval.`, 403, "APPROVAL_REQUIRED");
  const a = await c.findOneAndUpdate({ _id: oid(approvalId), orgId: oid(orgId), kind: APPROVAL_KIND, subject, subjectHash, status: "APPROVED", expiresAt: { $gt: nowIso() } }, { $set: { status: "USED", usedAt: nowIso(), usedBy: actorEmail } }, { returnDocument: "after", session });
  if (!a) throw boom("The approval is missing, expired, already used or for a different request.", 403, "APPROVAL_INVALID");
  if (!roleCovers(a.decidedRole, needed)) throw boom(`This needs a ${needed}'s approval.`, 403, "APPROVAL_INVALID");
  return a;
}

// ---------------------------------------------------------------- return / exchange
export async function processReturn({ orgId, membership, actorEmail, input }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  const idem = clean(input?.idempotencyKey, 120); if (!idem || idem.length < 8) return fail("idempotencyKey is required (a unique id per return attempt).");
  const s = await loadSale(orgId, input); if (s.error) return s;
  const prior = (s.sale.refunds || []).find((r) => r.idempotencyKey === idem);
  if (prior) return { refund: refundView(s.sale, prior), sale: saleView(s.sale), duplicate: true };
  const settings = await getSettings(orgId); const o = oid(orgId);
  const { salesOrders, warehouses, crmContacts } = await getOrgCollections();
  const returnWh = input.warehouseId ? await warehouses.findOne({ _id: oid(input.warehouseId), orgId: o }) : await warehouses.findOne({ _id: s.sale.warehouseId, orgId: o });
  if (!returnWh) return fail("Return location not found.", 404);
  const rs = await registerShift({ orgId, registerId: input.registerId, warehouseId: returnWh._id }); if (rs.error) return rs;
  if ((input.lines || []).some((l) => l.disposition === "QUARANTINE") && !settings.quarantineWarehouseId) return fail("Set a quarantine location in Point of Sale → Setup first.", 409, "NO_QUARANTINE");
  let ctx = null;
  if (input.exchange) { ctx = await saleContext({ orgId, input: { warehouseId: sid(returnWh._id), customerId: sid(s.sale.contactId), registerId: input.registerId } }); if (ctx.error) return ctx; }
  const cid = newCorrelation(); let result;
  try {
    result = await withStockTransaction(async (session) => {
      const sale = await salesOrders.findOne({ _id: s.sale._id, orgId: o }, { session });
      if ((sale.refunds || []).some((r) => r.idempotencyKey === idem)) throw Object.assign(boom("duplicate", 200), { duplicateSale: sale });
      const e = await evaluate({ orgId, membership, input, sale, settings, session }); if (e.error) throw boom(e.error, e.status || 400, e.code);
      let approval = null;
      if (!e.covered) approval = await consumeApproval({ orgId, approvalId: input.approvalId, subject: "return", subjectHash: returnHash(sale._id, input), needed: e.needed, actorEmail, session });
      const refundNumber = `R-${String(await nextNumber(orgId, "pos_refund", session)).padStart(6, "0")}`;
      // stock, by disposition
      for (const l of e.plan.lines) {
        l.movementIds = [];
        if (l.disposition === "NON_RESTOCKABLE") continue;
        const into = l.disposition === "QUARANTINE" ? settings.quarantineWarehouseId : sid(returnWh._id);
        const legs = await stockLegs({ orgId, productId: l.productId, productType: l.productType, quantity: l.quantity, session });
        for (const [k, leg] of legs.entries()) {
          const own = leg.productId === sid(l.productId); const tag = own ? "" : `k${k}`;
          const back = await recordStockMovement({ orgId, productId: leg.productId, warehouseId: into, delta: leg.quantity, type: "RETURN", relatedSaleId: sale._id, actorEmail, session, idempotencyKey: `${idem}:r${l.lineIndex}${tag}`, note: `Return ${refundNumber} (${sale.saleNumber}) ${l.disposition.toLowerCase()}${own ? "" : ` (kit ${l.sku})`}`, ...(own && l.unitCost !== null ? { unitCost: l.unitCost } : {}) });
          if (back.error) throw new StockError(back.error, back.status || 409, back.code || "STOCK");
          l.movementIds.push(back.movement?._id || null);
          if (l.disposition === "DAMAGED") {
            const off = await recordStockMovement({ orgId, productId: leg.productId, warehouseId: into, delta: -leg.quantity, type: "WRITE_OFF", relatedSaleId: sale._id, actorEmail, session, idempotencyKey: `${idem}:w${l.lineIndex}${tag}`, note: `Damaged return ${refundNumber}` });
            if (off.error) throw new StockError(off.error, off.status || 409, off.code || "STOCK");
            l.movementIds.push(off.movement?._id || null);
          }
        }
      }
      // the bounded update: every line must still have room, the idempotency key must be new
      const filter = { _id: sale._id, orgId: o, status: { $in: RETURNABLE }, "refunds.idempotencyKey": { $ne: idem }, refundedMinor: { $lte: sale.totals.totalMinor - e.plan.totalMinor } };
      const inc = { refundedMinor: e.plan.totalMinor };
      for (const l of e.plan.lines) {
        filter[`lines.${l.lineIndex}.returnedQty`] = { $lte: sale.lines[l.lineIndex].quantity - l.quantity };
        inc[`lines.${l.lineIndex}.returnedQty`] = l.quantity; inc[`lines.${l.lineIndex}.refundedNetMinor`] = l.netMinor; inc[`lines.${l.lineIndex}.refundedTaxMinor`] = l.taxMinor;
      }
      const fully = sale.lines.every((l, i) => { const r = e.plan.lines.find((x) => x.lineIndex === i); return (l.returnedQty || 0) + (r?.quantity || 0) >= l.quantity - 1e-9; });
      const refund = { refundNumber, idempotencyKey: idem, correlationId: cid, reason: e.plan.reason, lines: e.plan.lines.map(({ productId, ...l }) => ({ ...l, productId })), netMinor: e.plan.netMinor, taxMinor: e.plan.taxMinor, totalMinor: e.plan.totalMinor,
        tenders: e.pay.tenders, cashRoundingMinor: e.pay.roundingMinor, warehouseId: returnWh._id, registerId: rs.register?._id || null, shiftId: rs.shift?._id || null, processedBy: actorEmail, processedRole: commerceRoleOf(membership),
        approval: approval ? { id: approval._id, decidedBy: approval.decidedBy, decidedRole: approval.decidedRole, items: approval.items } : null, exchangeSaleId: null, createdAt: nowIso() };
      let exchangeDoc = null;
      if (input.exchange) {
        exchangeDoc = await buildSale({ orgId, membership, actorEmail, input: { ...input.exchange, warehouseId: sid(returnWh._id), customerId: sid(sale.contactId), registerId: input.registerId, idempotencyKey: `${idem}:x` }, ctx, session, cid, idem: `${idem}:x`, credit: { minor: e.exchangeMinor, reference: refundNumber, saleId: sale._id } });
        refund.exchangeSaleId = exchangeDoc._id;
      }
      // Phase 4: money back as store credit / onto the gift card; loyalty points and promotion uses follow the refund
      for (const t of refund.tenders) if (t.method === "STORE_CREDIT" || t.method === "GIFT_CARD") { const G = await import("../growth/giftcards.js"); const k = await G.creditFromRefund({ orgId, sale, method: t.method, amountMinor: t.amountMinor, cardId: t.cardId, currency: sale.currency, refundNumber, session }); t.reference = `••${k.last4}`; t.cardId = oid(k.cardId); }
      const upd = await salesOrders.updateOne(filter, { $inc: inc, $push: { refunds: refund }, $set: { status: fully ? "REFUNDED" : "PARTIALLY_REFUNDED", updatedAt: nowIso() } }, { session });
      if (upd.modifiedCount !== 1) throw boom("This sale changed while the return was being made (or would be over-refunded). Look it up again.", 409, "RETURN_CONFLICT");
      { const L = await import("../growth/loyalty.js"); await L.reverseSalePoints({ orgId, sale, share: e.plan.totalMinor / sale.totals.totalMinor, refundNumber, session }); }
      if (fully) { const P = await import("../growth/promotions.js"); await P.releasePromotionUses({ orgId, saleId: sale._id, session }); }
      if (sale.contactId) await crmContacts.updateOne({ _id: sale.contactId, orgId: o }, { $inc: { "commerce.spendMinor": -e.plan.totalMinor, "commerce.returnCount": 1, "commerce.refundedMinor": e.plan.totalMinor }, $set: { "commerce.lastReturnAt": refund.createdAt } }, { session });
      return { refund, exchangeDoc };
    });
  } catch (err) {
    if (err?.duplicateSale) { const r = err.duplicateSale.refunds.find((x) => x.idempotencyKey === idem); return { refund: refundView(err.duplicateSale, r), sale: saleView(err.duplicateSale), duplicate: true }; }
    if (err instanceof StockError || err.status) return { error: err.message, status: err.status || 409, code: err.code };
    throw err;
  }
  const after = await salesOrders.findOne({ _id: s.sale._id, orgId: o });
  try { const { syncLedger } = await import("../ledger.js"); await syncLedger(orgId, { actorEmail: "system:pos" }); } catch (e) { console.error("pos: ledger sync after refund failed (nightly sync will retry):", e?.message); }
  const r = result.refund;
  await audit({ orgId, actorEmail, recordType: "POS_REFUND", recordId: s.sale._id, action: "REFUND_COMPLETED", newState: { saleNumber: s.sale.saleNumber, refundNumber: r.refundNumber, total: fromMinor(r.totalMinor), currency: s.sale.currency, lines: r.lines.map((l) => ({ sku: l.sku, quantity: l.quantity, disposition: l.disposition })), reason: r.reason, tenders: r.tenders.map((t) => ({ method: t.method, amount: fromMinor(t.amountMinor) })) }, metadata: { correlationId: cid, approval: r.approval ? { by: r.approval.decidedBy, items: r.approval.items } : null, exchangeSaleId: sid(r.exchangeSaleId) } });
  await emitCommerceEvent({ orgId, name: "refund.completed", entityId: s.sale._id, actorEmail, correlationId: cid, idempotencyKey: idem, payload: { saleNumber: s.sale.saleNumber, refundNumber: r.refundNumber, total: fromMinor(r.totalMinor), currency: s.sale.currency, lines: r.lines.map((l) => ({ sku: l.sku, quantity: l.quantity, disposition: l.disposition })), exchange: !!r.exchangeSaleId } });
  if (result.exchangeDoc) await afterSale({ orgId, actorEmail, saleDoc: result.exchangeDoc, cid, idem: `${idem}:x` });
  return { refund: refundView(after, r), sale: saleView(after), ...(result.exchangeDoc ? { exchangeSale: saleView(result.exchangeDoc) } : {}) };
}

// ---------------------------------------------------------------- void
function voidCheck(sale) {
  if (sale.status !== "COMPLETED") return fail(sale.status === "VOIDED" ? "This sale is already voided." : "This sale has returns; use a return instead of a void.", 409, "NOT_VOIDABLE");
  if ((sale.refunds || []).length) return fail("This sale has returns; use a return instead of a void.", 409, "NOT_VOIDABLE");
  if (!sale.shiftId && Date.now() - Date.parse(sale.completedAt) > 24 * 3600 * 1000) return fail("Sales can be voided only on the day they were made. Use a return.", 409, "VOID_WINDOW");
  return { ok: true };
}
export async function voidSale({ orgId, membership, actorEmail, saleId, reason, approvalId }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  const why = clean(reason, 300); if (!why || why.length < 3) return fail("Give a reason for the void.");
  const s = await loadSale(orgId, { saleId }); if (s.error) return s;
  const v = voidCheck(s.sale); if (v.error) return v;
  const c = await ccol(); const o = oid(orgId);
  if (s.sale.shiftId) { const sh = await c.findOne({ _id: s.sale.shiftId, orgId: o, kind: KINDS.shift }); if (sh?.status !== "OPEN") return fail("The shift this sale was made in is closed. Use a return.", 409, "VOID_WINDOW"); }
  const role = commerceRoleOf(membership); const { salesOrders, crmContacts } = await getOrgCollections(); const cid = newCorrelation();
  let doc;
  try {
    doc = await withStockTransaction(async (session) => {
      let approval = null;
      if (!roleCovers(role, "supervisor")) approval = await consumeApproval({ orgId, approvalId, subject: "void", subjectHash: `void:${sid(s.sale._id)}`, needed: "supervisor", actorEmail, session });
      const now = nowIso();
      const r = await salesOrders.findOneAndUpdate({ _id: s.sale._id, orgId: o, status: "COMPLETED", "refunds.0": { $exists: false } }, { $set: { status: "VOIDED", voidedAt: now, voidedBy: actorEmail, voidReason: why, voidApproval: approval ? { id: approval._id, decidedBy: approval.decidedBy, decidedRole: approval.decidedRole } : null, updatedAt: now } }, { returnDocument: "after", session });
      if (!r) throw boom("This sale changed while voiding. Look it up again.", 409, "VOID_CONFLICT");
      for (const [i, l] of r.lines.entries()) {
        const legs = await stockLegs({ orgId, productId: l.productId, productType: l.productType, quantity: l.quantity, session });
        for (const [k, leg] of legs.entries()) {
          const own = leg.productId === sid(l.productId);
          const back = await recordStockMovement({ orgId, productId: leg.productId, warehouseId: sid(r.warehouseId), delta: leg.quantity, type: "RETURN", relatedSaleId: r._id, actorEmail, session, idempotencyKey: `void:${sid(r._id)}:${i}${own ? "" : `:k${k}`}`, note: `Void ${r.saleNumber}`, ...(own && l.unitCost !== null && l.unitCost !== undefined ? { unitCost: l.unitCost } : {}) });
          if (back.error) throw new StockError(back.error, back.status || 409, back.code || "STOCK");
        }
      }
      if (r.contactId) await crmContacts.updateOne({ _id: r.contactId, orgId: o }, { $inc: { "commerce.purchaseCount": -1, "commerce.spendMinor": -r.totals.totalMinor, "commerce.voidCount": 1 } }, { session });
      // Phase 4: cards issued by this sale are cancelled (only if unused); card tenders are put back; points and offers reversed
      const G = await import("../growth/giftcards.js");
      await G.cancelIssuedCards({ orgId, saleId: r._id, session });
      for (const t of r.tenders || []) if ((t.method === "GIFT_CARD" || t.method === "STORE_CREDIT") && t.cardId) await G.creditFromRefund({ orgId, sale: r, method: t.method === "STORE_CREDIT" ? "STORE_CREDIT" : "GIFT_CARD", amountMinor: t.amountMinor, cardId: t.cardId, currency: r.currency, refundNumber: "VOID", session });
      { const L = await import("../growth/loyalty.js"); await L.reverseSalePoints({ orgId, sale: r, share: 1, session }); }
      { const P = await import("../growth/promotions.js"); await P.releasePromotionUses({ orgId, saleId: r._id, session }); }
      return r;
    });
  } catch (err) {
    if (err instanceof StockError || err.status) return { error: err.message, status: err.status || 409, code: err.code };
    throw err;
  }
  try { const { syncLedger } = await import("../ledger.js"); await syncLedger(orgId, { actorEmail: "system:pos" }); } catch (e) { console.error("pos: ledger sync after void failed (nightly sync will retry):", e?.message); }
  await audit({ orgId, actorEmail, recordType: "POS_SALE", recordId: doc._id, action: "SALE_VOIDED", previousState: { status: "COMPLETED" }, newState: { status: "VOIDED", saleNumber: doc.saleNumber, total: fromMinor(doc.totals.totalMinor), reason: why }, metadata: { correlationId: cid, approval: doc.voidApproval ? { by: doc.voidApproval.decidedBy } : null } });
  await emitCommerceEvent({ orgId, name: "sale.voided", entityId: doc._id, actorEmail, correlationId: cid, idempotencyKey: `void:${sid(doc._id)}`, payload: { saleNumber: doc.saleNumber, total: fromMinor(doc.totals.totalMinor), currency: doc.currency } });
  return { sale: saleView(doc) };
}

// ---------------------------------------------------------------- views and refund receipts
const tenderView = (t) => ({ method: t.method, amount: fromMinor(t.amountMinor), reference: t.reference || null, manual: true });
const lineView = (l) => ({ lineIndex: l.lineIndex, sku: l.sku, name: l.name, quantity: l.quantity, disposition: l.disposition, net: fromMinor(l.netMinor), tax: fromMinor(l.taxMinor), total: fromMinor(l.grossMinor), taxRate: l.taxRate });
export function refundView(sale, r) {
  return { refundNumber: r.refundNumber, saleId: sid(sale._id), saleNumber: sale.saleNumber, currency: sale.currency, reason: r.reason, lines: r.lines.map(lineView), net: fromMinor(r.netMinor), tax: fromMinor(r.taxMinor), total: fromMinor(r.totalMinor),
    tenders: r.tenders.map(tenderView), cashRounding: fromMinor(r.cashRoundingMinor || 0), processedBy: r.processedBy, approvedBy: r.approval?.decidedBy || null, exchangeSaleId: sid(r.exchangeSaleId), createdAt: r.createdAt };
}
export async function refundReceipt({ orgId, membership, saleId, refundNumber }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  const s = await loadSale(orgId, { saleId }); if (s.error) return s;
  const r = (s.sale.refunds || []).find((x) => x.refundNumber === clean(refundNumber, 20).toUpperCase()); if (!r) return fail("Refund not found.", 404);
  const { orgs, warehouses } = await getOrgCollections(); const org = await orgs.findOne({ _id: oid(orgId) }, { projection: { name: 1 } });
  const wh = await warehouses.findOne({ _id: r.warehouseId, orgId: oid(orgId) }, { projection: { name: 1 } });
  return { receipt: { kind: "refund", company: org?.name || "", location: wh?.name || "", ...refundView(s.sale, r), originalTotal: fromMinor(s.sale.totals.totalMinor), originalDate: s.sale.completedAt } };
}
