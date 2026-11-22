// src/lib/stock-control/transfers.js -- Inaya Commerce Phase 3 (Master SOW 7.5): transfers with a lifecycle.
//
//   REQUESTED --approve--> APPROVED (stock RESERVED at the source) --dispatch--> DISPATCHED (stock left the source:
//   TRANSFER_OUT; it is "in transit", counted at the destination by availability.js) --receive--> PARTIALLY_RECEIVED /
//   RECEIVED (TRANSFER_IN at the destination, same batches) ; a line can close with a SHORTFALL (lost/missing in transit,
//   reason required) or DAMAGED units (received into the quarantine location, or received and written off).
//   REQUESTED/APPROVED --cancel--> CANCELLED (reservation released).  DISPATCHED (nothing received) --reverse--> REVERSED
//   (stock goes back to the source with movements that point at the originals; history is never rewritten).
// Each step is one transaction; every movement carries relatedTransferId; the requester can't approve their own request.
// Stored in calendar_records (kind i_transfer) -- no new collections (Atlas at its limit).
import { ObjectId } from "mongodb";
import { getOrgCollections, toObjectId, canAccessDepartment, canManageOrg } from "../orgs.js";
import { recordStockMovement, reserveStock, releaseStock, withStockTransaction, StockError } from "../inventory.js";
import { logOrgActivity } from "../org-activity-log.js";
import { ccol, nextNumber, ensureCommerceIndexes } from "../commerce/store.js";
import { TRANSFER_KIND } from "./availability.js";

const r6 = (n) => Math.round(n * 1e6) / 1e6;
const fail = (error, status = 400, code) => ({ error, status, ...(code ? { code } : {}) });
const boom = (m, status = 409) => Object.assign(new Error(m), { status, isTransferError: true });
const nowIso = () => new Date().toISOString();

export function transferView(t, names = {}) {
  return { id: String(t._id), number: t.number, status: t.status, fromWarehouseId: String(t.fromWarehouseId), toWarehouseId: String(t.toWarehouseId), from: names[String(t.fromWarehouseId)] || null, to: names[String(t.toWarehouseId)] || null,
    neededBy: t.neededBy || null, note: t.note || null, requestedBy: t.requestedBy, approvedBy: t.approvedBy || null, dispatchedBy: t.dispatchedBy || null, createdAt: t.createdAt,
    lines: t.lines.map((l) => ({ productId: String(l.productId), sku: l.sku, name: l.name, quantity: l.quantity, reservedQty: l.reservedQty || 0, dispatchedQty: l.dispatchedQty || 0, receivedQty: l.receivedQty || 0, shortQty: l.shortQty || 0, damagedQty: l.damagedQty || 0, open: r6((l.dispatchedQty || 0) - (l.receivedQty || 0) - (l.shortQty || 0) - (l.damagedQty || 0)), discrepancies: l.discrepancies || [] })),
    history: (t.history || []).slice(-30) };
}
async function load(orgId, id, session = null) { const c = await ccol(); return c.findOne({ _id: toObjectId(id), orgId: toObjectId(orgId), kind: TRANSFER_KIND }, { session }); }
const log = (orgId, t, actorEmail, action, metadata = {}) => logOrgActivity({ orgId: toObjectId(orgId), recordType: "STOCK_TRANSFER", recordId: t._id, actorEmail, action, previousState: null, newState: null, metadata: { number: t.number, ...metadata } }).catch(() => {});

export async function createTransfer({ orgId, membership, actorEmail, input }) {
  const { warehouses, products } = await getOrgCollections(); const o = toObjectId(orgId);
  const from = await warehouses.findOne({ _id: toObjectId(input.fromWarehouseId), orgId: o }); const to = await warehouses.findOne({ _id: toObjectId(input.toWarehouseId), orgId: o });
  if (!from || !to) return fail("Choose both locations.", 404);
  if (String(from._id) === String(to._id)) return fail("The two locations must be different.");
  if (!canAccessDepartment(membership, from.departmentId) && !canAccessDepartment(membership, to.departmentId)) return fail("You don't have access to these locations.", 403);
  if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 200) return fail("Add 1 to 200 products.");
  const lines = [];
  for (const l of input.lines) {
    const q = Number(l.quantity); if (!(q > 0)) return fail("Each line needs a positive quantity.");
    const p = await products.findOne({ _id: toObjectId(l.productId), orgId: o, deletedAt: null }); if (!p) return fail("A product wasn't found.", 404);
    if (["SERVICE", "NON_STOCK", "KIT"].includes(p.productType)) return fail(`${p.name} has no stock of its own to transfer.`);
    lines.push({ productId: p._id, sku: p.sku, name: p.name, quantity: q });
  }
  await ensureCommerceIndexes(); const c = await ccol(); const now = nowIso();
  const doc = { orgId: o, kind: TRANSFER_KIND, number: `TR-${String(await nextNumber(orgId, "stock_transfer")).padStart(5, "0")}`, status: "REQUESTED", fromWarehouseId: from._id, toWarehouseId: to._id, lines, neededBy: input.neededBy || null, note: String(input.note || "").slice(0, 300) || null, requestedBy: actorEmail, createdAt: now, updatedAt: now, history: [{ to: "REQUESTED", by: actorEmail, at: now }] };
  const r = await c.insertOne(doc);
  await log(orgId, { ...doc, _id: r.insertedId }, actorEmail, "TRANSFER_REQUESTED", { lines: lines.length });
  return { transfer: transferView({ ...doc, _id: r.insertedId }, { [String(from._id)]: from.name, [String(to._id)]: to.name }) };
}

