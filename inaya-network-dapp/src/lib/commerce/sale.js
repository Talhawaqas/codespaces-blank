// src/lib/commerce/sale.js -- Inaya Commerce, Batch 2 (Master SOW 6.3, 6.5, 6.6, 6.10): the POS sale engine.
//
// completeSale runs the SOW's 12-step completion in ONE MongoDB transaction:
//   1 company/role/location/register checks   2 product status and price   3 server-side tax and discounts (pricing.js)
//   4 stock: a guarded SALE movement per stock line (inventory.js; concurrent sales cannot oversell)
//   5 tenders (cash / bank transfer / manual reference; split; change; cash rounding) -- MANUAL records, never shown as
//     provider-confirmed card payments   6 the sale record (sales_orders, channel "POS", receipt number)
//   7 customer purchase history ($inc on the CRM contact)   8 finance: the ledger posts the sale from this record
//   (state-derived syncLedger, run right after commit; the nightly sync catches anything missed)   9 receipt (from the record)
//   10 events (after commit)   11 audit (after commit)   12 a clear result.
// Anything failing inside the transaction aborts ALL of it -- no sale, no stock movement, no history change. A resubmitted
// sale (same idempotencyKey) returns the original sale instead of creating a second one.
//
// Approvals: a discount or price override beyond the cashier's limit needs an approval made by a supervisor/manager from
// THEIR OWN session (never the requester). The approval is bound to a hash of the exact cart, expires in 10 minutes and
// is consumed once, inside the sale transaction.
import { createHash, randomBytes } from "node:crypto";
import { ccol, ensureCommerceIndexes, KINDS, fail, clean, nowIso, oid, sid, commerceAccess, commerceRoleOf, getSettings, nextNumber, audit, emitCommerceEvent, toMinor, fromMinor, correlationId as newCorrelation } from "./store.js";
import { priceCart, roleCovers, cashRounded } from "./pricing.js";
import { withStockTransaction, recordStockMovement, StockError } from "../inventory.js";
import { isStocked, stockLegs } from "./catalogue.js";
import { getOrgCollections } from "../orgs.js";
import { scopeFilter } from "../workforce/scope.js";

export const TENDERS = ["CASH", "BANK_TRANSFER", "MANUAL_REFERENCE", "GIFT_CARD", "STORE_CREDIT"]; // gift card / store credit = liability tenders (Phase 4) // card/provider tenders arrive with an approved provider integration
const APPROVAL_TTL_MS = 10 * 60 * 1000;
export const APPROVAL_KIND = "c_approval"; export const PARKED_KIND = "c_parked";

/** Stable hash of what was priced: what an approval is bound to. */
export function cartHash(input) {
  const norm = { w: sid(input.warehouseId), c: sid(input.customerId), pl: sid(input.priceListId), od: input.orderDiscount || null,
    l: (input.lines || []).map((l) => [String(l.productId), Number(l.quantity), l.priceOverride ?? null, l.discount || null]) };
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex");
}

