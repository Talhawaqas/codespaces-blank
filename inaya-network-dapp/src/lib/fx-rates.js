// src/lib/fx-rates.js
//
// Business Workspace gap closure, Batch 3 — daily live exchange rates.
//
// currency.js's static table and its synchronous convert() are unchanged
// (16 callers rely on them). This adds:
//   refreshFxRates()  — daily cron: fetch USD-based rates for the supported
//                       currencies and store ONE dated snapshot per day.
//   convertAt()       — async: converts using the snapshot on or before a
//                       date, falling back to the static table. Every result
//                       says which it used (source "live:<date>" or
//                       "static:<RATES_AS_OF>"), so a converted figure is
//                       never presented as more current than it is.
// A failed or malformed fetch never overwrites a stored snapshot and never
// invents a rate.

import { getOrgCollections } from "./orgs.js";
import { ssrfSafeFetch } from "./ssrfSafeFetch.js";
import { SUPPORTED_CURRENCIES, RATES_AS_OF, convert } from "./currency.js";

export const FX_SOURCE_URL = "https://open.er-api.com/v6/latest/USD";
const FX_HOST = "open.er-api.com";

let fetcher = (url) => ssrfSafeFetch(url, { allowedHosts: [FX_HOST], timeoutMs: 10000, maxBytes: 256 * 1024 });
/** Tests replace the network call. */
export function setFxFetcher(fn) { fetcher = fn; }

const today = () => new Date().toISOString().slice(0, 10);

/** Fetches today's rates and stores them. Returns { stored, date } or { stored: false, error }. */
export async function refreshFxRates({ date = today() } = {}) {
  let body;
  try {
    const res = await fetcher(FX_SOURCE_URL);
    if (!res.ok) return { stored: false, error: `Rate source answered ${res.status}.` };
    body = await res.json();
  } catch (err) {
    return { stored: false, error: `Rate source unreachable: ${err.message}` };
  }
  if (body?.result !== "success" || body?.base_code !== "USD" || typeof body?.rates !== "object") return { stored: false, error: "Rate source returned an unexpected response." };
  const rates = {};
  for (const code of SUPPORTED_CURRENCIES) {
    const r = Number(body.rates[code]);
    if (!Number.isFinite(r) || r <= 0) return { stored: false, error: `Rate source is missing ${code}; nothing stored.` };
    rates[code] = r;
  }
  if (rates.USD !== 1) return { stored: false, error: "Rate source's USD base isn't 1; nothing stored." };
  const { fxRates } = await getOrgCollections();
  await fxRates.updateOne(
    { date },
    { $set: { date, base: "USD", rates, source: FX_HOST, sourceUpdatedAt: body.time_last_update_utc || null, fetchedAt: new Date().toISOString() } },
    { upsert: true }
  );
  return { stored: true, date };
}

/** The newest snapshot on or before `date` (YYYY-MM-DD), or null. */
export async function getRatesOn(date = today()) {
  const { fxRates } = await getOrgCollections();
  return fxRates.findOne({ date: { $lte: String(date).slice(0, 10) } }, { sort: { date: -1 } });
}

/** Like currency.convert(), but uses the stored daily rate for `date` when there is one. */
export async function convertAt(amount, from, to, date = today()) {
  if (!Number.isFinite(amount)) return { error: "amount must be a finite number." };
  if (!SUPPORTED_CURRENCIES.includes(from) || !SUPPORTED_CURRENCIES.includes(to)) return { error: `Exchange rate unavailable for ${from} -> ${to}.` };
  let snap = null;
  try { snap = await getRatesOn(date); } catch { snap = null; }
  if (snap?.rates?.[from] && snap?.rates?.[to]) {
    if (from === to) return { convertedAmount: amount, rate: 1, ratesAsOf: snap.date, source: `live:${snap.date}` };
    const rate = snap.rates[to] / snap.rates[from];
    return { convertedAmount: Math.round(amount * rate * 100) / 100, rate, ratesAsOf: snap.date, source: `live:${snap.date}` };
  }
  const r = convert(amount, from, to);
  return r.error ? r : { ...r, source: `static:${RATES_AS_OF}` };
}
