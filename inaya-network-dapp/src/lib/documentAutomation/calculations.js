// src/lib/documentAutomation/calculations.js
//
// Native Document & Invoice Automation Engine SOW, Section 8. The Phase 0
// audit found the existing computeTotal() (finance/invoices/route.js)
// does naive floating-point money arithmetic:
//   lineItems.reduce((sum,item) => sum + item.quantity*item.unitPrice, 0)
// -- exactly the class of bug the SOW's "no unsafe floating-point money
// arithmetic" rule exists to prevent (0.1 + 0.2 !== 0.3 in IEEE 754).
// This module is the genuine gap: all real money math for a GENERATED
// document runs in integer minor units (cents), never floating point,
// with deterministic rounding applied once, at the end of each step.
//
// This does NOT change the existing invoices collection's stored
// subtotal/total (finance/invoices/route.js is untouched) -- it exists
// so the DOCUMENT (the PDF/manifest this SOW generates) reflects a
// canonical, reproducible calculation, per Section 8's "the PDF must
// reflect the canonical stored calculation" and Section 24's
// reproducibility requirement.

// All five of this app's supported currencies (currency.js) are treated
// as 2-decimal-place, matching that module's own existing Math.round(...
// * 100) / 100 precedent -- not re-deriving a full ISO 4217 minor-unit
// table for currencies this codebase doesn't otherwise support.
const MINOR_UNIT_DIGITS = 2;
const MINOR_UNIT_SCALE = 10 ** MINOR_UNIT_DIGITS;

/** Converts a decimal amount (e.g. 19.99) to integer minor units (1999)
 *  -- the ONLY point a floating-point number is read, and only ever to
 *  round it once, immediately, to the nearest cent. Every downstream
 *  calculation operates on the resulting integer. */
function toMinorUnits(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) throw new Error(`Invalid amount: ${amount}`);
  return Math.round(n * MINOR_UNIT_SCALE);
}

function fromMinorUnits(minorUnits) {
  return minorUnits / MINOR_UNIT_SCALE;
}

/** Real banker's-rounding-free, deterministic round-half-up on an
 *  already-integer minor-unit value produced by a percentage
 *  calculation (which itself must go through integer math, not
 *  `amount * pct / 100` in floating point). */
function applyPercent(minorUnits, percent) {
  // percent is itself allowed to carry up to 2 decimal places (e.g.
  // 8.25% tax) -- scaled into an integer alongside minorUnits so the
  // entire operation stays in integer arithmetic until the final divide.
  const percentScaled = Math.round(Number(percent) * 100); // 8.25 -> 825
  return Math.round((minorUnits * percentScaled) / 10000);
}

/**
 * @typedef {Object} LineItemInput
 * @property {string} description
 * @property {number} quantity
 * @property {number} unitPrice
 * @property {number} [discountPercent]
 * @property {number} [taxPercent]
 */

/**
 * Computes a full, deterministic, reproducible invoice calculation in
 * integer minor units throughout -- SOW Section 8's exact list
 * (subtotal, line discounts, invoice-level discount, taxable amount,
 * tax, shipping, grand total). Returns both the minor-unit integers
 * (for hashing -- see manifest.js) and the decimal amounts (for
 * display/PDF rendering).
 *
 * @param {Object} params
 * @param {LineItemInput[]} params.lineItems
 * @param {number} [params.invoiceDiscountPercent]
 * @param {number} [params.taxPercent] - applied to the taxable amount (post-discount)
 * @param {number} [params.shippingAmount]
 * @param {number} [params.amountPaid]
 */
export function calculateInvoice({ lineItems, invoiceDiscountPercent = 0, taxPercent = 0, shippingAmount = 0, amountPaid = 0 }) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw new Error("At least one line item is required.");
  }

  const lines = lineItems.map((item) => {
    const quantity = Number(item.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`Invalid quantity for "${item.description}".`);
    const unitPriceMinor = toMinorUnits(item.unitPrice);
    if (unitPriceMinor < 0) throw new Error(`Invalid unit price for "${item.description}".`);

    // Quantity can be fractional (e.g. 2.5 hours) -- computed in minor
    // units then rounded once, not accumulated as a running float.
    const lineGrossMinor = Math.round(unitPriceMinor * quantity);
    const lineDiscountMinor = item.discountPercent ? applyPercent(lineGrossMinor, item.discountPercent) : 0;
    const lineNetMinor = lineGrossMinor - lineDiscountMinor;
    const lineTaxMinor = item.taxPercent ? applyPercent(lineNetMinor, item.taxPercent) : 0;
    const lineTotalMinor = lineNetMinor + lineTaxMinor;

    return {
      description: String(item.description),
      quantity, unitPrice: fromMinorUnits(unitPriceMinor),
      lineDiscount: fromMinorUnits(lineDiscountMinor),
      lineTax: fromMinorUnits(lineTaxMinor),
      lineTotal: fromMinorUnits(lineTotalMinor),
      _lineNetMinor: lineNetMinor, _lineTaxMinor: lineTaxMinor,
    };
  });

  const subtotalMinor = lines.reduce((sum, l) => sum + toMinorUnits(l.lineTotal) - l._lineTaxMinor, 0);
  const lineTaxTotalMinor = lines.reduce((sum, l) => sum + l._lineTaxMinor, 0);
  const taxableBaseMinor = lines.reduce((sum, l) => sum + l._lineNetMinor, 0);

  const invoiceDiscountMinor = invoiceDiscountPercent ? applyPercent(taxableBaseMinor, invoiceDiscountPercent) : 0;
  const postDiscountBaseMinor = taxableBaseMinor - invoiceDiscountMinor;
  const invoiceLevelTaxMinor = taxPercent ? applyPercent(postDiscountBaseMinor, taxPercent) : 0;
  const shippingMinor = toMinorUnits(shippingAmount || 0);

  const grandTotalMinor = postDiscountBaseMinor + invoiceLevelTaxMinor + lineTaxTotalMinor + shippingMinor;
  const amountPaidMinor = toMinorUnits(amountPaid || 0);
  const amountDueMinor = grandTotalMinor - amountPaidMinor;

  return {
    lineItems: lines.map(({ _lineNetMinor, _lineTaxMinor, ...rest }) => rest),
    subtotal: fromMinorUnits(taxableBaseMinor),
    invoiceDiscount: fromMinorUnits(invoiceDiscountMinor),
    lineTaxTotal: fromMinorUnits(lineTaxTotalMinor),
    tax: fromMinorUnits(invoiceLevelTaxMinor),
    shipping: fromMinorUnits(shippingMinor),
    grandTotal: fromMinorUnits(grandTotalMinor),
    amountPaid: fromMinorUnits(amountPaidMinor),
    amountDue: fromMinorUnits(amountDueMinor),
    // Minor-unit integers included explicitly -- this is what
    // manifest.js hashes, never the floating-point decimals, so the
    // calculation hash is reproducible byte-for-byte across runs/hosts.
    _minorUnits: { subtotal: taxableBaseMinor, invoiceDiscount: invoiceDiscountMinor, tax: invoiceLevelTaxMinor + lineTaxTotalMinor, shipping: shippingMinor, grandTotal: grandTotalMinor, amountPaid: amountPaidMinor, amountDue: amountDueMinor },
  };
}

export { toMinorUnits, fromMinorUnits };