// ---------------------------------------------------------------- approvals
export async function requestApproval({ orgId, membership, actorEmail, input }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  const priced = await priceCart({ orgId, membership, input }); if (priced.error) return priced;
  if (!priced.approvals.length) return fail("This cart needs no approval.", 409, "NO_APPROVAL_NEEDED");
  const needed = priced.approvals.some((a) => a.needed === "manager") ? "manager" : "supervisor";
  await ensureCommerceIndexes(); const c = await ccol(); const now = nowIso();
  const r = await c.insertOne({ orgId: oid(orgId), kind: APPROVAL_KIND, status: "PENDING", cartHash: cartHash(input), needed, items: priced.approvals, total: priced.totals.total, currency: priced.currency, requestedBy: actorEmail, createdAt: now, expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString() });
  return { approvalId: sid(r.insertedId), needed, items: priced.approvals, expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString() };
}
export async function listPendingApprovals({ orgId, membership }) {
  const denied = await commerceAccess({ orgId, membership, need: "supervise" }); if (denied) return denied;
  const c = await ccol();
  const rows = await c.find({ orgId: oid(orgId), kind: APPROVAL_KIND, status: "PENDING", expiresAt: { $gt: nowIso() } }).sort({ createdAt: -1 }).limit(50).toArray();
  return { approvals: rows.map((a) => ({ id: sid(a._id), subject: a.subject || "sale", needed: a.needed, items: a.items, total: a.total, currency: a.currency, requestedBy: a.requestedBy, createdAt: a.createdAt, expiresAt: a.expiresAt })) };
}
export async function decideApproval({ orgId, membership, actorEmail, approvalId, approve, reason }) {
  const denied = await commerceAccess({ orgId, membership, need: "supervise" }); if (denied) return denied;
  const c = await ccol(); const a = await c.findOne({ _id: oid(approvalId), orgId: oid(orgId), kind: APPROVAL_KIND });
  if (!a) return fail("Approval request not found.", 404);
  if (a.requestedBy === actorEmail) return fail("You cannot approve your own request.", 403, "SELF_APPROVAL");
  if (!roleCovers(commerceRoleOf(membership), a.needed)) return fail(`This needs a ${a.needed}.`, 403, "APPROVER_ROLE");
  const r = await c.findOneAndUpdate({ _id: a._id, status: "PENDING", expiresAt: { $gt: nowIso() } }, { $set: { status: approve ? "APPROVED" : "REJECTED", decidedBy: actorEmail, decidedRole: commerceRoleOf(membership), decidedAt: nowIso(), reason: clean(reason, 300) || null } }, { returnDocument: "after" });
  if (!r) return fail("This request was already decided or has expired.", 409);
  await audit({ orgId, actorEmail, recordType: "COMMERCE_APPROVAL", recordId: a._id, action: approve ? "APPROVED" : "REJECTED", newState: { needed: a.needed, items: a.items, requestedBy: a.requestedBy } });
  return { approvalId: sid(a._id), status: r.status };
}
export async function getApprovalStatus({ orgId, membership, approvalId }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  const c = await ccol(); const a = await c.findOne({ _id: oid(approvalId), orgId: oid(orgId), kind: APPROVAL_KIND });
  if (!a) return fail("Approval request not found.", 404);
  return { approvalId: sid(a._id), status: a.expiresAt <= nowIso() && a.status === "PENDING" ? "EXPIRED" : a.status, decidedBy: a.decidedBy || null };
}

// ---------------------------------------------------------------- tenders
/** Validates tenders against the amount due. Cash may exceed what is due (change is given, from cash only); other tenders
 *  must not. Returns minor-unit tenders, change and the cash-rounding adjustment. */
export function settleTenders(tenders, dueMinor, cashIncrement, { creditMinor = 0, creditRef = null } = {}) {
  tenders = Array.isArray(tenders) ? tenders.filter((x) => Number(x?.amount) > 0) : [];
  if (!tenders.length && !(creditMinor > 0)) return fail("Add at least one payment.");
  if (tenders.length > 10) return fail("At most 10 payments per sale.");
  const t = creditMinor > 0 ? [{ method: "EXCHANGE_CREDIT", amountMinor: creditMinor, reference: creditRef, manual: true, status: "RECORDED" }] : [];
  for (const x of tenders) {
    if (!TENDERS.includes(x.method)) return fail(`Unsupported payment method ${x.method}. Card payments need an approved payment provider.`, 400, "TENDER");
    const m = toMinor(x.amount); if (!(m > 0)) return fail("Each payment must be a positive amount.");
    const ref = clean(x.reference, 120);
    if (x.method === "GIFT_CARD") { if (!clean(x.code, 40)) return fail("Enter the gift card code."); t.push({ method: x.method, amountMinor: m, reference: null, manual: false, status: "RECORDED", _code: clean(x.code, 40) }); continue; }
    if (x.method === "STORE_CREDIT") { t.push({ method: x.method, amountMinor: m, reference: null, manual: false, status: "RECORDED" }); continue; }
    if (x.method !== "CASH" && !ref) return fail(`${x.method === "BANK_TRANSFER" ? "Bank transfer" : "Manual payment"} needs a reference.`);
    t.push({ method: x.method, amountMinor: m, reference: ref || null, manual: true, status: "RECORDED" });
  }
  const nonCash = t.filter((x) => x.method !== "CASH").reduce((s, x) => s + x.amountMinor, 0);
  const cash = t.filter((x) => x.method === "CASH").reduce((s, x) => s + x.amountMinor, 0);
  if (nonCash > dueMinor) return fail("Non-cash payments are more than the amount due.", 400, "OVERPAID");
  const cashDue = dueMinor - nonCash; const cashDueRounded = cash > 0 ? cashRounded(cashDue, cashIncrement) : cashDue;
  const rounding = cash > 0 ? cashDueRounded - cashDue : 0;
  if (cash < cashDueRounded) return fail(`Payments are short by ${fromMinor(cashDueRounded - cash).toFixed(2)}.`, 400, "UNDERPAID");
  return { tenders: t, changeMinor: cash - cashDueRounded, roundingMinor: rounding, paidMinor: dueMinor + rounding };
}

