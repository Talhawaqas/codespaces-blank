// src/lib/commerce/shifts.js -- Inaya Commerce, Batch 3 (Master SOW 6.8): registers, shifts and cash control.
//
// A register (till) belongs to one location. A shift is opened on a register with an opening float by the person
// working it (employee attribution); only ONE shift can be open per register (unique partial index). While it is open:
// sales and refunds made on that register are tied to it, and a supervisor/manager can record cash in / cash out with a
// reason. Closing counts the drawer: expected cash = float + cash taken (cash tendered minus change, voided sales
// excluded) - cash refunded + cash in - cash out; the over/short amount is stored with a snapshot of the shift report.
// Every closed shift goes to a manager for review; a shift beyond the company's tolerance is flagged. Corrections to a
// closed count are manager-only, need a reason and keep the full history (audit of corrections).
// Physical cash drawers and printers are a separate hardware gate (approved decision: no certified hardware).
import { ccol, ensureCommerceIndexes, KINDS, fail, clean, nowIso, oid, sid, commerceAccess, commerceRoleOf, getSettings, nextNumber, audit, emitCommerceEvent, toMinor, fromMinor } from "./store.js";
import { roleCovers } from "./pricing.js";
import { getOrgCollections } from "../orgs.js";
import { scopeFilter, canAddTill } from "../workforce/scope.js";

const m = (v) => fromMinor(v || 0);

// ---------------------------------------------------------------- registers
export async function listRegisters({ orgId, membership }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  await ensureCommerceIndexes(); const c = await ccol(); const o = oid(orgId);
  const regs = await c.find({ orgId: o, kind: KINDS.register, ...scopeFilter(membership, "warehouseId") }).sort({ name: 1 }).toArray();
  const open = await c.find({ orgId: o, kind: KINDS.shift, status: "OPEN" }).toArray();
  return { registers: regs.map((r) => { const sh = open.find((x) => sid(x.registerId) === sid(r._id)); return { id: sid(r._id), code: r.code, name: r.name, warehouseId: sid(r.warehouseId), active: r.active !== false, openShift: sh ? { id: sid(sh._id), shiftNumber: sh.shiftNumber, openedBy: sh.openedBy, openedAt: sh.openedAt } : null }; }) };
}
export async function saveRegister({ orgId, membership, actorEmail, input }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const code = clean(input.code, 20).toUpperCase(); const name = clean(input.name, 80);
  if (!code || !name) return fail("A register needs a code and a name.");
  const { warehouses } = await getOrgCollections(); const o = oid(orgId);
  const wh = await warehouses.findOne({ _id: oid(input.warehouseId), orgId: o }); if (!wh) return fail("Location not found.", 404);
  await ensureCommerceIndexes(); const c = await ccol(); const now = nowIso();
  try {
    if (!input.id) { const lim = await canAddTill(orgId, () => c.countDocuments({ orgId: o, kind: KINDS.register, active: { $ne: false } })); if (lim) return lim; } // plan tills (pricing 23 Nov 2026)
    if (input.id) {
      const before = await c.findOne({ _id: oid(input.id), orgId: o, kind: KINDS.register }); if (!before) return fail("Register not found.", 404);
      if (sid(before.warehouseId) !== sid(wh._id) && await c.findOne({ orgId: o, kind: KINDS.shift, registerId: before._id, status: "OPEN" })) return fail("Close the open shift before moving this register.", 409);
      await c.updateOne({ _id: before._id }, { $set: { code, name, warehouseId: wh._id, active: input.active !== false, updatedAt: now, updatedBy: actorEmail } });
      await audit({ orgId, actorEmail, recordType: "COMMERCE_REGISTER", recordId: before._id, action: "REGISTER_UPDATED", previousState: { code: before.code, name: before.name, warehouseId: sid(before.warehouseId), active: before.active !== false }, newState: { code, name, warehouseId: sid(wh._id), active: input.active !== false } });
      return { id: sid(before._id) };
    }
    const r = await c.insertOne({ orgId: o, kind: KINDS.register, code, name, warehouseId: wh._id, active: true, createdAt: now, createdBy: actorEmail });
    await audit({ orgId, actorEmail, recordType: "COMMERCE_REGISTER", recordId: r.insertedId, action: "REGISTER_CREATED", newState: { code, name, warehouseId: sid(wh._id) } });
    return { id: sid(r.insertedId) };
  } catch (e) { if (e?.code === 11000) return fail("A register with that code already exists.", 409); throw e; }
}

