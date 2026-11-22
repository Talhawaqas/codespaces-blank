// src/lib/growth/giftcards.js -- Inaya Commerce Phase 4 (Master SOW 8.9): gift cards and store credit.
//
// Owner policy (22 Nov 2026): balances are a LIABILITY ("Gift card & store credit liability", 2300) -- selling a gift card
// or giving store credit is not revenue; it becomes a sale only when spent. No expiry unless the company sets one where
// its law allows. Unused balances are never turned into income automatically: a manager can do it ("breakage") with a
// reason, and someone else must approve.
//
//   GIFT_CARD     sold at the till as a GIFT_CARD product line (the price entered is the value; no tax; no stock). The card
//                 and its code are created inside the sale transaction; the ledger credits the liability, not sales.
//   STORE_CREDIT  one account per customer, credited by a return refunded "to store credit" and spent by choosing the
//                 customer at the till.
// Redemption is a tender (GIFT_CARD with the code, STORE_CREDIT for the chosen customer): a guarded decrement inside the
// sale transaction (never below zero), partial redemption allowed; refunds can go back to the same card. Codes are
// 16 random characters shown ONCE (printed on the receipt), stored only as a keyed hash plus the last 4; balance lookups
// and failed redemptions are rate-limited and audited. Lost/stolen: block the card and move its balance to a new one.
// Storage: calendar_records kinds g_card (balance) and g_card_tx (every movement, idempotent).
import { createHmac, randomBytes } from "node:crypto";
import { ccol, ensureCommerceIndexes, fail, clean, nowIso, oid, sid, commerceAccess, commerceRoleOf, audit, toMinor, fromMinor } from "../commerce/store.js";
import { getOrgCollections } from "../orgs.js";

export const KINDS = { card: "g_card", tx: "g_card_tx", breakage: "g_breakage" };
const ALPH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const secret = () => process.env.GIFT_CARD_SECRET || process.env.INTEGRATION_ENCRYPTION_KEY || process.env.NEXTAUTH_SECRET || "inaya-gift-card-dev-secret";
export const hashCode = (orgId, code) => createHmac("sha256", secret()).update(`${sid(orgId)}:${String(code).toUpperCase().replace(/[^A-Z0-9]/g, "")}`).digest("hex");
export function newCode() { const b = randomBytes(16); let s = ""; for (const x of b) s += ALPH[x % ALPH.length]; return s.match(/.{4}/g).join("-"); }
const cardView = (k) => ({ id: sid(k._id), type: k.type, last4: k.last4, balance: fromMinor(k.balanceMinor), initial: fromMinor(k.initialMinor), currency: k.currency, status: k.status, customerId: sid(k.customerId), expiresAt: k.expiresAt || null, issuedAt: k.createdAt, replacedBy: sid(k.replacedBy) });

async function tx(c, doc, session) { try { await c.insertOne({ kind: KINDS.tx, at: nowIso(), ...doc }, { session }); return true; } catch (e) { if (e?.code === 11000) return false; throw e; } }