// ---------------------------------------------------------------- completion
/** Location, customer, settings and (when a register is used) its OPEN shift -- shared by sales, returns and exchanges. */
export async function saleContext({ orgId, input }) {
  const { warehouses, crmContacts } = await getOrgCollections(); const o = oid(orgId);
  const warehouse = await warehouses.findOne({ _id: oid(input.warehouseId), orgId: o });
  if (!warehouse) return fail("Choose the location (warehouse) the sale is made from.", 400);
  const customer = input.customerId ? await crmContacts.findOne({ _id: oid(input.customerId), orgId: o }) : null;
  if (input.customerId && !customer) return fail("Customer not found.", 404);
  const settings = await getSettings(orgId);
  await ensureCommerceIndexes(); const c = await ccol();
  const rs = await registerShift({ orgId, registerId: input.registerId, warehouseId: warehouse._id }); if (rs.error) return rs;
  return { warehouse, customer, settings, register: rs.register, shift: rs.shift, c };
}
/** When a register is used it must be at this location and have an OPEN shift (Master SOW 6.8). */
export async function registerShift({ orgId, registerId, warehouseId }) {
  if (!registerId) return { register: null, shift: null };
  const c = await ccol(); const o = oid(orgId);
  const register = await c.findOne({ _id: oid(registerId), orgId: o, kind: KINDS.register, active: { $ne: false } });
  if (!register) return fail("Register not found.", 404);
  if (warehouseId && sid(register.warehouseId) !== sid(warehouseId)) return fail("This register belongs to another location.", 409);
  const shift = await c.findOne({ orgId: o, kind: KINDS.shift, registerId: register._id, status: "OPEN" });
  if (!shift) return fail("Open a shift on this register first.", 409, "NO_OPEN_SHIFT");
  return { register, shift };
}

export async function completeSale({ orgId, membership, actorEmail, input }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  const idem = clean(input?.idempotencyKey, 120);
  if (!idem || idem.length < 8) return fail("idempotencyKey is required (a unique id per sale attempt).");
  const { salesOrders } = await getOrgCollections(); const o = oid(orgId);
  const prior = await salesOrders.findOne({ orgId: o, idempotencyKey: idem });
  if (prior) return { sale: saleView(prior), duplicate: true };
  const ctx = await saleContext({ orgId, input }); if (ctx.error) return ctx;
  const cid = newCorrelation(); let saleDoc;
  try {
    saleDoc = await withStockTransaction((session) => buildSale({ orgId, membership, actorEmail, input, ctx, session, cid, idem }));
  } catch (e) {
    if (e?.code === 11000 && /idempotency/.test(e.message || "")) { const again = await salesOrders.findOne({ orgId: o, idempotencyKey: idem }); if (again) return { sale: saleView(again), duplicate: true }; }
    if (e instanceof StockError || e.status) return { error: e.message, status: e.status || 409, code: e.code, ...(e.approvals ? { approvals: e.approvals } : {}) };
    throw e;
  }
  await afterSale({ orgId, actorEmail, saleDoc, cid, idem });
  return { sale: saleView(saleDoc), ...(saleDoc._issuedCards?.length ? { giftCards: saleDoc._issuedCards.map((g) => ({ code: g.code, last4: g.last4, line: g.line })) } : {}) };
}

/** The sale itself, inside the caller's transaction (a plain sale, or the replacement half of an exchange). Throws on
 *  any failure so the whole transaction aborts. `credit` = exchange credit from a return in the same transaction. */