// ---------------------------------------------------------------- shifts
export async function openShift({ orgId, membership, actorEmail, registerId, openingFloat }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  const floatMinor = toMinor(openingFloat ?? 0); if (!(floatMinor >= 0)) return fail("Opening float must be zero or more.");
  await ensureCommerceIndexes(); const c = await ccol(); const o = oid(orgId);
  const reg = await c.findOne({ _id: oid(registerId), orgId: o, kind: KINDS.register, active: { $ne: false } }); if (!reg) return fail("Register not found.", 404);
  const now = nowIso();
  try {
    const shiftNumber = `SH-${String(await nextNumber(orgId, "pos_shift")).padStart(5, "0")}`;
    const r = await c.insertOne({ orgId: o, kind: KINDS.shift, registerId: reg._id, warehouseId: reg.warehouseId, shiftNumber, status: "OPEN", floatMinor, openedBy: actorEmail, openedRole: commerceRoleOf(membership), openedAt: now, review: null, corrections: [] });
    await audit({ orgId, actorEmail, recordType: "COMMERCE_SHIFT", recordId: r.insertedId, action: "SHIFT_OPENED", newState: { shiftNumber, register: reg.code, openingFloat: m(floatMinor) } });
    await emitCommerceEvent({ orgId, name: "shift.opened", entityId: r.insertedId, actorEmail, idempotencyKey: `open:${sid(r.insertedId)}`, payload: { shiftNumber, registerId: sid(reg._id), openingFloat: m(floatMinor) } });
    return { shift: await shiftView(orgId, await c.findOne({ _id: r.insertedId })) };
  } catch (e) { if (e?.code === 11000) return fail("This register already has an open shift.", 409, "SHIFT_OPEN"); throw e; }
}
async function loadShift(orgId, shiftId) { const c = await ccol(); const s = await c.findOne({ _id: oid(shiftId), orgId: oid(orgId), kind: KINDS.shift }); return s ? { shift: s } : fail("Shift not found.", 404); }

export async function cashMove({ orgId, membership, actorEmail, shiftId, type, amount, reason }) {
  const denied = await commerceAccess({ orgId, membership, need: "supervise" }); if (denied) return denied;
  if (!["IN", "OUT"].includes(type)) return fail("type must be IN or OUT.");
  const amt = toMinor(amount); if (!(amt > 0)) return fail("Amount must be positive.");
  const why = clean(reason, 200); if (!why || why.length < 3) return fail("Give a reason for the cash movement.");
  const s = await loadShift(orgId, shiftId); if (s.error) return s; if (s.shift.status !== "OPEN") return fail("This shift is closed.", 409);
  if (type === "OUT") { const sum = await summarize(orgId, s.shift); if (amt > sum.expectedMinor) return fail("That is more cash than the drawer should hold.", 409, "CASH_SHORT"); }
  const c = await ccol(); const now = nowIso();
  const r = await c.insertOne({ orgId: oid(orgId), kind: KINDS.cashMove, shiftId: s.shift._id, registerId: s.shift.registerId, type, amountMinor: amt, reason: why, by: actorEmail, at: now });
  await audit({ orgId, actorEmail, recordType: "COMMERCE_SHIFT", recordId: s.shift._id, action: type === "IN" ? "CASH_IN" : "CASH_OUT", newState: { shiftNumber: s.shift.shiftNumber, amount: m(amt), reason: why } });
  return { id: sid(r.insertedId) };
}

