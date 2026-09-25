// src/lib/documentAutomation/calculations.js
//
// Document Automation SOW §8 -- the canonical, deterministic, reproducible
// financial calculation. The Phase 0 audit found the only existing money
// math in the codebase (finance/invoices/route.js computeTotal) is naive
// IEEE-754 floating point, exactly what §8's "no unsafe floating-point
// money arithmetic" forbids. Everything here runs on BigInt (money.js):
// currency-aware precision, a named rounding mode, pro-rata allocation of
// an invoice-level discount so per-line tax is computed on what the
// customer is actually charged, and a canonical minor-unit result that
// manifest.js hashes (calculationHash) -- the PDF is rendered from this
// result and nothing else (§8 "the PDF must reflect the canonical stored
// calculation").
//
// Semantics (documented so reviewers can reproduce a total by hand):
//   line gross     = qty x unitPrice                         (rounded once)
//   line discount  = pct of gross, or a fixed amount (never both)
//   line net       = gross - line discount
//   invoice disc.  = pct of sum(line net), or a fixed amount, allocated
//                    across lines pro-rata (largest remainder, exact)
//   line tax       = line's own rate x (line net - allocated discount)
//   document tax   = document rate x the net of lines WITHOUT their own
//                    rate (a line's own rate, even 0, overrides the default)
//   grand total    = sum(line net) - invoice disc. + all tax + shipping + fees
//   amount due     = grand total - amount paid

import {
  currencyExponent, ROUNDING_MODES, parseDecimal, d8ToMinor, mulToMinor, percentOfMinor,
  minorToNumber, minorToSafeInt, allocateProRata, D8,
} from "./money.js";

export const MAX_LINE_ITEMS = 2000;
const MAX_DESCRIPTION_CHARS = 2000;
const HUNDRED_D8 = 100n * D8;

function pct(value, label) {
  if (value === undefined || value === null || value === "") return 0n;
  const d8 = parseDecimal(value, label);
  if (d8 < 0n || d8 > HUNDRED_D8) throw new Error(`${label} must be between 0 and 100.`);
  return d8;
}

function amountMinor(value, exponent, label, mode) {
  if (value === undefined || value === null || value === "") return 0n;
  const d8 = parseDecimal(value, label);
  if (d8 < 0n) throw new Error(`${label} cannot be negative.`);
  return d8ToMinor(d8, exponent, mode);
}

/**
 * @param {Object} p
 * @param {string} [p.currency="USD"]
 * @param {Array<{description:string,quantity:number|string,unitPrice:number|string,discountPercent?:number,discountAmount?:number,taxPercent?:number}>} p.lineItems
 * @param {number} [p.invoiceDiscountPercent]
 * @param {number} [p.invoiceDiscountAmount]
 * @param {number} [p.taxPercent]      default rate for lines without their own
 * @param {number} [p.shippingAmount]
 * @param {number} [p.feeAmount]
 * @param {number} [p.amountPaid]
 * @param {"HALF_UP"|"HALF_EVEN"|"DOWN"|"UP"} [p.roundingMode]
 */
