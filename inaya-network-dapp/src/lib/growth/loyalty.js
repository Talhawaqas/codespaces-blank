// src/lib/growth/loyalty.js -- Inaya Commerce Phase 4 (Master SOW 8.7, 8.8): loyalty points, tiers and memberships.
//
// Owner policy (22 Nov 2026): points live in a POINTS LEDGER -- every earn, redemption, reversal, expiry, bonus and manual
// adjustment is an entry (never a bare mutable balance) -- and a LIABILITY REPORT shows what outstanding points are worth.
// Nothing is posted to the accounting books.
//
//   earn      = floor(net amount paid / earnUnit) x pointsPerUnit x (tier multiplier) x (category multipliers), after
//               discounts and redemptions, for sales with a customer; once per sale (idempotency key)
//   redeem    = points used as a discount on a sale: minimum, maximum % of the sale, never more than the balance
//               (checked again inside the sale transaction), at pointValue each
//   reverse   = a refund takes back the points it earned and gives back the points it used, in proportion; a void
//               reverses all
//   expire    = points older than expiryMonths that were not used (oldest first), by the nightly job; 0 = never
//   adjust    = manager only, with a reason, never by the person whose account it is; daily earn cap as an abuse control
// Tiers: decided by spend in the last 12 months (thresholds in settings); a tier multiplies earning. Memberships: a plan
// (fee recorded manually -- recurring card billing needs a payment provider, separately approved), start/end, status,
// benefits (member discount %, points multiplier), branches; members get the discount automatically at the till.
// Storage: calendar_records kinds g_loyalty_settings, g_points (ledger), g_plan, g_member.
import { ccol, ensureCommerceIndexes, fail, clean, nowIso, oid, sid, commerceAccess, commerceRoleOf, audit, toMinor, fromMinor, getSettings as commerceSettings } from "../commerce/store.js";
import { getOrgCollections } from "../orgs.js";

export const KINDS = { settings: "g_loyalty_settings", points: "g_points", plan: "g_plan", member: "g_member" };
export const DEFAULT_LOYALTY = { enabled: false, earnUnitMinor: 10000, pointsPerUnit: 1, pointValueMinor: 100, minRedeemPoints: 100, maxRedeemPercent: 50, expiryMonths: 12, dailyEarnCap: 100000,
  tiers: [{ name: "Silver", minSpendMinor: 0, multiplier: 1 }, { name: "Gold", minSpendMinor: 10000000, multiplier: 1.25 }, { name: "Platinum", minSpendMinor: 50000000, multiplier: 1.5 }],
  categoryMultipliers: {}, birthdayBonus: 0, signupBonus: 0 };
const DAY = 86400000;