/** The shift report: everything that moved through this register during the shift, by tender and by employee. */
async function summarize(orgId, shift) {
  const { salesOrders } = await getOrgCollections(); const c = await ccol(); const o = oid(orgId);
  const sales = await salesOrders.find({ orgId: o, channel: "POS", shiftId: shift._id }).toArray();
  const refunded = await salesOrders.find({ orgId: o, channel: "POS", "refunds.shiftId": shift._id }).toArray();
  const moves = await c.find({ orgId: o, kind: KINDS.cashMove, shiftId: shift._id }).sort({ at: 1 }).toArray();
  const byTender = {}; const byEmployee = {}; let salesCount = 0, salesMinor = 0, discountMinor = 0, taxMinor = 0, cashIn = 0, voids = 0, voidMinor = 0;
  for (const s of sales) {
    if (s.status === "VOIDED") { voids++; voidMinor += s.totals.totalMinor; continue; }
    salesCount++; salesMinor += s.totals.totalMinor; discountMinor += s.totals.discountMinor || 0; taxMinor += s.totals.taxMinor || 0;
    const e = (byEmployee[s.cashierEmail] ||= { sales: 0, salesMinor: 0, refunds: 0, refundMinor: 0 }); e.sales++; e.salesMinor += s.totals.totalMinor;
    for (const t of s.tenders) { byTender[t.method] = (byTender[t.method] || 0) + t.amountMinor; if (t.method === "CASH") cashIn += t.amountMinor; }
    cashIn -= s.changeMinor || 0; if (s.changeMinor) byTender.CASH = (byTender.CASH || 0) - s.changeMinor;
  }
  let refundCount = 0, refundMinor = 0, cashOutRefunds = 0; const refundTenders = {};
  for (const s of refunded) for (const r of s.refunds || []) {
    if (sid(r.shiftId) !== sid(shift._id)) continue;
    refundCount++; refundMinor += r.totalMinor;
    const e = (byEmployee[r.processedBy] ||= { sales: 0, salesMinor: 0, refunds: 0, refundMinor: 0 }); e.refunds++; e.refundMinor += r.totalMinor;
    for (const t of r.tenders) { refundTenders[t.method] = (refundTenders[t.method] || 0) + t.amountMinor; if (t.method === "CASH") cashOutRefunds += t.amountMinor; }
  }
  const movedIn = moves.filter((x) => x.type === "IN").reduce((s, x) => s + x.amountMinor, 0), movedOut = moves.filter((x) => x.type === "OUT").reduce((s, x) => s + x.amountMinor, 0);
  const expectedMinor = shift.floatMinor + cashIn - cashOutRefunds + movedIn - movedOut;
  return { salesCount, salesMinor, discountMinor, taxMinor, voids, voidMinor, refundCount, refundMinor, byTender, refundTenders, byEmployee, cashSalesMinor: cashIn, cashRefundsMinor: cashOutRefunds, cashInMinor: movedIn, cashOutMinor: movedOut, expectedMinor,
    moves: moves.map((x) => ({ id: sid(x._id), type: x.type, amount: m(x.amountMinor), reason: x.reason, by: x.by, at: x.at })) };
}
const mapMinor = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, m(v)]));
async function shiftView(orgId, sh, withReport = false) {
  const sum = sh.status === "OPEN" || withReport ? (sh.status === "OPEN" ? await summarize(orgId, sh) : sh.summary) : null;
  const report = sum ? { sales: sum.salesCount, salesTotal: m(sum.salesMinor), discounts: m(sum.discountMinor), tax: m(sum.taxMinor), voids: sum.voids, voidTotal: m(sum.voidMinor), refunds: sum.refundCount, refundTotal: m(sum.refundMinor),
    byTender: mapMinor(sum.byTender), refundsByTender: mapMinor(sum.refundTenders), byEmployee: Object.fromEntries(Object.entries(sum.byEmployee).map(([k, v]) => [k, { sales: v.sales, salesTotal: m(v.salesMinor), refunds: v.refunds, refundTotal: m(v.refundMinor) }])),
    cashSales: m(sum.cashSalesMinor), cashRefunds: m(sum.cashRefundsMinor), cashIn: m(sum.cashInMinor), cashOut: m(sum.cashOutMinor), moves: sum.moves } : null;
  return { id: sid(sh._id), shiftNumber: sh.shiftNumber, registerId: sid(sh.registerId), warehouseId: sid(sh.warehouseId), status: sh.status, openingFloat: m(sh.floatMinor), openedBy: sh.openedBy, openedAt: sh.openedAt,
    expected: sum ? m(sum.expectedMinor) : m(sh.expectedMinor), counted: sh.countedMinor === undefined ? null : m(sh.countedMinor), overShort: sh.varianceMinor === undefined ? null : m(sh.varianceMinor), flagged: !!sh.flagged,
    closedBy: sh.closedBy || null, closedAt: sh.closedAt || null, closeNote: sh.closeNote || null, review: sh.review || null, corrections: (sh.corrections || []).map((x) => ({ from: m(x.fromMinor), to: m(x.toMinor), by: x.by, at: x.at, reason: x.reason })), report };
}
export async function getShift({ orgId, membership, shiftId }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  const s = await loadShift(orgId, shiftId); if (s.error) return s;
  return { shift: await shiftView(orgId, s.shift, true) };
}
export async function listShifts({ orgId, membership, registerId, status, limit = 50 }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  const c = await ccol(); const q = { orgId: oid(orgId), kind: KINDS.shift, ...scopeFilter(membership, "warehouseId") };
  if (registerId) q.registerId = oid(registerId); if (status === "NEEDS_REVIEW") { q.status = "CLOSED"; q.review = null; } else if (status) q.status = status;
  const rows = await c.find(q).sort({ openedAt: -1 }).limit(Math.min(200, limit)).toArray();
  return { shifts: await Promise.all(rows.map((r) => shiftView(orgId, r, false))) };
}
export async function closeShift({ orgId, membership, actorEmail, shiftId, countedCash, note }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  const counted = toMinor(countedCash); if (!(counted >= 0)) return fail("Enter the counted cash (zero or more).");
  const s = await loadShift(orgId, shiftId); if (s.error) return s;
  if (s.shift.status !== "OPEN") return fail("This shift is already closed.", 409);
  if (s.shift.openedBy !== actorEmail && !roleCovers(commerceRoleOf(membership), "supervisor")) return fail("Only the person who opened this shift, or a supervisor/manager, can close it.", 403, "COMMERCE_ROLE");
  const settings = await getSettings(orgId); const sum = await summarize(orgId, s.shift);
  const variance = counted - sum.expectedMinor; const flagged = Math.abs(variance) > (settings.cashVarianceTolerance || 0); const now = nowIso(); const c = await ccol();
  const r = await c.findOneAndUpdate({ _id: s.shift._id, status: "OPEN" }, { $set: { status: "CLOSED", closedBy: actorEmail, closedAt: now, countedMinor: counted, expectedMinor: sum.expectedMinor, varianceMinor: variance, flagged, closeNote: clean(note, 300) || null, summary: sum } }, { returnDocument: "after" });
  if (!r) return fail("This shift was closed by someone else just now.", 409);
  await audit({ orgId, actorEmail, recordType: "COMMERCE_SHIFT", recordId: r._id, action: "SHIFT_CLOSED", newState: { shiftNumber: r.shiftNumber, expected: m(sum.expectedMinor), counted: m(counted), overShort: m(variance), flagged } });
  await emitCommerceEvent({ orgId, name: "shift.closed", entityId: r._id, actorEmail, idempotencyKey: `close:${sid(r._id)}`, payload: { shiftNumber: r.shiftNumber, registerId: sid(r.registerId), expected: m(sum.expectedMinor), counted: m(counted), overShort: m(variance), flagged } });
  return { shift: await shiftView(orgId, r, true) };
}
export async function reviewShift({ orgId, membership, actorEmail, shiftId, note }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const s = await loadShift(orgId, shiftId); if (s.error) return s;
  if (s.shift.status !== "CLOSED") return fail("Only a closed shift can be reviewed.", 409);
  if (s.shift.closedBy === actorEmail && s.shift.flagged) return fail("A flagged shift you closed yourself must be reviewed by another manager.", 403, "SELF_REVIEW");
  const c = await ccol(); const review = { by: actorEmail, at: nowIso(), note: clean(note, 300) || null };
  await c.updateOne({ _id: s.shift._id }, { $set: { review } });
  await audit({ orgId, actorEmail, recordType: "COMMERCE_SHIFT", recordId: s.shift._id, action: "SHIFT_REVIEWED", newState: { shiftNumber: s.shift.shiftNumber, overShort: m(s.shift.varianceMinor), note: review.note } });
  return { shift: await shiftView(orgId, { ...s.shift, review }, true) };
}
export async function correctShiftCount({ orgId, membership, actorEmail, shiftId, countedCash, reason }) {
  const denied = await commerceAccess({ orgId, membership, need: "manage" }); if (denied) return denied;
  const why = clean(reason, 300); if (!why || why.length < 3) return fail("Give a reason for the correction.");
  const to = toMinor(countedCash); if (!(to >= 0)) return fail("Enter the corrected count.");
  const s = await loadShift(orgId, shiftId); if (s.error) return s; if (s.shift.status !== "CLOSED") return fail("Only a closed shift's count can be corrected.", 409);
  const settings = await getSettings(orgId); const variance = to - s.shift.expectedMinor; const c = await ccol();
  const corr = { fromMinor: s.shift.countedMinor, toMinor: to, by: actorEmail, at: nowIso(), reason: why };
  const r = await c.findOneAndUpdate({ _id: s.shift._id, countedMinor: s.shift.countedMinor }, { $set: { countedMinor: to, varianceMinor: variance, flagged: Math.abs(variance) > (settings.cashVarianceTolerance || 0), review: null }, $push: { corrections: corr } }, { returnDocument: "after" });
  if (!r) return fail("The count changed meanwhile; reload.", 409);
  await audit({ orgId, actorEmail, recordType: "COMMERCE_SHIFT", recordId: r._id, action: "SHIFT_COUNT_CORRECTED", previousState: { counted: m(corr.fromMinor) }, newState: { counted: m(to), overShort: m(variance), reason: why } });
  return { shift: await shiftView(orgId, r, true) };
}