export function calculateDocument({
  currency = "USD", lineItems, invoiceDiscountPercent = 0, invoiceDiscountAmount = 0,
  taxPercent = 0, shippingAmount = 0, feeAmount = 0, amountPaid = 0, roundingMode = "HALF_UP",
}) {
  if (!ROUNDING_MODES.includes(roundingMode)) throw new Error(`Unknown rounding mode "${roundingMode}".`);
  const cur = String(currency || "").toUpperCase();
  const exp = currencyExponent(cur);
  if (!Array.isArray(lineItems) || lineItems.length === 0) throw new Error("At least one line item is required.");
  if (lineItems.length > MAX_LINE_ITEMS) throw new Error(`A document may have at most ${MAX_LINE_ITEMS} line items.`);

  const defaultRate = pct(taxPercent, "taxPercent");
  const lines = lineItems.map((item, idx) => {
    if (typeof item?.description !== "string") throw new Error(`Line ${idx + 1} needs a text description.`);
    const description = item.description.trim();
    if (!description) throw new Error(`Line ${idx + 1} needs a description.`);
    if (description.length > MAX_DESCRIPTION_CHARS) throw new Error(`Line ${idx + 1}'s description is too long.`);
    const label = `"${description.slice(0, 40)}"`;
    const qty = parseDecimal(item.quantity, `Quantity for ${label}`);
    if (qty <= 0n) throw new Error(`Invalid quantity for ${label}.`);
    const price = parseDecimal(item.unitPrice, `Unit price for ${label}`);
    if (price < 0n) throw new Error(`Invalid unit price for ${label}.`);

    const gross = mulToMinor(qty, price, exp, roundingMode);
    if (item.discountPercent && item.discountAmount) throw new Error(`Line ${label} has both a percent and an amount discount.`);
    let discount = 0n;
    if (item.discountPercent) discount = percentOfMinor(gross, pct(item.discountPercent, `Discount for ${label}`), roundingMode);
    else if (item.discountAmount) discount = amountMinor(item.discountAmount, exp, `Discount for ${label}`, roundingMode);
    if (discount > gross) throw new Error(`The discount on ${label} exceeds its amount.`);

    const hasOwnRate = item.taxPercent !== undefined && item.taxPercent !== null && item.taxPercent !== "";
    return {
      description, quantityText: String(item.quantity), unitPriceText: String(item.unitPrice),
      qty, price, gross, discount, net: gross - discount,
      ownRate: hasOwnRate ? pct(item.taxPercent, `Tax for ${label}`) : null,
      sku: item.sku ? String(item.sku).slice(0, 64) : null,
    };
  });

  const netTotal = lines.reduce((s, l) => s + l.net, 0n);

  if (invoiceDiscountPercent && invoiceDiscountAmount) throw new Error("Specify an invoice discount as a percent or an amount, not both.");
  let invoiceDiscount = 0n;
  if (invoiceDiscountPercent) invoiceDiscount = percentOfMinor(netTotal, pct(invoiceDiscountPercent, "invoiceDiscountPercent"), roundingMode);
  else if (invoiceDiscountAmount) invoiceDiscount = amountMinor(invoiceDiscountAmount, exp, "invoiceDiscountAmount", roundingMode);
  if (invoiceDiscount > netTotal) throw new Error("The invoice discount exceeds the document subtotal.");
  const allocations = allocateProRata(invoiceDiscount, lines.map((l) => l.net));

  let lineTaxTotal = 0n;
  let defaultRateBase = 0n;
  let taxableAmount = 0n;
  const computed = lines.map((l, i) => {
    const discountedNet = l.net - allocations[i];
    let lineTax = 0n;
    if (l.ownRate !== null) {
      lineTax = percentOfMinor(discountedNet, l.ownRate, roundingMode);
      if (l.ownRate > 0n) taxableAmount += discountedNet;
    } else {
      defaultRateBase += discountedNet;
      if (defaultRate > 0n) taxableAmount += discountedNet;
    }
    lineTaxTotal += lineTax;
    return { ...l, allocatedDiscount: allocations[i], discountedNet, lineTax, lineTotal: l.net + lineTax };
  });
  const documentTax = defaultRate > 0n ? percentOfMinor(defaultRateBase, defaultRate, roundingMode) : 0n;
  const totalTax = lineTaxTotal + documentTax;

  const shipping = amountMinor(shippingAmount, exp, "shippingAmount", roundingMode);
  const fees = amountMinor(feeAmount, exp, "feeAmount", roundingMode);
  const grandTotal = netTotal - invoiceDiscount + totalTax + shipping + fees;
  const paid = amountMinor(amountPaid, exp, "amountPaid", roundingMode);
  const amountDue = grandTotal - paid;
  const lineDiscountTotal = lines.reduce((s, l) => s + l.discount, 0n);

  const n = (m) => minorToNumber(m, exp);
  return {
    currency: cur, currencyExponent: exp, roundingMode,
    lineItems: computed.map((l) => ({
      description: l.description, sku: l.sku,
      quantity: Number(l.quantityText), unitPrice: Number(l.unitPriceText),
      lineGross: n(l.gross), lineDiscount: n(l.discount), lineNet: n(l.net),
      lineTax: n(l.lineTax), lineTotal: n(l.lineTotal),
      taxRate: l.ownRate === null ? null : Number(l.ownRate) / Number(D8),
    })),
    subtotal: n(netTotal),
    lineDiscountTotal: n(lineDiscountTotal),
    invoiceDiscount: n(invoiceDiscount),
    taxableAmount: n(taxableAmount),
    lineTaxTotal: n(lineTaxTotal),
    tax: n(documentTax),
    totalTax: n(totalTax),
    shipping: n(shipping),
    fees: n(fees),
    grandTotal: n(grandTotal),
    amountPaid: n(paid),
    amountDue: n(amountDue),
    // The canonical integer form -- this (not the display decimals above)
    // is what manifest.js hashes, so calculationHash is byte-reproducible
    // on any host. Every value has been range-checked to a safe integer.
    _minorUnits: {
      subtotal: minorToSafeInt(netTotal), lineDiscountTotal: minorToSafeInt(lineDiscountTotal),
      invoiceDiscount: minorToSafeInt(invoiceDiscount), taxableAmount: minorToSafeInt(taxableAmount),
      lineTaxTotal: minorToSafeInt(lineTaxTotal), documentTax: minorToSafeInt(documentTax),
      tax: minorToSafeInt(totalTax), shipping: minorToSafeInt(shipping), fees: minorToSafeInt(fees),
      grandTotal: minorToSafeInt(grandTotal), amountPaid: minorToSafeInt(paid), amountDue: minorToSafeInt(amountDue),
      lines: computed.map((l) => ({
        gross: minorToSafeInt(l.gross), discount: minorToSafeInt(l.discount), net: minorToSafeInt(l.net),
        allocatedDiscount: minorToSafeInt(l.allocatedDiscount), tax: minorToSafeInt(l.lineTax), total: minorToSafeInt(l.lineTotal),
      })),
      currency: cur, exponent: exp, roundingMode,
    },
  };
}

/** Original entry point kept for the invoice pipeline and its tests --
 *  same parameter names as before, now backed by the exact engine above
 *  (currency defaults to USD, which is what every pre-existing caller
 *  implicitly assumed). */
export function calculateInvoice({ lineItems, invoiceDiscountPercent = 0, taxPercent = 0, shippingAmount = 0, amountPaid = 0, currency = "USD", feeAmount = 0, invoiceDiscountAmount = 0, roundingMode = "HALF_UP" }) {
  return calculateDocument({ currency, lineItems, invoiceDiscountPercent, invoiceDiscountAmount, taxPercent, shippingAmount, feeAmount, amountPaid, roundingMode });
}

// Two-decimal helpers retained for any pre-existing importer.
export function toMinorUnits(amount) {
  return minorToSafeInt(d8ToMinor(parseDecimal(amount, "amount"), 2, "HALF_UP"));
}
export function fromMinorUnits(minorUnits) {
  return minorUnits / 100;
}
