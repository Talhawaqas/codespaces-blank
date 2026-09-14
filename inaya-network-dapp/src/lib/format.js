// src/lib/format.js
//
// Business Workspace UX/UI Makeover SOW -- centralizes date/amount
// formatting found hand-written 46 times across 19 files
// (new Date(x).toLocaleDateString(), x.toFixed(2), manual "${currency}
// ${amount}" concatenation -- see BUSINESS_WORKSPACE_UX_AUDIT.md #3.1).
// Each function keeps the exact output shape the existing call sites
// already produced, so adopting these is a behavior-preserving swap.

/** Matches the existing `new Date(x).toLocaleDateString()` call sites. */
export function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString();
}

/** For the handful of call sites that also show a time component. */
export function formatDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

/** Matches the existing `${currency} ${amount.toFixed(2)}` string-concat
 *  pattern (e.g. FinanceView.js's invoice/expense totals) -- kept as a
 *  plain, locale-light concat rather than Intl.NumberFormat's currency
 *  style specifically because several currencies shown in this app
 *  (crypto-adjacent, testnet amounts) aren't real ISO 4217 codes Intl
 *  would accept. */
export function formatCurrency(amount, currency) {
  const value = Number(amount);
  const formatted = Number.isFinite(value) ? value.toFixed(2) : "0.00";
  return currency ? `${currency} ${formatted}` : formatted;
}

/** For plain unit-less quantities (stock counts, etc.) that still want
 *  thousands separators. */
export function formatNumber(value) {
  // Number(null) is 0, not NaN -- checked explicitly so a missing/
  // not-yet-loaded value never silently displays as a real "0".
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString() : "—";
}