export async function buildSale({ orgId, membership, actorEmail, input, ctx, session, cid, idem, credit = null }) {
  const { salesOrders, crmContacts } = await getOrgCollections(); const o = oid(orgId);
  const { warehouse, customer, settings, register, shift, c } = ctx; const startedAt = nowIso();
  {
    {
      const priced = await priceCart({ orgId, membership, input, session });
      if (priced.error) throw Object.assign(new Error(priced.error), { status: priced.status || 400, code: priced.code });
      // approvals for anything beyond the actor's authority
      let approval = null;
      if (priced.approvals.length) {
        if (!input.approvalId) throw Object.assign(new Error("This sale needs a supervisor/manager approval for its discount or price change."), { status: 403, code: "APPROVAL_REQUIRED", approvals: priced.approvals });
        const needed = priced.approvals.some((a) => a.needed === "manager") ? "manager" : "supervisor";
        approval = await c.findOneAndUpdate({ _id: oid(input.approvalId), orgId: o, kind: APPROVAL_KIND, status: "APPROVED", cartHash: cartHash(input), expiresAt: { $gt: nowIso() } }, { $set: { status: "USED", usedAt: nowIso(), usedBy: actorEmail } }, { returnDocument: "after", session });
        if (!approval) throw Object.assign(new Error("The approval is missing, expired, already used or for a different cart."), { status: 403, code: "APPROVAL_INVALID" });
        if (!roleCovers(approval.decidedRole, needed)) throw Object.assign(new Error(`This needs a ${needed}'s approval.`), { status: 403, code: "APPROVAL_INVALID" });
      }
      const totalMinor = priced.totals.totalMinor;
      const creditMinor = credit ? Math.min(credit.minor, totalMinor) : 0;
      const pay = settleTenders(input.tenders, totalMinor, settings.rounding.cashIncrement, { creditMinor, creditRef: credit?.reference || null });
      if (pay.error) throw Object.assign(new Error(pay.error), { status: pay.status || 400, code: pay.code });
      const saleId = new (await import("mongodb")).ObjectId();
      const saleNumber = `S-${String(await nextNumber(orgId, "pos_sale", session)).padStart(6, "0")}`;
      // gift card / store credit tenders: guarded redemption inside this transaction; the code itself is never stored
      const G = (pay.tenders.some((t) => ["GIFT_CARD", "STORE_CREDIT"].includes(t.method)) || priced.lines.some((l) => l.productType === "GIFT_CARD")) ? await import("../growth/giftcards.js") : null;
      if (pay.tenders.some((t) => t.method === "GIFT_CARD") && priced.lines.some((l) => l.productType === "GIFT_CARD")) throw Object.assign(new Error("A gift card can't be paid for with another gift card."), { status: 400, code: "GIFT_FOR_GIFT" });
      for (const [k, t] of pay.tenders.entries()) {
        if (!["GIFT_CARD", "STORE_CREDIT"].includes(t.method)) continue;
        const r = await G.redeemTender({ orgId, sale: { _id: saleId }, tender: { method: t.method, code: t._code }, amountMinor: t.amountMinor, customerId: customer?._id || null, idem: `redeem:${sid(saleId)}:${k}`, session });
        t.reference = `••${r.last4}`; t.cardId = r.cardId; delete t._code;
      }
      // stock: one guarded SALE movement per stock line; non-stock and service lines don't move stock
      const lines = [];
      for (const [i, l] of priced.lines.entries()) {
        let movement = null; let kitCost = null;
        const legs = await stockLegs({ orgId, productId: l.productId, productType: l.productType, quantity: l.quantity, session });
        for (const [k, leg] of legs.entries()) {
          const mv = await recordStockMovement({ orgId, productId: leg.productId, warehouseId: sid(warehouse._id), delta: -leg.quantity, type: "SALE", relatedSaleId: saleId, actorEmail, session, idempotencyKey: legs.length === 1 && leg.productId === String(l.productId) ? `${idem}:${i}` : `${idem}:${i}:k${k}`, note: `POS ${saleNumber}${leg.productId !== String(l.productId) ? ` (kit ${l.sku})` : ""}`,
            ...(settings.allowNegativeStock ? { allowNegative: { reason: "Company setting allows selling below zero stock" } } : {}) });
          if (mv.error) throw new StockError(mv.error, mv.status || 409, mv.code || "STOCK");
          if (leg.productId === String(l.productId)) movement = mv;
          else if (mv.movement?.unitCost !== undefined && mv.movement?.unitCost !== null) kitCost = (kitCost || 0) + (mv.movement.unitCost * leg.quantity) / l.quantity;
        }
        if (!movement && kitCost !== null) movement = { movement: { unitCost: Math.round(kitCost * 10000) / 10000, _id: null } };
        const m = l._minor;
        lines.push({ productId: oid(l.productId), sku: l.sku, name: l.name, productType: l.productType, category: l.category || null, quantity: l.quantity, unitPriceMinor: toMinor(l.unitPrice), priceSource: l.priceSource,
          lineDiscountMinor: toMinor(l.lineDiscount), orderShareMinor: toMinor(l.orderDiscountShare) + m.promo + m.member + m.loyalty, promoMinor: m.promo, memberMinor: m.member, loyaltyMinor: m.loyalty, netMinor: m.netMinor, taxMinor: m.taxMinor, grossMinor: m.grossMinor,
          taxCategory: l.taxCategory, taxRate: l.taxRate, note: l.note, unitCost: movement?.movement?.unitCost ?? null, movementId: movement?.movement?._id || null, returnedQty: 0 });
      }
      const doc = {
        _id: saleId, orgId: o, channel: "POS", status: "COMPLETED", saleNumber, idempotencyKey: idem, correlationId: cid,
        departmentId: warehouse.departmentId || null, warehouseId: warehouse._id, registerId: register?._id || null, shiftId: shift?._id || null,
        contactId: customer?._id || null, cashierEmail: actorEmail, cashierRole: commerceRoleOf(membership), currency: priced.currency, taxMode: priced.taxMode,
        lines, totals: { subtotalMinor: toMinor(priced.totals.subtotal), discountMinor: toMinor(priced.totals.discounts), netMinor: toMinor(priced.totals.net), taxMinor: toMinor(priced.totals.tax), totalMinor, taxBreakdown: priced.totals.taxBreakdown },
        tenders: pay.tenders, changeMinor: pay.changeMinor, cashRoundingMinor: pay.roundingMinor, paidMinor: pay.paidMinor,
        approval: approval ? { id: approval._id, decidedBy: approval.decidedBy, decidedRole: approval.decidedRole, items: approval.items } : null,
        notes: clean(input.notes, 500) || null, refundedMinor: 0, refunds: [], exchangeOf: credit?.saleId || null, deletedAt: null, createdAt: startedAt, completedAt: nowIso(), updatedAt: nowIso(),
        promotions: (priced.totals.promotions || []).map((p) => ({ id: p.id, name: p.name, code: p.code, discountMinor: p.discountMinor })), member: priced.totals.member || null,
        loyalty: priced.totals.loyalty?.points ? { redeemedPoints: priced.totals.loyalty.points, redeemedValueMinor: priced.totals.loyalty.valueMinor } : null,
      };
      // Phase 4: promotion uses, loyalty points (redeem + earn) and gift cards, all inside this transaction
      if (doc.promotions.length) { const { recordPromotionUses } = await import("../growth/promotions.js"); await recordPromotionUses({ orgId, applied: doc.promotions.map((p) => ({ ...p })), saleId, customerId: customer?._id || null, revenueMinor: totalMinor, session }); }
      if (customer) {
        const { postSalePoints } = await import("../growth/loyalty.js");
        const pts = await postSalePoints({ orgId, sale: { _id: saleId, contactId: customer._id }, lines: lines.filter((l) => l.productType !== "GIFT_CARD").map((l) => ({ paidMinor: l.grossMinor, category: l.category })), redeemPoints: doc.loyalty?.redeemedPoints || 0, session });
        if (pts.earned || pts.redeemed) doc.loyalty = { ...(doc.loyalty || {}), earnedPoints: pts.earned, tier: pts.tier };
      }
      const issued = [];
      for (const [i, l] of lines.entries()) if (l.productType === "GIFT_CARD") { const card = await G.issueCardFromSale({ orgId, sale: { _id: saleId }, lineIndex: i, amountMinor: l.grossMinor, currency: priced.currency, customerId: customer?._id || null, session }); l.giftCardId = oid(card.cardId); l.giftCardLast4 = card.last4; issued.push({ line: i, ...card }); }
      await salesOrders.insertOne(doc, { session });
      Object.defineProperty(doc, "_issuedCards", { value: issued, enumerable: false });
      if (customer) await crmContacts.updateOne({ _id: customer._id, orgId: o }, { $inc: { "commerce.purchaseCount": 1, "commerce.spendMinor": totalMinor }, $set: { "commerce.lastPurchaseAt": doc.completedAt, "commerce.currency": priced.currency }, $min: { "commerce.firstPurchaseAt": doc.completedAt } }, { session });
      if (input.parkedId) await c.deleteOne({ _id: oid(input.parkedId), orgId: o, kind: PARKED_KIND }, { session });
      return doc;
    }
  }
}

