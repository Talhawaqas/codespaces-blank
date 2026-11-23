// src/lib/commerce/offlinePricing.js -- Inaya Commerce, offline selling (post-SOW #4).
//
// Pure, dependency-free pricing used by BOTH the till (while offline) and the server (when the offline sale syncs), so the
// two can never disagree. It prices a cart from an "offline pack": a server-issued snapshot of the till's products, shelf
// prices and tax rates (offline.js). Offline selling is deliberately narrow: shelf price only (no discounts, price changes,
// promotions, customer prices, loyalty or gift cards) and cash only. Same tax maths as tax.js/pricing.js: integer minor
// units, half-up rounding, per-line or per-total ("total" mode) tax rounding, optional cash rounding.

export const OFFLINE_VERSION = 1;

/** Same as tax.js taxOn: mode "exclusive" adds tax on top, "inclusive" takes it out of the amount. */
export function taxOnMinor(amountMinor, ratePercent, mode) {
  if (!ratePercent) return { netMinor: amountMinor, taxMinor: 0, grossMinor: amountMinor };
  if (mode === "inclusive") { const tax = Math.round((amountMinor * ratePercent) / (100 + ratePercent)); return { netMinor: amountMinor - tax, taxMinor: tax, grossMinor: amountMinor }; }
  const tax = Math.round((amountMinor * ratePercent) / 100); return { netMinor: amountMinor, taxMinor: tax, grossMinor: amountMinor + tax };
}
/** Same as pricing.js cashRounded. */
export function cashRoundedMinor(totalMinor, incrementMinor) { if (!incrementMinor) return totalMinor; return Math.round(totalMinor / incrementMinor) * incrementMinor; }

const qtyOk = (q) => Number.isFinite(q) && q > 0 && q <= 100000 && Math.round(q * 1000) === q * 1000;

/** Prices `lines` ([{ productId, quantity }]) from `pack` ({ products, taxMode, rounding }). Returns { lines, totals } in
 *  minor units, or { error, code }. */
export function priceOfflineCart(pack, lines) {
  if (!pack || !Array.isArray(pack.products)) return { error: "This till has no offline price list.", code: "NO_PACK" };
  if (!Array.isArray(lines) || !lines.length) return { error: "The cart is empty.", code: "EMPTY" };
  if (lines.length > 200) return { error: "An offline sale can have at most 200 lines.", code: "TOO_MANY_LINES" };
  const byId = new Map(pack.products.map((p) => [String(p.id), p]));
  const mode = pack.taxMode === "inclusive" ? "inclusive" : "exclusive";
  const out = [];
  for (const [i, l] of lines.entries()) {
    const p = byId.get(String(l?.productId));
    if (!p) return { error: `Line ${i + 1}: this product is not in the till's offline price list.`, code: "UNKNOWN_PRODUCT" };
    const q = Number(l.quantity);
    if (!qtyOk(q)) return { error: `Line ${i + 1}: quantity must be positive (up to 3 decimals).`, code: "QUANTITY" };
    if (!(Number.isInteger(p.priceMinor) && p.priceMinor >= 0)) return { error: `Line ${i + 1}: ${p.name} has no price.`, code: "NO_PRICE" };
    const base = Math.round(p.priceMinor * q); const rate = Number(p.tax?.rate) || 0; const t = taxOnMinor(base, rate, mode);
    out.push({ productId: String(p.id), sku: p.sku, name: p.name, productType: p.productType || "STOCK", category: p.category || null, quantity: q, unitPriceMinor: p.priceMinor, baseMinor: base,
      netMinor: t.netMinor, taxMinor: t.taxMinor, grossMinor: t.grossMinor, taxCategory: p.tax?.code || null, taxName: p.tax?.name || "No tax", taxRate: rate });
  }
  if (pack.rounding?.mode === "total") { // one rounding per tax category on the total, the difference on the last line
    const groups = new Map(); for (const l of out) { const k = `${l.taxCategory}:${l.taxRate}`; groups.set(k, [...(groups.get(k) || []), l]); }
    for (const g of groups.values()) {
      const exact = taxOnMinor(g.reduce((s, l) => s + l.baseMinor, 0), g[0].taxRate, mode).taxMinor; const diff = exact - g.reduce((s, l) => s + l.taxMinor, 0);
      const last = g[g.length - 1]; last.taxMinor += diff; if (mode === "exclusive") last.grossMinor += diff; else last.netMinor -= diff;
    }
  }
  const sum = (k) => out.reduce((s, l) => s + l[k], 0);
  const bd = new Map();
  for (const l of out) { const k = `${l.taxCategory || "NONE"}@${l.taxRate}`; const v = bd.get(k) || { category: l.taxCategory, name: l.taxName, rate: l.taxRate, taxableMinor: 0, taxMinor: 0 }; v.taxableMinor += l.netMinor; v.taxMinor += l.taxMinor; bd.set(k, v); }
  const totalMinor = sum("grossMinor");
  return { lines: out, totals: { subtotalMinor: sum("baseMinor"), netMinor: sum("netMinor"), taxMinor: sum("taxMinor"), totalMinor, cashDueMinor: cashRoundedMinor(totalMinor, Number(pack.rounding?.cashIncrement) || 0), taxBreakdown: [...bd.values()] } };
}

/** Cash settlement for an offline sale: cash given must cover the (cash-rounded) total. */
export function settleOfflineCash(totals, cashMinor) {
  if (!(Number.isInteger(cashMinor) && cashMinor > 0)) return { error: "Enter the cash received.", code: "NO_CASH" };
  if (cashMinor < totals.cashDueMinor) return { error: "The cash received is less than the total.", code: "UNDERPAID" };
  return { cashMinor, changeMinor: cashMinor - totals.cashDueMinor, roundingMinor: totals.cashDueMinor - totals.totalMinor, paidMinor: totals.cashDueMinor };
}

/** The exact string an offline sale is signed over (HMAC-SHA256 with the pack's secret). Field order is fixed. */
export function canonicalOfflineSale(s) {
  return JSON.stringify([OFFLINE_VERSION, String(s.offlineId), String(s.packId), Number(s.seq), String(s.receiptNumber), String(s.createdAt),
    (s.lines || []).map((l) => [String(l.productId), Number(l.quantity)]), Number(s.cashMinor), Number(s.totalMinor), String(s.notes || ""), s.drawerOpened === true]);
}

export const OFFLINE_ID_RE = /^[A-Za-z0-9_-]{8,120}$/;