/** Inside the sale transaction: a GIFT_CARD line issues a card worth the line amount. Returns the code (shown once). */
export async function issueCardFromSale({ orgId, sale, lineIndex, amountMinor, currency, customerId, expiryMonths = null, session }) {
  await ensureCommerceIndexes(); const c = await ccol(); const o = oid(orgId);
  const code = newCode(); const now = nowIso();
  const card = { orgId: o, kind: KINDS.card, type: "GIFT_CARD", codeHash: hashCode(orgId, code), last4: code.slice(-4), initialMinor: amountMinor, balanceMinor: amountMinor, currency, status: "ACTIVE", customerId: customerId || null, saleId: sale._id, expiresAt: expiryMonths ? new Date(Date.now() + expiryMonths * 30 * 86400000).toISOString() : null, createdAt: now };
  const r = await c.insertOne(card, { session });
  await tx(c, { orgId: o, cardId: r.insertedId, type: "ISSUE", amountMinor, saleId: sale._id, idem: `issue:${sid(sale._id)}:${lineIndex}` }, session);
  return { cardId: sid(r.insertedId), code, last4: card.last4 };
}
async function storeCreditAccount(c, orgId, customerId, currency, session) {
  const o = oid(orgId);
  let k = await c.findOne({ orgId: o, kind: KINDS.card, type: "STORE_CREDIT", customerId: oid(customerId), status: "ACTIVE" }, { session });
  if (!k) { const code = newCode(); const r = await c.insertOne({ orgId: o, kind: KINDS.card, type: "STORE_CREDIT", codeHash: hashCode(orgId, code), last4: code.slice(-4), initialMinor: 0, balanceMinor: 0, currency, status: "ACTIVE", customerId: oid(customerId), createdAt: nowIso() }, { session }); k = await c.findOne({ _id: r.insertedId }, { session }); }
  return k;
}
/** Redeem a tender inside the sale transaction. tender: { method: GIFT_CARD, code } | { method: STORE_CREDIT } (uses the sale's customer). */
export async function redeemTender({ orgId, sale, tender, amountMinor, customerId, idem, session }) {
  const c = await ccol(); const o = oid(orgId); let card;
  if (tender.method === "GIFT_CARD") {
    card = await c.findOne({ orgId: o, kind: KINDS.card, type: "GIFT_CARD", codeHash: hashCode(orgId, tender.code || "") }, { session });
    if (!card) { await noteFailure(orgId, "redeem"); throw Object.assign(new Error("Gift card not recognised."), { status: 404, code: "CARD_UNKNOWN" }); }
  } else {
    if (!customerId) throw Object.assign(new Error("Choose the customer to use their store credit."), { status: 400, code: "CUSTOMER_REQUIRED" });
    card = await c.findOne({ orgId: o, kind: KINDS.card, type: "STORE_CREDIT", customerId: oid(customerId), status: "ACTIVE" }, { session });
    if (!card) throw Object.assign(new Error("This customer has no store credit."), { status: 409, code: "NO_CREDIT" });
  }
  if (card.status !== "ACTIVE") throw Object.assign(new Error(`This card is ${card.status.toLowerCase()}.`), { status: 409, code: "CARD_INACTIVE" });
  if (card.expiresAt && card.expiresAt <= nowIso()) throw Object.assign(new Error("This gift card has expired."), { status: 409, code: "CARD_EXPIRED" });
  const r = await c.findOneAndUpdate({ _id: card._id, status: "ACTIVE", balanceMinor: { $gte: amountMinor } }, { $inc: { balanceMinor: -amountMinor } }, { session, returnDocument: "after" });
  if (!r) throw Object.assign(new Error(`Only ${fromMinor(card.balanceMinor)} is left on this card.`), { status: 409, code: "CARD_SHORT" });
  await tx(c, { orgId: o, cardId: card._id, type: "REDEEM", amountMinor: -amountMinor, saleId: sale._id, idem }, session);
  return { cardId: card._id, last4: card.last4, balanceAfterMinor: r.balanceMinor };
}
/** A refund paid to store credit (customer account) or back to a gift card (the card the sale used). */
export async function creditFromRefund({ orgId, sale, method, amountMinor, cardId = null, currency, refundNumber, session }) {
  const c = await ccol(); const o = oid(orgId); let card;
  if (method === "STORE_CREDIT") { if (!sale.contactId) throw Object.assign(new Error("Store credit needs a customer on the sale."), { status: 400, code: "CUSTOMER_REQUIRED" }); card = await storeCreditAccount(c, orgId, sale.contactId, currency, session); }
  else { card = await c.findOne({ _id: oid(cardId), orgId: o, kind: KINDS.card }, { session }); if (!card) throw Object.assign(new Error("The original gift card wasn't found."), { status: 404 }); if (card.status === "BLOCKED") card = await c.findOne({ _id: card.replacedBy, orgId: o }, { session }) || card; }
  await c.updateOne({ _id: card._id }, { $inc: { balanceMinor: amountMinor }, ...(card.status === "EXHAUSTED" ? { $set: { status: "ACTIVE" } } : {}) }, { session });
  await tx(c, { orgId: o, cardId: card._id, type: method === "STORE_CREDIT" ? "CREDIT" : "REFUND", amountMinor, saleId: sale._id, refundNumber, idem: `credit:${sid(sale._id)}:${refundNumber}:${sid(card._id)}` }, session);
  return { cardId: sid(card._id), last4: card.last4 };
}
/** A voided GIFT_CARD sale cancels the cards it issued (only while unspent). */
export async function cancelIssuedCards({ orgId, saleId, session }) {
  const c = await ccol(); const o = oid(orgId);
  for (const k of await c.find({ orgId: o, kind: KINDS.card, type: "GIFT_CARD", saleId: oid(saleId) }, { session }).toArray()) {
    if (k.balanceMinor !== k.initialMinor) throw Object.assign(new Error(`Gift card ••${k.last4} from this sale has been used, so the sale can't be voided. Use a return.`), { status: 409, code: "CARD_USED" });
    await c.updateOne({ _id: k._id }, { $set: { status: "CANCELLED", balanceMinor: 0 } }, { session });
    await tx(c, { orgId: o, cardId: k._id, type: "CANCEL", amountMinor: -k.initialMinor, saleId: oid(saleId), idem: `cancel:${sid(k._id)}` }, session);
  }
}

