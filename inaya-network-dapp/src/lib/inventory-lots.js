// src/lib/inventory-lots.js
//
// Batch / lot tracking with expiry dates. stock_lots holds one document per
// product + warehouse + lot number with its quantity and expiry date; like
// stock_levels it changes only through recordStockMovement() (inventory.js),
// and each movement records which lots it touched (movement.lots), so a lot's
// whole history can be traced from the ledger.
//
// A product opts in with trackLots. For such a product every stock-in needs
// a lot number, and a stock-out without one is taken earliest-expiry-first
// (FEFO: lots with an expiry date before those without, oldest lot first on
// a tie). Products that don't track lots behave exactly as before.

export const MAX_LOT_LENGTH = 64;
export const OPENING_LOT = "OPENING-STOCK";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Trims a lot number; returns "" for nothing usable. */
export function normalizeLotNumber(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_LOT_LENGTH);
}

/** Returns a YYYY-MM-DD string, null for empty, or { error }. */
export function normalizeExpiryDate(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const s = String(value).trim().slice(0, 10);
  if (!DATE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) return { error: "Expiry date must be a date (YYYY-MM-DD)." };
  return s;
}

/** FEFO order: earliest expiry first, lots without an expiry last, then oldest. */
export function fefoSort(lots) {
  return [...lots].sort((a, b) => {
    if (a.expiryDate && b.expiryDate && a.expiryDate !== b.expiryDate) return a.expiryDate < b.expiryDate ? -1 : 1;
    if (!a.expiryDate !== !b.expiryDate) return a.expiryDate ? -1 : 1;
    return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
  });
}

/** Takes `quantity` from the given lots in FEFO order. Pure: returns
 *  { lots: [{ lotNumber, expiryDate, quantity }] } or { error, available }. */
export function allocateFefo(available, quantity) {
  let remaining = quantity;
  const out = [];
  for (const lot of fefoSort(available.filter((l) => l.quantity > 0))) {
    if (remaining <= 0) break;
    const take = Math.min(lot.quantity, remaining);
    out.push({ lotNumber: lot.lotNumber, expiryDate: lot.expiryDate || null, quantity: take });
    remaining -= take;
  }
  if (remaining > 0) return { error: "not enough", available: quantity - remaining };
  return { lots: out };
}

/** Days from `today` (YYYY-MM-DD) until expiry; negative once expired. */
export function daysUntilExpiry(expiryDate, today = new Date().toISOString().slice(0, 10)) {
  if (!expiryDate) return null;
  return Math.round((Date.parse(`${expiryDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
}

/** Works out which lots a movement of `delta` touches, before anything is
 *  written. Returns { lots } (null when the movement isn't lot-tracked) or
 *  { error, status }. */
export async function planLots({ stockLots, orgId, productId, warehouseId, delta, trackLots, lotNumber, expiryDate, lots: explicit, defaultLotNumber }) {
  const qty = Math.abs(delta);
  const expiry = normalizeExpiryDate(expiryDate);
  if (expiry?.error) return { error: expiry.error, status: 400 };

  let planned = null;
  if (Array.isArray(explicit) && explicit.length) {
    planned = [];
    for (const l of explicit) {
      const n = normalizeLotNumber(l.lotNumber);
      const e = normalizeExpiryDate(l.expiryDate);
      if (!n) return { error: "Each batch needs a lot number.", status: 400 };
      if (e?.error) return { error: e.error, status: 400 };
      if (!Number.isFinite(l.quantity) || l.quantity <= 0) return { error: "Each batch needs a positive quantity.", status: 400 };
      planned.push({ lotNumber: n, expiryDate: e, quantity: l.quantity });
    }
    if (Math.abs(planned.reduce((s, l) => s + l.quantity, 0) - qty) > 1e-9) return { error: "Batch quantities must add up to the movement quantity.", status: 400 };
  } else {
    const named = normalizeLotNumber(lotNumber) || (trackLots && delta > 0 ? normalizeLotNumber(defaultLotNumber) : "");
    if (named) planned = [{ lotNumber: named, expiryDate: delta > 0 ? expiry : null, quantity: qty }];
    else if (trackLots && delta > 0) return { error: "This product tracks batches: enter a batch / lot number for stock coming in.", status: 400 };
    else if (trackLots && delta < 0) {
      const available = await stockLots.find({ orgId, productId, warehouseId, quantity: { $gt: 0 } }).toArray();
      const fefo = allocateFefo(available, qty);
      if (fefo.error) return { error: `Not enough stock in batches at this warehouse (have ${fefo.available}, tried to remove ${qty}).`, status: 409 };
      return { lots: fefo.lots };
    } else return { lots: null };
  }

  if (delta < 0) {
    for (const l of planned) {
      const have = await stockLots.findOne({ orgId, productId, warehouseId, lotNumber: l.lotNumber });
      if (!have || have.quantity < l.quantity) return { error: `Batch ${l.lotNumber} has only ${have?.quantity || 0} at this warehouse (tried to remove ${l.quantity}).`, status: 409 };
      l.expiryDate = have.expiryDate || null;
    }
  }
  return { lots: planned };
}

/** Applies planned lot changes (sign follows the movement's delta). */
export async function applyLots({ stockLots, orgId, productId, warehouseId, sign, lots }) {
  const now = new Date().toISOString();
  for (const l of lots) {
    const key = { orgId, productId, warehouseId, lotNumber: l.lotNumber };
    await stockLots.updateOne(key, { $inc: { quantity: sign * l.quantity }, $set: { updatedAt: now }, $setOnInsert: { expiryDate: l.expiryDate || null, createdAt: now } }, { upsert: sign > 0 });
    // A lot first received without an expiry date takes one given later.
    if (sign > 0 && l.expiryDate) await stockLots.updateOne({ ...key, expiryDate: null }, { $set: { expiryDate: l.expiryDate } });
  }
}

/** When a product starts tracking lots, stock it already holds becomes an
 *  OPENING-STOCK lot per warehouse, so nothing goes missing from FEFO. */
export async function openingLotsForExistingStock({ stockLevels, stockLots, orgId, productId }) {
  const levels = await stockLevels.find({ orgId, productId, quantity: { $gt: 0 } }).toArray();
  const now = new Date().toISOString();
  for (const level of levels) {
    const lotted = (await stockLots.find({ orgId, productId, warehouseId: level.warehouseId }).toArray()).reduce((s, l) => s + l.quantity, 0);
    const unassigned = level.quantity - lotted;
    if (unassigned > 0) {
      await stockLots.updateOne(
        { orgId, productId, warehouseId: level.warehouseId, lotNumber: OPENING_LOT },
        { $inc: { quantity: unassigned }, $set: { updatedAt: now }, $setOnInsert: { expiryDate: null, createdAt: now } },
        { upsert: true }
      );
    }
  }
}