/** After commit: finance, audit, events. None of these can un-make the sale; failures are logged and the nightly ledger
 *  sync posts anything missed. */
export async function afterSale({ orgId, actorEmail, saleDoc, cid, idem, skipLedger = false }) {
  if (!skipLedger) try { const { syncLedger } = await import("../ledger.js"); await syncLedger(orgId, { actorEmail: "system:pos" }); } catch (e) { console.error("pos: ledger sync after sale failed (nightly sync will retry):", e?.message); }
  await audit({ orgId, actorEmail, recordType: "POS_SALE", recordId: saleDoc._id, action: "SALE_COMPLETED", newState: { saleNumber: saleDoc.saleNumber, total: fromMinor(saleDoc.totals.totalMinor), currency: saleDoc.currency, lines: saleDoc.lines.length }, metadata: { correlationId: cid, approval: saleDoc.approval ? { by: saleDoc.approval.decidedBy } : null } });
  const payload = { saleNumber: saleDoc.saleNumber, total: fromMinor(saleDoc.totals.totalMinor), currency: saleDoc.currency, lines: saleDoc.lines.map((l) => ({ sku: l.sku, quantity: l.quantity })), warehouseId: sid(saleDoc.warehouseId) };
  await emitCommerceEvent({ orgId, name: "sale.completed", entityId: saleDoc._id, actorEmail, correlationId: cid, idempotencyKey: idem, payload });
  await emitCommerceEvent({ orgId, name: "payment.recorded", entityId: saleDoc._id, actorEmail, correlationId: cid, idempotencyKey: `${idem}:pay`, payload: { saleNumber: saleDoc.saleNumber, tenders: saleDoc.tenders.map((t) => ({ method: t.method, amount: fromMinor(t.amountMinor), manual: true })) } });
  return { sale: saleView(saleDoc) };
}