const failures = new Map();
async function noteFailure(orgId, what) { const k = `${sid(orgId)}:${what}`; const now = Date.now(); const list = (failures.get(k) || []).filter((t) => now - t < 3600000); list.push(now); failures.set(k, list); if (list.length === 20) await audit({ orgId, actorEmail: "system", recordType: "GIFT_CARD", recordId: orgId, action: "GIFT_CARD_FAILED_ATTEMPTS", newState: { what, lastHour: list.length } }); return list.length; }
/** Balance enquiry by code (at the till or by the customer through staff); rate-limited per company. */
export async function cardBalance({ orgId, membership, code }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  const k = `${sid(orgId)}:lookup`; if ((failures.get(k) || []).filter((t) => Date.now() - t < 3600000).length >= 30) return fail("Too many failed lookups. Try again later.", 429, "RATE_LIMITED");
  const c = await ccol(); const card = await c.findOne({ orgId: oid(orgId), kind: KINDS.card, codeHash: hashCode(orgId, code || "") });
  if (!card) { await noteFailure(orgId, "lookup"); return fail("Gift card not recognised.", 404); }
  return { card: cardView(card) };
}
export async function customerCards({ orgId, customerId }) { const c = await ccol(); return (await c.find({ orgId: oid(orgId), kind: KINDS.card, customerId: oid(customerId) }).toArray()).map(cardView); }
/** Lost or stolen: block the card (by code, or by id for a card on file) and move the remaining balance to a new card. */
export async function replaceCard({ orgId, membership, actorEmail, code, cardId, reason }) {
  const denied = await commerceAccess({ orgId, membership, need: "supervise" }); if (denied) return denied;
  const why = clean(reason, 300); if (!why || why.length < 3) return fail("Give a reason (e.g. reported lost).");
  const c = await ccol(); const o = oid(orgId);
  const card = cardId ? await c.findOne({ _id: oid(cardId), orgId: o, kind: KINDS.card }) : await c.findOne({ orgId: o, kind: KINDS.card, codeHash: hashCode(orgId, code || "") });
  if (!card || card.status !== "ACTIVE") return fail("Active card not found.", 404);
  const newC = newCode(); const now = nowIso(); let newId;
  const { withStockTransaction } = await import("../inventory.js");
  await withStockTransaction(async (session) => {
    const blocked = await c.findOneAndUpdate({ _id: card._id, status: "ACTIVE" }, { $set: { status: "BLOCKED", blockedAt: now, blockReason: why, balanceMinor: 0 } }, { session, returnDocument: "before" });
    if (!blocked) throw Object.assign(new Error("Card changed; reload."), { status: 409 });
    const r = await c.insertOne({ orgId: o, kind: KINDS.card, type: card.type, codeHash: hashCode(orgId, newC), last4: newC.slice(-4), initialMinor: blocked.balanceMinor, balanceMinor: blocked.balanceMinor, currency: card.currency, status: "ACTIVE", customerId: card.customerId || null, replaces: card._id, expiresAt: card.expiresAt || null, createdAt: now }, { session });
    newId = r.insertedId; await c.updateOne({ _id: card._id }, { $set: { replacedBy: newId } }, { session });
    await tx(c, { orgId: o, cardId: card._id, type: "TRANSFER_OUT", amountMinor: -blocked.balanceMinor, to: newId, idem: `xfer-out:${sid(card._id)}` }, session);
    await tx(c, { orgId: o, cardId: newId, type: "TRANSFER_IN", amountMinor: blocked.balanceMinor, from: card._id, idem: `xfer-in:${sid(newId)}` }, session);
  });
  await audit({ orgId, actorEmail, recordType: "GIFT_CARD", recordId: card._id, action: "GIFT_CARD_REPLACED", newState: { from: card.last4, to: newC.slice(-4), reason: why } });
  return { newCard: { id: sid(newId), code: newC, last4: newC.slice(-4) } };
}
/** Breakage: write off an unused balance as income -- requested by one manager with a reason, approved by another. */
export async function requestBreakage({ orgId, membership, actorEmail, cardId, reason }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const why = clean(reason, 300); if (!why || why.length < 10) return fail("Explain why this balance is written off (at least 10 characters).");
  const c = await ccol(); const card = await c.findOne({ _id: oid(cardId), orgId: oid(orgId), kind: KINDS.card });
  if (!card || !(card.balanceMinor > 0)) return fail("Nothing to write off.", 404);
  const r = await c.insertOne({ orgId: oid(orgId), kind: KINDS.breakage, cardId: card._id, amountMinor: card.balanceMinor, reason: why, status: "PENDING", requestedBy: actorEmail, createdAt: nowIso() });
  return { requestId: sid(r.insertedId), amount: fromMinor(card.balanceMinor) };
}
export async function decideBreakage({ orgId, membership, actorEmail, requestId, approve }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const c = await ccol(); const o = oid(orgId); const q = await c.findOne({ _id: oid(requestId), orgId: o, kind: KINDS.breakage, status: "PENDING" });
  if (!q) return fail("Request not found or already decided.", 404);
  if (q.requestedBy === actorEmail) return fail("Another manager must approve a write-off you requested.", 403, "SELF_APPROVAL");
  if (!approve) { await c.updateOne({ _id: q._id }, { $set: { status: "REJECTED", decidedBy: actorEmail, decidedAt: nowIso() } }); return { status: "REJECTED" }; }
  const { withStockTransaction } = await import("../inventory.js");
  await withStockTransaction(async (session) => {
    const k = await c.findOneAndUpdate({ _id: q.cardId, balanceMinor: { $gte: q.amountMinor } }, { $inc: { balanceMinor: -q.amountMinor }, $set: { status: "EXHAUSTED" } }, { session });
    if (!k) throw Object.assign(new Error("The balance changed; ask again."), { status: 409 });
    await tx(c, { orgId: o, cardId: q.cardId, type: "BREAKAGE", amountMinor: -q.amountMinor, breakageId: q._id, idem: `breakage:${sid(q._id)}` }, session);
    await c.updateOne({ _id: q._id }, { $set: { status: "APPROVED", decidedBy: actorEmail, decidedAt: nowIso() } }, { session });
  });
  await audit({ orgId, actorEmail, recordType: "GIFT_CARD", recordId: q.cardId, action: "GIFT_CARD_BREAKAGE", newState: { amount: fromMinor(q.amountMinor), reason: q.reason, requestedBy: q.requestedBy } });
  return { status: "APPROVED" };
}
export async function cardLiability({ orgId, membership }) {
  const denied = await commerceAccess({ orgId, membership, need: "supervise" }); if (denied) return denied;
  const c = await ccol(); const rows = await c.aggregate([{ $match: { orgId: oid(orgId), kind: KINDS.card, status: "ACTIVE" } }, { $group: { _id: "$type", n: { $sum: 1 }, bal: { $sum: "$balanceMinor" } } }]).toArray();
  const pend = await c.find({ orgId: oid(orgId), kind: KINDS.breakage, status: "PENDING" }).toArray();
  return { byType: rows.map((r) => ({ type: r._id, cards: r.n, balance: fromMinor(r.bal) })), total: fromMinor(rows.reduce((s, r) => s + r.bal, 0)), pendingBreakage: pend.map((p) => ({ id: sid(p._id), amount: fromMinor(p.amountMinor), reason: p.reason, requestedBy: p.requestedBy })), note: "Balances owed to customers (a liability until spent)." };
}