export async function getLoyaltySettings(orgId) { const c = await ccol(); const s = await c.findOne({ orgId: oid(orgId), kind: KINDS.settings }); return { ...DEFAULT_LOYALTY, ...(s?.settings || {}) }; }
export async function updateLoyaltySettings({ orgId, membership, actorEmail, input }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const out = {}; const num = (k, min, max, int = false) => { if (input[k] === undefined) return null; const v = Number(input[k]); if (!(v >= min && v <= max) || (int && !Number.isInteger(v))) return `${k} must be ${min}-${max}.`; out[k] = v; return null; };
  if (input.enabled !== undefined) out.enabled = input.enabled === true;
  const e = num("earnUnitMinor", 1, 1e9, true) || num("pointsPerUnit", 0, 1e6) || num("pointValueMinor", 0, 1e7, true) || num("minRedeemPoints", 0, 1e9, true) || num("maxRedeemPercent", 0, 100) || num("expiryMonths", 0, 120, true) || num("dailyEarnCap", 0, 1e9, true) || num("birthdayBonus", 0, 1e6, true) || num("signupBonus", 0, 1e6, true);
  if (e) return fail(e);
  if (input.tiers !== undefined) { if (!Array.isArray(input.tiers) || !input.tiers.length || input.tiers.length > 6 || !input.tiers.every((t) => clean(t.name, 30) && Number(t.minSpendMinor) >= 0 && Number(t.multiplier) >= 1 && Number(t.multiplier) <= 10)) return fail("Tiers: 1-6 of { name, minSpendMinor, multiplier 1-10 }."); out.tiers = input.tiers.map((t) => ({ name: clean(t.name, 30), minSpendMinor: Number(t.minSpendMinor), multiplier: Number(t.multiplier) })).sort((a, b) => a.minSpendMinor - b.minSpendMinor); }
  if (input.categoryMultipliers !== undefined) { const m = input.categoryMultipliers || {}; if (typeof m !== "object" || Object.keys(m).length > 50 || !Object.values(m).every((v) => Number(v) >= 0 && Number(v) <= 10)) return fail("categoryMultipliers: up to 50 categories, 0-10."); out.categoryMultipliers = Object.fromEntries(Object.entries(m).map(([k, v]) => [clean(k, 80), Number(v)])); }
  await ensureCommerceIndexes(); const c = await ccol(); const now = nowIso();
  await c.updateOne({ orgId: oid(orgId), kind: KINDS.settings }, { $set: Object.fromEntries(Object.entries(out).map(([k, v]) => [`settings.${k}`, v])), $setOnInsert: { orgId: oid(orgId), kind: KINDS.settings, createdAt: now } }, { upsert: true });
  await audit({ orgId, actorEmail, recordType: "LOYALTY_SETTINGS", recordId: orgId, action: "LOYALTY_SETTINGS_CHANGED", newState: out });
  return { settings: await getLoyaltySettings(orgId) };
}