export async function listTransfers({ orgId, status }) {
  const c = await ccol(); const { warehouses } = await getOrgCollections(); const o = toObjectId(orgId);
  const names = Object.fromEntries((await warehouses.find({ orgId: o }, { projection: { name: 1 } }).toArray()).map((w) => [String(w._id), w.name]));
  const rows = await c.find({ orgId: o, kind: TRANSFER_KIND, ...(status ? { status } : {}) }).sort({ createdAt: -1 }).limit(200).toArray();
  return { transfers: rows.map((t) => transferView(t, names)) };
}

/** action: approve | dispatch { lines?: [{ lineIndex, quantity }] } | receive { lines: [{ lineIndex, received, short?, damaged?, reason? }] } | cancel { reason } | reverse { reason } */
export async function transitionTransfer({ orgId, membership, actorEmail, transferId, action, input = {} }) {
  const t0 = await load(orgId, transferId); if (!t0) return fail("Transfer not found.", 404);
  const { warehouses } = await getOrgCollections(); const o = toObjectId(orgId);
  const [from, to] = await Promise.all([warehouses.findOne({ _id: t0.fromWarehouseId, orgId: o }), warehouses.findOne({ _id: t0.toWarehouseId, orgId: o })]);
  const atFrom = canAccessDepartment(membership, from?.departmentId), atTo = canAccessDepartment(membership, to?.departmentId);
  const c = await ccol(); const now = nowIso();
  const step = async (fn) => { try { return await withStockTransaction(fn); } catch (e) { if (e?.isTransferError || e instanceof StockError) return fail(e.message, e.status || 409, e.code); throw e; } };
  let res;
  if (action === "approve") {
    if (t0.status !== "REQUESTED") return fail(`Only a requested transfer can be approved (this one is ${t0.status}).`, 409);
    if (!canManageOrg(membership)) return fail("Transfers are approved by the owner or an admin.", 403);
    if (t0.requestedBy === actorEmail) return fail("You can't approve your own transfer request.", 403, "SELF_APPROVAL");
    res = await step(async (session) => {
      const t = await load(orgId, transferId, session); if (t.status !== "REQUESTED") throw boom("This transfer changed; reload.");
      const lines = [];
      for (const l of t.lines) { const r = await reserveStock({ orgId, productId: l.productId, warehouseId: t.fromWarehouseId, quantity: l.quantity, session, actorEmail }); if (r.reserved < l.quantity) throw boom(`Not enough free stock of ${l.name} at ${from.name} (free ${r.free}).`); lines.push({ ...l, reservedQty: l.quantity }); }
      await c.updateOne({ _id: t._id }, { $set: { status: "APPROVED", lines, approvedBy: actorEmail, approvedAt: now, updatedAt: now }, $push: { history: { to: "APPROVED", by: actorEmail, at: now } } }, { session });
      return { ok: true };
    });
  } else if (action === "dispatch") {
    if (t0.status !== "APPROVED") return fail("Only an approved transfer can be dispatched.", 409);
    if (!atFrom) return fail("Only staff at the sending location can dispatch.", 403);
    res = await step(async (session) => {
      const t = await load(orgId, transferId, session); if (t.status !== "APPROVED") throw boom("This transfer changed; reload.");
      const lines = [];
      for (const [i, l] of t.lines.entries()) {
        const want = input.lines?.find((x) => Number(x.lineIndex) === i); const q = want ? Number(want.quantity) : l.quantity;
        if (!(q >= 0) || q > l.reservedQty + 1e-9) throw boom(`Dispatch of ${l.name} must be between 0 and ${l.reservedQty}.`, 400);
        let lots = null;
        if (q > 0) { const mv = await recordStockMovement({ orgId, productId: l.productId, warehouseId: t.fromWarehouseId, delta: -q, type: "TRANSFER_OUT", consumeReserved: q, relatedTransferId: t._id, note: `Transfer ${t.number} to ${to.name}`, actorEmail, session, idempotencyKey: `tr:${t._id}:out:${i}` }); if (mv.error) throw boom(mv.error); lots = mv.lots || null; }
        if (l.reservedQty - q > 1e-9) await releaseStock({ orgId, productId: l.productId, warehouseId: t.fromWarehouseId, quantity: r6(l.reservedQty - q), session, actorEmail });
        lines.push({ ...l, reservedQty: 0, dispatchedQty: q, dispatchedLots: lots });
      }
      if (!lines.some((l) => l.dispatchedQty > 0)) throw boom("Dispatch at least one item, or cancel the transfer.", 400);
      await c.updateOne({ _id: t._id }, { $set: { status: "DISPATCHED", lines, dispatchedBy: actorEmail, dispatchedAt: now, updatedAt: now }, $push: { history: { to: "DISPATCHED", by: actorEmail, at: now } } }, { session });
      return { ok: true };
    });
  } else if (action === "receive") {
    if (!["DISPATCHED", "PARTIALLY_RECEIVED"].includes(t0.status)) return fail("Only a dispatched transfer can be received.", 409);
    if (!atTo) return fail("Only staff at the receiving location can receive.", 403);
    if (!Array.isArray(input.lines) || !input.lines.length) return fail("Enter what arrived.");
    const { getSettings } = await import("../commerce/store.js"); const quarantine = (await getSettings(orgId).catch(() => ({}))).quarantineWarehouseId || null;
    res = await step(async (session) => {
      const t = await load(orgId, transferId, session); if (!["DISPATCHED", "PARTIALLY_RECEIVED"].includes(t.status)) throw boom("This transfer changed; reload.");
      const lines = t.lines.map((l) => ({ ...l })); const n = (t.history || []).length;
      for (const x of input.lines) {
        const i = Number(x.lineIndex); const l = lines[i]; if (!l) throw boom("Unknown line.", 400);
        const got = Number(x.received || 0), short = Number(x.short || 0), damaged = Number(x.damaged || 0);
        if ([got, short, damaged].some((v) => !(v >= 0)) || got + short + damaged <= 0) throw boom("Enter received, short or damaged quantities.", 400);
        const open = r6((l.dispatchedQty || 0) - (l.receivedQty || 0) - (l.shortQty || 0) - (l.damagedQty || 0));
        if (got + short + damaged > open + 1e-9) throw boom(`Only ${open} of ${l.name} are still in transit.`, 409);
        if ((short > 0 || damaged > 0) && String(x.reason || "").trim().length < 3) throw boom(`Give a reason for the shortfall or damage on ${l.name}.`, 400);
        // the same batches arrive: take the dispatched batches in order, minus what earlier receipts used
        const lotsFor = (qty, skip) => { if (!l.dispatchedLots?.length) return undefined; const out = []; let need = qty, s = skip; for (const d of l.dispatchedLots) { let avail = d.quantity; if (s > 0) { const u = Math.min(s, avail); avail -= u; s -= u; } if (avail <= 0 || need <= 0) continue; const take = Math.min(avail, need); out.push({ lotNumber: d.lotNumber, expiryDate: d.expiryDate || null, quantity: take }); need -= take; } return out; };
        const used = (l.receivedQty || 0) + (l.damagedQty || 0) + (l.shortQty || 0);
        if (got > 0) { const mv = await recordStockMovement({ orgId, productId: l.productId, warehouseId: t.toWarehouseId, delta: got, type: "TRANSFER_IN", relatedTransferId: t._id, lots: lotsFor(got, used), note: `Transfer ${t.number} from ${from.name}`, actorEmail, session, idempotencyKey: `tr:${t._id}:in:${i}:${n}` }); if (mv.error) throw boom(mv.error); }
        if (damaged > 0) {
          const into = quarantine || String(t.toWarehouseId);
          const mv = await recordStockMovement({ orgId, productId: l.productId, warehouseId: into, delta: damaged, type: "TRANSFER_IN", relatedTransferId: t._id, lots: lotsFor(damaged, used + got), note: `Transfer ${t.number}: damaged in transit`, reason: x.reason, actorEmail, session, idempotencyKey: `tr:${t._id}:dmg:${i}:${n}` }); if (mv.error) throw boom(mv.error);
          if (!quarantine) { const off = await recordStockMovement({ orgId, productId: l.productId, warehouseId: into, delta: -damaged, type: "WRITE_OFF", relatedTransferId: t._id, reason: x.reason, note: `Transfer ${t.number}: damaged in transit`, actorEmail, session, idempotencyKey: `tr:${t._id}:dmgw:${i}:${n}` }); if (off.error) throw boom(off.error); }
        }
        l.receivedQty = r6((l.receivedQty || 0) + got); l.damagedQty = r6((l.damagedQty || 0) + damaged); l.shortQty = r6((l.shortQty || 0) + short);
        if (short > 0 || damaged > 0) l.discrepancies = [...(l.discrepancies || []), { short, damaged, reason: String(x.reason).trim().slice(0, 300), by: actorEmail, at: now }];
      }
      const done = lines.every((l) => r6((l.dispatchedQty || 0) - (l.receivedQty || 0) - (l.shortQty || 0) - (l.damagedQty || 0)) <= 0);
      const status = done ? (lines.some((l) => l.shortQty > 0 || l.damagedQty > 0) ? "RECEIVED_WITH_DISCREPANCY" : "RECEIVED") : "PARTIALLY_RECEIVED";
      const u = await c.updateOne({ _id: t._id, [`history.${n}`]: { $exists: false } }, { $set: { status, lines, updatedAt: now, ...(done ? { receivedAt: now } : {}) }, $push: { history: { to: status, by: actorEmail, at: now } } }, { session });
      if (u.modifiedCount !== 1) throw boom("Another receipt was recorded at the same moment; reload.");
      return { ok: true, status };
    });
  } else if (action === "cancel") {
    if (!["REQUESTED", "APPROVED"].includes(t0.status)) return fail("Only a transfer that hasn't left can be cancelled. Reverse a dispatched one.", 409);
    if (t0.requestedBy !== actorEmail && !canManageOrg(membership)) return fail("Only the requester or an admin can cancel.", 403);
    res = await step(async (session) => {
      const t = await load(orgId, transferId, session); if (!["REQUESTED", "APPROVED"].includes(t.status)) throw boom("This transfer changed; reload.");
      for (const l of t.lines) if (l.reservedQty > 0) await releaseStock({ orgId, productId: l.productId, warehouseId: t.fromWarehouseId, quantity: l.reservedQty, session, actorEmail });
      await c.updateOne({ _id: t._id }, { $set: { status: "CANCELLED", lines: t.lines.map((l) => ({ ...l, reservedQty: 0 })), cancelReason: String(input.reason || "").slice(0, 300) || null, updatedAt: now }, $push: { history: { to: "CANCELLED", by: actorEmail, at: now } } }, { session });
      return { ok: true };
    });
  } else if (action === "reverse") {
    if (t0.status !== "DISPATCHED") return fail("Only a dispatched transfer with nothing received yet can be reversed.", 409);
    if (!canManageOrg(membership)) return fail("Reversals are made by the owner or an admin.", 403);
    if (String(input.reason || "").trim().length < 3) return fail("Give a reason for the reversal.");
    res = await step(async (session) => {
      const t = await load(orgId, transferId, session); if (t.status !== "DISPATCHED") throw boom("This transfer changed; reload.");
      const { stockMovements } = await getOrgCollections();
      for (const [i, l] of t.lines.entries()) {
        if (!(l.dispatchedQty > 0)) continue;
        const orig = await stockMovements.findOne({ orgId: o, idempotencyKey: `tr:${t._id}:out:${i}` }, { session });
        const mv = await recordStockMovement({ orgId, productId: l.productId, warehouseId: t.fromWarehouseId, delta: l.dispatchedQty, type: "TRANSFER_IN", relatedTransferId: t._id, lots: l.dispatchedLots || undefined, reversesMovementId: orig?._id || null, reason: input.reason, note: `Reversal of transfer ${t.number}`, actorEmail, session, idempotencyKey: `tr:${t._id}:rev:${i}` });
        if (mv.error) throw boom(mv.error);
      }
      await c.updateOne({ _id: t._id }, { $set: { status: "REVERSED", reverseReason: String(input.reason).trim().slice(0, 300), updatedAt: now }, $push: { history: { to: "REVERSED", by: actorEmail, at: now } } }, { session });
      return { ok: true };
    });
  } else return fail("Unknown action.");
  if (res?.error) return res;
  const t = await load(orgId, transferId);
  await log(orgId, t, actorEmail, `TRANSFER_${t.status}`, { action });
  return { transfer: transferView(t, { [String(from._id)]: from.name, [String(to._id)]: to.name }) };
}
