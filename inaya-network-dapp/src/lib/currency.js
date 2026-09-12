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

export const SUPPORTED_CURRENCIES = ["USD", "EUR", "GBP", "AED", "PKR"];

// Rates expressed as "1 USD = X of this currency" — a fixed reference
// snapshot. RATES_AS_OF is surfaced on every conversion result so a
// caller can never mistake this for a live rate.
export const RATES_AS_OF = "2026-01-01";
const USD_RATES = { USD: 1, EUR: 0.92, GBP: 0.79, AED: 3.6725, PKR: 278.5 };

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