// ---------------------------------------------------------------- views, receipts, parked carts
export function saleView(s) {
  const m = (v) => fromMinor(v || 0);
  return {
    id: sid(s._id), saleNumber: s.saleNumber, status: s.status, channel: s.channel, currency: s.currency, taxMode: s.taxMode,
    warehouseId: sid(s.warehouseId), registerId: sid(s.registerId), shiftId: sid(s.shiftId), customerId: sid(s.contactId), cashier: s.cashierEmail,
    lines: s.lines.map((l) => ({ productId: sid(l.productId), sku: l.sku, name: l.name, quantity: l.quantity, returnedQty: l.returnedQty || 0, unitPrice: m(l.unitPriceMinor), discount: m(l.lineDiscountMinor + l.orderShareMinor), net: m(l.netMinor), tax: m(l.taxMinor), total: m(l.grossMinor), taxCategory: l.taxCategory, taxRate: l.taxRate, note: l.note || null })),
    totals: { subtotal: m(s.totals.subtotalMinor), discounts: m(s.totals.discountMinor), net: m(s.totals.netMinor), tax: m(s.totals.taxMinor), total: m(s.totals.totalMinor), taxBreakdown: s.totals.taxBreakdown },
    tenders: s.tenders.map((t) => ({ method: t.method, amount: m(t.amountMinor), reference: t.reference, manual: true, label: "Recorded manually" })), change: m(s.changeMinor), cashRounding: m(s.cashRoundingMinor),
    refunded: m(s.refundedMinor), approvedBy: s.approval?.decidedBy || null, notes: s.notes || null, completedAt: s.completedAt, exchangeOf: sid(s.exchangeOf),
    promotions: (s.promotions || []).map((p) => ({ name: p.name, code: p.code || null, discount: m(p.discountMinor) })), member: s.member || null,
    loyalty: s.loyalty ? { redeemedPoints: s.loyalty.redeemedPoints || 0, redeemedValue: m(s.loyalty.redeemedValueMinor || 0), earnedPoints: s.loyalty.earnedPoints || 0, tier: s.loyalty.tier || null } : null,
    giftCards: s.lines.filter((l) => l.giftCardLast4).map((l) => ({ last4: l.giftCardLast4, amount: m(l.grossMinor) })),
    refunds: (s.refunds || []).map((r) => ({ refundNumber: r.refundNumber, total: m(r.totalMinor), reason: r.reason, processedBy: r.processedBy, createdAt: r.createdAt, exchangeSaleId: sid(r.exchangeSaleId) })),
    voided: s.status === "VOIDED" ? { at: s.voidedAt, by: s.voidedBy, reason: s.voidReason, approvedBy: s.voidApproval?.decidedBy || null } : null,
  };
}
export async function getSale({ orgId, membership, saleId }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  const { salesOrders } = await getOrgCollections(); const s = await salesOrders.findOne({ _id: oid(saleId), orgId: oid(orgId), channel: "POS" });
  return s ? { sale: saleView(s) } : fail("Sale not found.", 404);
}
export async function findSaleByNumber({ orgId, membership, saleNumber }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  const { salesOrders } = await getOrgCollections(); const n = clean(saleNumber, 60).toUpperCase(); const s = await salesOrders.findOne({ orgId: oid(orgId), channel: "POS", $or: [{ saleNumber: n }, { "offline.receiptNumber": n }] }); // offline receipts (OFF-...) are found too
  return s ? { sale: saleView(s) } : fail("Sale not found.", 404);
}
export async function listSales({ orgId, membership, from, to, warehouseId, shiftId, limit = 100 }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  const { salesOrders } = await getOrgCollections(); const q = { orgId: oid(orgId), channel: "POS" };
  if (from || to) q.completedAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  if (warehouseId) q.warehouseId = oid(warehouseId); else Object.assign(q, scopeFilter(membership, "warehouseId")); if (shiftId) q.shiftId = oid(shiftId);
  return { sales: (await salesOrders.find(q).sort({ completedAt: -1 }).limit(Math.min(500, limit)).toArray()).map(saleView) };
}
/** Receipt data for print/download/email: the company, the sale and the return policy. Built only from the stored sale,
 *  so the receipt always matches the transaction. */