/** Balance and the breakdown, straight from the ledger. */
export async function pointsBalance(orgId, customerId, session = null) {
  const c = await ccol();
  const r = await c.aggregate([{ $match: { orgId: oid(orgId), kind: KINDS.points, customerId: oid(customerId) } }, { $group: { _id: "$type", n: { $sum: "$points" } } }], { session }).toArray();
  const by = Object.fromEntries(r.map((x) => [x._id, x.n])); return { balance: r.reduce((s, x) => s + x.n, 0), byType: by };
}
async function spendLast12Months(orgId, customerId, session = null) {
  const { salesOrders } = await getOrgCollections();
  const since = new Date(Date.now() - 365 * DAY).toISOString();
  const r = await salesOrders.aggregate([{ $match: { orgId: oid(orgId), contactId: oid(customerId), channel: "POS", status: { $in: ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"] }, completedAt: { $gte: since } } }, { $group: { _id: null, t: { $sum: { $subtract: ["$totals.totalMinor", { $ifNull: ["$refundedMinor", 0] }] } } } }], { session }).toArray();
  return r[0]?.t || 0;
}
export function tierFor(settings, spendMinor) { let t = settings.tiers[0]; for (const x of settings.tiers) if (spendMinor >= x.minSpendMinor) t = x; return t; }
export async function activeMembership(orgId, customerId, session = null) {
  const c = await ccol(); const now = nowIso();
  const m = await c.findOne({ orgId: oid(orgId), kind: KINDS.member, customerId: oid(customerId), status: "ACTIVE", startsAt: { $lte: now }, endsAt: { $gt: now } }, { session });
  if (!m) return null; const plan = await c.findOne({ _id: m.planId, orgId: oid(orgId), kind: KINDS.plan }, { session }); return plan ? { ...m, plan } : null;
}

/** For the till: how many points this customer may use on a cart worth `totalMinor`, and what they're worth. */
export async function redemptionLimit({ orgId, customerId, totalMinor, session = null }) {
  const s = await getLoyaltySettings(orgId); if (!s.enabled || !customerId) return { maxPoints: 0, balance: 0, pointValueMinor: s.pointValueMinor };
  const { balance } = await pointsBalance(orgId, customerId, session);
  const capByValue = s.pointValueMinor ? Math.floor((totalMinor * s.maxRedeemPercent) / 100 / s.pointValueMinor) : 0;
  const maxPoints = Math.max(0, Math.min(balance, capByValue));
  return { balance, maxPoints: maxPoints >= s.minRedeemPoints ? maxPoints : 0, minRedeemPoints: s.minRedeemPoints, pointValueMinor: s.pointValueMinor };
}

async function insertEntry(c, e, session) {
  try { await c.insertOne({ kind: KINDS.points, at: nowIso(), ...e }, { session }); return true; }
  catch (err) { if (err?.code === 11000) return false; throw err; } // idempotent: the same event never posts twice
}
/** Inside the sale transaction: redeem (already validated by pricing) and earn. */
export async function postSalePoints({ orgId, sale, lines, redeemPoints = 0, session }) {
  const s = await getLoyaltySettings(orgId); if (!s.enabled || !sale.contactId) return { earned: 0, redeemed: 0 };
  const c = await ccol(); const o = oid(orgId); let redeemed = 0;
  if (redeemPoints > 0) {
    const { balance } = await pointsBalance(orgId, sale.contactId, session);
    if (redeemPoints > balance) throw Object.assign(new Error("The customer no longer has enough points."), { status: 409, code: "POINTS_SHORT" });
    await insertEntry(c, { orgId: o, customerId: sale.contactId, type: "REDEEM", points: -redeemPoints, saleId: sale._id, idem: `redeem:${sid(sale._id)}` }, session); redeemed = redeemPoints;
  }
  const tier = tierFor(s, await spendLast12Months(orgId, sale.contactId, session));
  const member = await activeMembership(orgId, sale.contactId, session);
  const mult = tier.multiplier * (member?.plan?.pointsMultiplier || 1);
  let pts = 0;
  for (const l of lines) { const catM = l.category && s.categoryMultipliers[l.category] !== undefined ? s.categoryMultipliers[l.category] : 1; pts += (l.paidMinor / s.earnUnitMinor) * s.pointsPerUnit * catM; }
  let earned = Math.floor(pts * mult);
  if (earned > 0 && s.dailyEarnCap) {
    const since = new Date(Date.now() - DAY).toISOString();
    const today = (await c.aggregate([{ $match: { orgId: o, kind: KINDS.points, customerId: sale.contactId, type: "EARN", at: { $gte: since } } }, { $group: { _id: null, n: { $sum: "$points" } } }], { session }).toArray())[0]?.n || 0;
    earned = Math.max(0, Math.min(earned, s.dailyEarnCap - today));
  }
  { const { crmContacts } = await getOrgCollections(); await crmContacts.updateOne({ _id: sale.contactId, orgId: o }, { $set: { "loyalty.tier": tier.name } }, { session }); }
  if (earned > 0) await insertEntry(c, { orgId: o, customerId: sale.contactId, type: "EARN", points: earned, saleId: sale._id, tier: tier.name, expiresAt: s.expiryMonths ? new Date(Date.now() + s.expiryMonths * 30 * DAY).toISOString() : null, idem: `earn:${sid(sale._id)}` }, session);
  return { earned, redeemed, tier: tier.name };
}
/** A refund (share = refunded / total) or a void (share = 1): take back earned points, give back redeemed points. */
export async function reverseSalePoints({ orgId, sale, share, refundNumber = null, session }) {
  const c = await ccol(); const o = oid(orgId); if (!sale.contactId) return;
  const rows = await c.find({ orgId: o, kind: KINDS.points, saleId: sale._id }, { session }).toArray();
  const earned = rows.filter((r) => r.type === "EARN").reduce((s, r) => s + r.points, 0), redeemed = -rows.filter((r) => r.type === "REDEEM").reduce((s, r) => s + r.points, 0);
  const prevE = -rows.filter((r) => r.type === "REVERSE_EARN").reduce((s, r) => s + r.points, 0), prevR = rows.filter((r) => r.type === "REVERSE_REDEEM").reduce((s, r) => s + r.points, 0);
  const takeE = Math.min(earned - prevE, Math.round(earned * share)), giveR = Math.min(redeemed - prevR, Math.round(redeemed * share));
  const tag = refundNumber || "void";
  if (takeE > 0) await insertEntry(c, { orgId: o, customerId: sale.contactId, type: "REVERSE_EARN", points: -takeE, saleId: sale._id, refundNumber, idem: `rev-earn:${sid(sale._id)}:${tag}` }, session);
  if (giveR > 0) await insertEntry(c, { orgId: o, customerId: sale.contactId, type: "REVERSE_REDEEM", points: giveR, saleId: sale._id, refundNumber, expiresAt: null, idem: `rev-redeem:${sid(sale._id)}:${tag}` }, session);
}
export async function adjustPoints({ orgId, membership, actorEmail, customerId, points, reason }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const why = clean(reason, 300); if (!why || why.length < 3) return fail("Give a reason for the adjustment.");
  const p = Number(points); if (!Number.isInteger(p) || p === 0 || Math.abs(p) > 1e7) return fail("Points must be a whole, non-zero number.");
  const { crmContacts } = await getOrgCollections(); const cust = await crmContacts.findOne({ _id: oid(customerId), orgId: oid(orgId) }); if (!cust) return fail("Customer not found.", 404);
  if (cust.email && cust.email.toLowerCase() === String(actorEmail).toLowerCase()) return fail("You can't adjust your own points.", 403, "SELF_ADJUST");
  if (p < 0) { const { balance } = await pointsBalance(orgId, customerId); if (balance + p < 0) return fail(`The balance is only ${balance}.`); }
  const c = await ccol(); await c.insertOne({ orgId: oid(orgId), kind: KINDS.points, customerId: cust._id, type: "ADJUST", points: p, reason: why, by: actorEmail, at: nowIso(), idem: `adj:${Date.now()}:${Math.random().toString(36).slice(2)}` });
  await audit({ orgId, actorEmail, recordType: "LOYALTY", recordId: cust._id, action: "POINTS_ADJUSTED", newState: { points: p, reason: why } });
  return pointsBalance(orgId, customerId);
}
/** Nightly: oldest-first expiry of unused points (idempotent per customer per day). */
export async function expirePoints({ orgId }) {
  const c = await ccol(); const o = oid(orgId); const now = nowIso(); let total = 0;
  const custs = await c.distinct("customerId", { orgId: o, kind: KINDS.points, type: "EARN", expiresAt: { $lte: now } });
  for (const cid of custs) {
    const rows = await c.find({ orgId: o, kind: KINDS.points, customerId: cid }).toArray();
    const expiredEarn = rows.filter((r) => (r.type === "EARN" || r.type === "BONUS") && r.expiresAt && r.expiresAt <= now).reduce((s, r) => s + r.points, 0);
    const used = -rows.filter((r) => r.points < 0).reduce((s, r) => s + r.points, 0); // redeemed, reversed, expired, negative adjustments: consume oldest points first
    const due = Math.min(expiredEarn - used, rows.reduce((s, r) => s + r.points, 0));
    if (due > 0 && await insertEntry(c, { orgId: o, customerId: cid, type: "EXPIRE", points: -due, idem: `expire:${sid(cid)}:${now.slice(0, 10)}` }, null)) total += due;
  }
  return { expiredPoints: total };
}
export async function customerLoyalty({ orgId, membership, customerId }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  const s = await getLoyaltySettings(orgId); const c = await ccol();
  const b = await pointsBalance(orgId, customerId); const spend = await spendLast12Months(orgId, customerId); const tier = tierFor(s, spend); const next = s.tiers.find((t) => t.minSpendMinor > spend) || null;
  const ledger = await c.find({ orgId: oid(orgId), kind: KINDS.points, customerId: oid(customerId) }).sort({ at: -1 }).limit(100).toArray();
  const member = await activeMembership(orgId, customerId);
  return { enabled: s.enabled, balance: b.balance, value: fromMinor(b.balance * s.pointValueMinor), tier: tier.name, spend12m: fromMinor(spend), nextTier: next ? { name: next.name, needed: fromMinor(next.minSpendMinor - spend) } : null,
    member: member ? { plan: member.plan.name, endsAt: member.endsAt } : null, ledger: ledger.map((r) => ({ type: r.type, points: r.points, at: r.at, saleId: sid(r.saleId), refundNumber: r.refundNumber || null, reason: r.reason || null, by: r.by || null, expiresAt: r.expiresAt || null })) };
}
/** Liability report: outstanding points and their redemption value, by tier, plus this month's movements. */
export async function loyaltyLiability({ orgId, membership }) {
  const denied = await commerceAccess({ orgId, membership, need: "supervise" }); if (denied) return denied;
  const s = await getLoyaltySettings(orgId); const c = await ccol(); const o = oid(orgId);
  const bal = await c.aggregate([{ $match: { orgId: o, kind: KINDS.points } }, { $group: { _id: "$customerId", n: { $sum: "$points" } } }, { $match: { n: { $gt: 0 } } }]).toArray();
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const month = await c.aggregate([{ $match: { orgId: o, kind: KINDS.points, at: { $gte: monthStart } } }, { $group: { _id: "$type", n: { $sum: "$points" } } }]).toArray();
  const outstanding = bal.reduce((x, r) => x + r.n, 0);
  return { members: bal.length, outstandingPoints: outstanding, liabilityValue: fromMinor(outstanding * s.pointValueMinor), pointValue: fromMinor(s.pointValueMinor), thisMonth: Object.fromEntries(month.map((m) => [m._id, m.n])),
    note: "Estimated value of unused points at the current redemption value. Per company policy this is reported, not posted to the books." };
}

// ---------------------------------------------------------------- memberships (8.8)
export async function savePlan({ orgId, membership, actorEmail, id, input }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const name = clean(input.name, 60); if (!name) return fail("A plan needs a name.");
  const fee = toMinor(input.fee ?? 0), months = Number(input.durationMonths), disc = Number(input.discountPercent ?? 0), mult = Number(input.pointsMultiplier ?? 1);
  if (!(fee >= 0) || !(Number.isInteger(months) && months >= 1 && months <= 60) || !(disc >= 0 && disc <= 50) || !(mult >= 1 && mult <= 10)) return fail("Fee >= 0, 1-60 months, discount 0-50%, points multiplier 1-10.");
  const doc = { name, feeMinor: fee, durationMonths: months, discountPercent: disc, pointsMultiplier: mult, branchIds: Array.isArray(input.branchIds) ? input.branchIds.map(String) : [], cancellationPolicy: clean(input.cancellationPolicy, 500) || "Membership fees are not refundable after 14 days.", active: input.active !== false };
  await ensureCommerceIndexes(); const c = await ccol(); const now = nowIso();
  if (id) { await c.updateOne({ _id: oid(id), orgId: oid(orgId), kind: KINDS.plan }, { $set: { ...doc, updatedAt: now } }); return { id }; }
  const r = await c.insertOne({ orgId: oid(orgId), kind: KINDS.plan, ...doc, createdAt: now, createdBy: actorEmail });
  await audit({ orgId, actorEmail, recordType: "MEMBERSHIP_PLAN", recordId: r.insertedId, action: "PLAN_CREATED", newState: doc });
  return { id: sid(r.insertedId) };
}
export async function listPlans({ orgId }) { const c = await ccol(); return { plans: (await c.find({ orgId: oid(orgId), kind: KINDS.plan }).toArray()).map((p) => ({ id: sid(p._id), name: p.name, fee: fromMinor(p.feeMinor), durationMonths: p.durationMonths, discountPercent: p.discountPercent, pointsMultiplier: p.pointsMultiplier, branchIds: p.branchIds, cancellationPolicy: p.cancellationPolicy, active: p.active })) }; }
/** Join or renew: the fee is recorded manually (method + reference); renewal extends from the current end. */
export async function joinPlan({ orgId, membership, actorEmail, customerId, planId, payment }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  const c = await ccol(); const o = oid(orgId);
  const plan = await c.findOne({ _id: oid(planId), orgId: o, kind: KINDS.plan, active: true }); if (!plan) return fail("Plan not found.", 404);
  const { crmContacts } = await getOrgCollections(); const cust = await crmContacts.findOne({ _id: oid(customerId), orgId: o }); if (!cust) return fail("Customer not found.", 404);
  if (plan.feeMinor > 0) { if (!["CASH", "BANK_TRANSFER", "MANUAL_REFERENCE"].includes(payment?.method)) return fail("Record how the membership fee was paid."); if (payment.method !== "CASH" && !clean(payment.reference, 120)) return fail("Non-cash payments need a reference."); }
  const cur = await activeMembership(orgId, cust._id); const start = cur ? new Date(cur.endsAt) : new Date(); const end = new Date(start); end.setMonth(end.getMonth() + plan.durationMonths);
  const now = nowIso();
  const doc = { orgId: o, kind: KINDS.member, customerId: cust._id, planId: plan._id, planName: plan.name, status: "ACTIVE", startsAt: cur ? cur.startsAt : start.toISOString(), endsAt: end.toISOString(), payments: [{ amountMinor: plan.feeMinor, method: payment?.method || null, reference: clean(payment?.reference, 120) || null, at: now, by: actorEmail, kind: cur ? "RENEWAL" : "JOIN" }], createdAt: now };
  if (cur) await c.updateOne({ _id: cur._id }, { $set: { endsAt: doc.endsAt }, $push: { payments: doc.payments[0] } });
  else await c.insertOne(doc);
  await audit({ orgId, actorEmail, recordType: "MEMBERSHIP", recordId: cust._id, action: cur ? "MEMBERSHIP_RENEWED" : "MEMBERSHIP_STARTED", newState: { plan: plan.name, endsAt: doc.endsAt, fee: fromMinor(plan.feeMinor), method: payment?.method || null } });
  return { member: { plan: plan.name, endsAt: doc.endsAt } };
}
export async function cancelMembership({ orgId, membership, actorEmail, customerId, reason, refund }) {
  const denied = await commerceAccess({ orgId, membership, need: "supervise" }); if (denied) return denied;
  const m = await activeMembership(orgId, customerId); if (!m) return fail("No active membership.", 404);
  const c = await ccol(); await c.updateOne({ _id: m._id }, { $set: { status: "CANCELLED", cancelledAt: nowIso(), cancelReason: clean(reason, 300) || null, refund: refund ? { amountMinor: toMinor(refund.amount), method: refund.method, reference: clean(refund.reference, 120) || null } : null } });
  await audit({ orgId, actorEmail, recordType: "MEMBERSHIP", recordId: oid(customerId), action: "MEMBERSHIP_CANCELLED", newState: { reason, refund: refund || null } });
  return { ok: true };
}
/** Nightly: expire ended memberships; list those ending within 14 days (renewal reminders go through triggers). */
export async function membershipHousekeeping({ orgId }) {
  const c = await ccol(); const o = oid(orgId); const now = nowIso();
  const r = await c.updateMany({ orgId: o, kind: KINDS.member, status: "ACTIVE", endsAt: { $lte: now } }, { $set: { status: "EXPIRED", expiredAt: now } });
  const soon = await c.find({ orgId: o, kind: KINDS.member, status: "ACTIVE", endsAt: { $gt: now, $lte: new Date(Date.now() + 14 * DAY).toISOString() } }).toArray();
  return { expired: r.modifiedCount, endingSoon: soon.map((m) => ({ customerId: sid(m.customerId), plan: m.planName, endsAt: m.endsAt })) };
}
