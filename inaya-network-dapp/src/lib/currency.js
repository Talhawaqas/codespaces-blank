// src/lib/currency.js
//
// Business Workspace Remaining Features SOW — Multi-Currency Conversion.
// A STATIC, explicitly-dated reference rate table, not a live feed — no
// FX API integration exists in this codebase and adding one is out of
// scope for this pass (stated plainly here and in every UI surface that
// shows a converted figure, never presented as real-time). Conversion is
// display-only: callers store the ORIGINAL amount/currency on the record
// exactly as entered and call convert() only when rendering a converted
// view, never to overwrite what was stored.

// 27 Nov 2026 (owner): Gulf, South-East Asia and Central Asia added before outreach to those markets, so customers there keep
// their books in their own currency.
export const SUPPORTED_CURRENCIES = ["USD", "EUR", "GBP", "AED", "PKR", "INR", "BDT", "SAR", "QAR", "OMR", "KWD", "BHD", "SGD", "MYR", "IDR", "THB", "PHP", "LKR", "VND", "KZT", "UZS", "AZN"];
/** Currencies normally shown without decimals. */
export const ZERO_DECIMAL_CURRENCIES = ["IDR", "VND", "UZS"];

// Rates expressed as "1 USD = X of this currency" — a fixed reference
// snapshot. RATES_AS_OF is surfaced on every conversion result so a
// caller can never mistake this for a live rate.
export const RATES_AS_OF = "2026-01-01";
// INR and BDT added 2026-10-28 for Education OS schools in India and
// Bangladesh; the daily rate (fx-rates.js) is used whenever one is stored.
// Gulf, SE Asia and Central Asia added 2026-11-27: reference values only; the daily live rate (fx-rates.js) replaces them as
// soon as one is stored. SAR, QAR, OMR, BHD and AZN are pegged to USD; KWD is basket-pegged.
const USD_RATES = { USD: 1, EUR: 0.92, GBP: 0.79, AED: 3.6725, PKR: 278.5, INR: 89.9, BDT: 122.3, SAR: 3.75, QAR: 3.64, OMR: 0.3845, KWD: 0.307, BHD: 0.376, SGD: 1.3, MYR: 4.2, IDR: 16500, THB: 32.5, PHP: 58.5, LKR: 300, VND: 26300, KZT: 520, UZS: 12500, AZN: 1.7 };

/** Converts amount from `from` to `to`. Returns
 *  { convertedAmount, rate, ratesAsOf } or { error } for an unsupported
 *  currency — NEVER guesses a rate or silently falls back to 1:1, per the
 *  SOW's "safe handling for missing exchange-rate data" requirement. */
export function convert(amount, from, to) {
  if (!Number.isFinite(amount)) return { error: "amount must be a finite number." };
  if (!SUPPORTED_CURRENCIES.includes(from) || !SUPPORTED_CURRENCIES.includes(to)) {
    return { error: `Exchange rate unavailable for ${from} -> ${to}.` };
  }
  if (from === to) return { convertedAmount: amount, rate: 1, ratesAsOf: RATES_AS_OF };

  // USD_RATES is "1 USD = X currency" -- converting from!=USD first goes
  // through USD as the common base, same as any real reference-rate table.
  const rate = USD_RATES[to] / USD_RATES[from];
  return { convertedAmount: Math.round(amount * rate * 100) / 100, rate, ratesAsOf: RATES_AS_OF };
}

export function isSupportedCurrency(code) {
  return SUPPORTED_CURRENCIES.includes(code);
}