// ---------------------------------------------------------------- cash drawer openings (desktop printing, post-SOW "Route 3")
// Every opening is recorded BEFORE the drawer is opened: who, which till/branch/shift, when, why. A "No sale" opening needs a
// reason. Openings after a cash sale reference the sale. Managers and supervisors can list them per till.
export const DRAWER_KINDS = ["SALE", "NO_SALE"];
export async function logDrawerOpen({ orgId, membership, actorEmail, registerId, kind = "NO_SALE", reason, saleId = null }) {
  const denied = await commerceAccess({ orgId, membership }); if (denied) return denied;
  if (!DRAWER_KINDS.includes(kind)) return fail("Unknown drawer opening.");
  const why = clean(reason, 200); if (kind === "NO_SALE" && why.length < 3) return fail("Give a reason for opening the drawer without a sale.", 400, "REASON_REQUIRED");
  const c = await ccol(); const o = oid(orgId);
  const reg = await c.findOne({ _id: oid(registerId), orgId: o, kind: KINDS.register }); if (!reg) return fail("Register not found.", 404);
  if (kind === "SALE") { const { salesOrders } = await getOrgCollections(); if (!saleId || !(await salesOrders.findOne({ _id: oid(saleId), orgId: o, channel: "POS" }, { projection: { _id: 1 } }))) return fail("Sale not found.", 404); }
  const shift = await c.findOne({ orgId: o, kind: KINDS.shift, registerId: reg._id, status: "OPEN" }, { projection: { _id: 1, shiftNumber: 1 } });
  const doc = { orgId: o, kind: KINDS.drawer, type: kind, registerId: reg._id, warehouseId: reg.warehouseId, shiftId: shift?._id || null, saleId: saleId ? oid(saleId) : null, reason: why || null, byEmail: actorEmail, at: nowIso() };
  const r = await c.insertOne(doc);
  await audit({ orgId, actorEmail, recordType: "CASH_DRAWER", recordId: r.insertedId, action: kind === "NO_SALE" ? "DRAWER_OPENED_NO_SALE" : "DRAWER_OPENED_SALE", metadata: { register: reg.code || reg.name, shift: shift?.shiftNumber || null, reason: why || null } });
  return { ok: true, id: sid(r.insertedId) };
}
export async function listDrawerOpens({ orgId, membership, registerId = null, limit = 100 }) {
  const denied = await commerceAccess({ orgId, membership, need: "supervise" }); if (denied) return denied;
  const c = await ccol(); const q = { orgId: oid(orgId), kind: KINDS.drawer, ...scopeFilter(membership, "warehouseId"), ...(registerId ? { registerId: oid(registerId) } : {}) };
  const rows = await c.find(q).sort({ at: -1 }).limit(Math.min(500, limit)).toArray();
  return { openings: rows.map((x) => ({ id: sid(x._id), type: x.type, registerId: sid(x.registerId), shiftId: sid(x.shiftId), saleId: sid(x.saleId), reason: x.reason, by: x.byEmail, at: x.at })) };
}