export async function receiptFor({ orgId, membership, saleId }) {
  const r = await getSale({ orgId, membership, saleId }); if (r.error) return r;
  const { orgs, warehouses } = await getOrgCollections(); const org = await orgs.findOne({ _id: oid(orgId) }, { projection: { name: 1 } });
  const wh = await warehouses.findOne({ _id: oid(r.sale.warehouseId), orgId: oid(orgId) }, { projection: { name: 1, address: 1 } });
  const settings = await getSettings(orgId);
  return { receipt: { company: org?.name || "", location: wh?.name || "", ...r.sale, footer: settings.receiptFooter || "", returnPolicy: settings.returnPolicy.text } };
}
export async function parkSale({ orgId, membership, actorEmail, input, label }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  if (!Array.isArray(input?.lines) || !input.lines.length) return fail("Nothing to park.");
  await ensureCommerceIndexes(); const c = await ccol();
  const { tenders, idempotencyKey, approvalId, ...cart } = input;
  const r = await c.insertOne({ orgId: oid(orgId), kind: PARKED_KIND, label: clean(label, 80) || null, cart, parkedBy: actorEmail, createdAt: nowIso() });
  return { parkedId: sid(r.insertedId) };
}
export async function listParked({ orgId, membership }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  const c = await ccol();
  return { parked: (await c.find({ orgId: oid(orgId), kind: PARKED_KIND }).sort({ createdAt: -1 }).limit(100).toArray()).map((p) => ({ id: sid(p._id), label: p.label, cart: p.cart, parkedBy: p.parkedBy, createdAt: p.createdAt, lines: p.cart.lines.length })) };
}
export async function discardParked({ orgId, membership, parkedId }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  const c = await ccol(); const r = await c.deleteOne({ _id: oid(parkedId), orgId: oid(orgId), kind: PARKED_KIND });
  return r.deletedCount ? { ok: true } : fail("Parked sale not found.", 404);
}
export const newIdempotencyKey = () => `pos_${randomBytes(12).toString("hex")}`;
