// src/lib/documentAutomation/money.js
//
// Document Automation SOW §8 -- decimal-safe money arithmetic. Every
// quantity, price and percentage that enters the engine is parsed ONCE from
// its decimal text into a BigInt scaled by 10^8 ("d8"), and every downstream
// step is exact BigInt arithmetic with an explicit, named rounding mode
// applied at the single point a result must become an integer number of
// minor units (cents/fils/etc). Floating point is never used to accumulate
// or multiply money, so 0.1 + 0.2 is exactly 0.3 and 1.005 * 100 is exactly
// 100.5 (which HALF_UP rounds to 101, deterministically, on every host).

export const D8_DIGITS = 8;
export const D8 = 10n ** 8n;

/** ISO 4217 minor-unit exponents. The five currencies Inaya's Business
 *  Workspace supports (currency.js: USD/EUR/GBP/AED/PKR) plus a few others
 *  with a different precision, so the precision logic is proven against
 *  zero- and three-decimal currencies rather than hard-coded to two. */
export const CURRENCY_EXPONENTS = {
  USD: 2, EUR: 2, GBP: 2, AED: 2, PKR: 2,
  JPY: 0, KWD: 3, BHD: 3, OMR: 3, CHF: 2, CAD: 2, AUD: 2, SAR: 2, INR: 2,
};

export const ROUNDING_MODES = ["HALF_UP", "HALF_EVEN", "DOWN", "UP"];

export function currencyExponent(currency) {
  const exp = CURRENCY_EXPONENTS[String(currency || "").toUpperCase()];
  if (exp === undefined) throw new Error(`Unsupported currency "${currency}" -- no minor-unit precision is defined for it.`);
  return exp;
}

const DECIMAL_RE = /^([+-])?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/** Parses a number or numeric string into a d8 BigInt. Rejects NaN,
 *  Infinity, more than 8 fractional digits (never silently truncates a
 *  value it cannot represent exactly) and absurdly large magnitudes. */
export function parseDecimal(value, label = "value") {
  if (value === null || value === undefined || value === "") throw new Error(`${label} is required.`);
  if (typeof value === "bigint") return value * D8;
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  if (typeof value !== "number" && typeof value !== "string") throw new Error(`${label} must be a number or numeric string.`);

  const text = String(value).trim();
  const m = DECIMAL_RE.exec(text);
  if (!m) throw new Error(`${label} is not a valid decimal number.`);
  const sign = m[1] === "-" ? -1n : 1n;
  let intPart = m[2];
  let fracPart = m[3] || "";
  const exp = m[4] ? parseInt(m[4], 10) : 0;
  if (Math.abs(exp) > 30) throw new Error(`${label} is out of range.`);

  if (exp > 0) {
    const shift = Math.min(exp, fracPart.length);
    intPart += fracPart.slice(0, shift);
    fracPart = fracPart.slice(shift);
    intPart += "0".repeat(exp - shift);
  } else if (exp < 0) {
    const n = -exp;
    const padded = intPart.padStart(n + 1, "0");
    fracPart = padded.slice(padded.length - n) + fracPart;
    intPart = padded.slice(0, padded.length - n);
  }
  fracPart = fracPart.replace(/0+$/, "");
  if (fracPart.length > D8_DIGITS) throw new Error(`${label} has more than ${D8_DIGITS} decimal places.`);
  const scaled = BigInt(intPart || "0") * D8 + BigInt(fracPart.padEnd(D8_DIGITS, "0") || "0");
  if (scaled > 10n ** 22n) throw new Error(`${label} is too large.`);
  return sign * scaled;
}

/** Integer division with an explicit rounding mode. numerator/denominator
 *  are BigInt; denominator must be positive. */
export function roundDiv(numerator, denominator, mode = "HALF_UP") {
  if (denominator <= 0n) throw new Error("roundDiv: denominator must be positive.");
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  let q = abs / denominator;
  const r = abs % denominator;
  if (r !== 0n) {
    const twice = r * 2n;
    if (mode === "UP") q += 1n;
    else if (mode === "HALF_UP") { if (twice >= denominator) q += 1n; }
    else if (mode === "HALF_EVEN") { if (twice > denominator || (twice === denominator && q % 2n === 1n)) q += 1n; }
    else if (mode !== "DOWN") throw new Error(`Unknown rounding mode "${mode}".`);
  }
  return negative ? -q : q;
}

/** d8 amount (a price) -> integer minor units, rounded per `mode`. */
export function d8ToMinor(d8, exponent, mode = "HALF_UP") {
  return roundDiv(d8 * 10n ** BigInt(exponent), D8, mode);
}

/** qty(d8) * unitPrice(d8) -> minor units in one exact step. */
export function mulToMinor(qtyD8, priceD8, exponent, mode = "HALF_UP") {
  return roundDiv(qtyD8 * priceD8 * 10n ** BigInt(exponent), D8 * D8, mode);
}

/** minor * percent(d8) / 100 -> minor units. */
export function percentOfMinor(minor, percentD8, mode = "HALF_UP") {
  return roundDiv(minor * percentD8, 100n * D8, mode);
}

/** Minor-unit BigInt -> JS number in major units. Only ever called at the
 *  very end of a calculation, and only after asserting the value is within
 *  Number's exact-integer range, so display values are never approximations
 *  of an out-of-range result. */
export function minorToNumber(minor, exponent) {
  if (minor > BigInt(Number.MAX_SAFE_INTEGER) || minor < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Amount exceeds the maximum supported magnitude.");
  }
  return Number(minor) / 10 ** exponent;
}

export function minorToSafeInt(minor) {
  if (minor > BigInt(Number.MAX_SAFE_INTEGER) || minor < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Amount exceeds the maximum supported magnitude.");
  }
  return Number(minor);
}

/** Splits `total` across weights so the parts sum EXACTLY to total
 *  (largest-remainder method, ties broken by index -- deterministic). Used
 *  to allocate an invoice-level discount across lines without drift. */
export function allocateProRata(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum === 0n || total === 0n) return weights.map(() => 0n);
  const shares = weights.map((w) => (total * w) / sum);
  const remainders = weights.map((w, i) => ({ i, rem: (total * w) % sum }));
  let leftover = total - shares.reduce((a, b) => a + b, 0n);
  remainders.sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (let k = 0; leftover > 0n && k < remainders.length; k++, leftover--) shares[remainders[k].i] += 1n;
  return shares;
}

/** Integer minor units -> exact decimal string (e.g. 123456n, 2 -> "1234.56").
 *  Used to feed one exact result back into another exact calculation. */
export function minorToDecimalString(minor, exponent) {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  if (exponent === 0) return `${negative ? "-" : ""}${abs}`;
  const s = abs.toString().padStart(exponent + 1, "0");
  return `${negative ? "-" : ""}${s.slice(0, -exponent)}.${s.slice(-exponent)}`;
}
