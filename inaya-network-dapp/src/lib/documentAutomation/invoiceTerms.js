// src/lib/documentAutomation/invoiceTerms.js
//
// Document Automation SOW §7 -- the Phase 0 audit found the Finance invoice
// model carried only description / quantity / unit price per line (no tax,
// discount, shipping, fee, payment terms, reference, PO number or shipping
// address) and computed its stored total with floating-point addition. This
// module is the genuine-gap fix at the source: it validates the optional
// commercial terms an invoice can now carry, and computes the invoice's
// stored subtotal/total with the same exact decimal engine the generated
// document uses -- so the Finance record and the PDF can never disagree.
// Every field is optional; an invoice created the old way is unchanged.

import { calculateDocument } from "./calculations.js";
import { normalizeAddress } from "./settings.js";

const MAX_TEXT = 1500;

function optText(v, label, max, errors) {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string" || v.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(v)) { errors.push(`${label} must be text up to ${max} characters.`); return undefined; }
  return v.trim();
}

function optNumber(v, label, { min = 0, max = 1e12 } = {}, errors) {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) { errors.push(`${label} must be a number from ${min} to ${max}.`); return undefined; }
  return n;
}

/** Validates the optional commercial-term fields of an invoice request body.
 *  Returns { top, terms } (to $set) or { error }. `undefined` keys mean "not
 *  supplied" (unchanged on PATCH). */
export function parseInvoiceExtras(body) {
  const errors = [];
  const top = {};
  const terms = {};
  const pt = optText(body.paymentTerms, "paymentTerms", 200, errors); if (pt !== undefined) top.paymentTerms = pt;
  const ref = optText(body.reference, "reference", 120, errors); if (ref !== undefined) top.reference = ref;
  const po = optText(body.poNumber, "poNumber", 80, errors); if (po !== undefined) top.poNumber = po;
  const tm = optText(body.terms, "terms", MAX_TEXT, errors); if (tm !== undefined) terms.terms = tm;
  const tax = optNumber(body.taxPercent, "taxPercent", { max: 100 }, errors); if (tax !== undefined) terms.taxPercent = tax;
  const dp = optNumber(body.discountPercent, "discountPercent", { max: 100 }, errors); if (dp !== undefined) terms.discountPercent = dp;
  const da = optNumber(body.discountAmount, "discountAmount", {}, errors); if (da !== undefined) terms.discountAmount = da;
  const sh = optNumber(body.shippingAmount, "shippingAmount", {}, errors); if (sh !== undefined) terms.shippingAmount = sh;
  const fe = optNumber(body.feeAmount, "feeAmount", {}, errors); if (fe !== undefined) terms.feeAmount = fe;
  if (terms.discountPercent && terms.discountAmount) errors.push("Give an invoice discount as a percent or an amount, not both.");
  if (body.shippingAddress !== undefined) {
    const r = normalizeAddress(body.shippingAddress, "shippingAddress");
    if (r.error) errors.push(r.error); else terms.shippingAddress = r.value;
  }
  return errors.length ? { error: errors.join(" ") } : { top, terms };
}

/** Line items: description / quantity / unitPrice as before, plus optional
 *  discountPercent, discountAmount, taxPercent and sku. */
export function validateInvoiceLines(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "At least one line item is required." };
  if (raw.length > 2000) return { error: "An invoice may have at most 2000 line items." };
  const lineItems = [];
  for (const item of raw) {
    const description = String(item?.description || "").trim();
    if (!description) return { error: "Every line item needs a description." };
    if (description.length > 2000) return { error: "A line description is too long." };
    const quantity = Number(item?.quantity);
    const unitPrice = Number(item?.unitPrice);
    if (!Number.isFinite(quantity) || quantity <= 0) return { error: `Invalid quantity for "${description}".` };
    if (!Number.isFinite(unitPrice) || unitPrice < 0) return { error: `Invalid unit price for "${description}".` };
    const line = { description, quantity, unitPrice };
    for (const k of ["discountPercent", "discountAmount", "taxPercent"]) {
      if (item[k] !== undefined && item[k] !== null && item[k] !== "") {
        const n = Number(item[k]);
        if (!Number.isFinite(n) || n < 0 || (k !== "discountAmount" && n > 100)) return { error: `Invalid ${k} for "${description}".` };
        line[k] = n;
      }
    }
    if (item.sku) line.sku = String(item.sku).trim().slice(0, 64);
    lineItems.push(line);
  }
  return { lineItems };
}

/** Exact decimal subtotal/total for the Finance record. Falls back to the
 *  caller's own numbers only if the calculation rejects the input (the
 *  route surfaces that as a 400 instead). */
export function computeInvoiceTotals({ lineItems, currency, terms = {}, orgDefaultTaxPercent = 0 }) {
  const calc = calculateDocument({
    currency, lineItems, invoiceDiscountPercent: terms.discountPercent || 0, invoiceDiscountAmount: terms.discountAmount || 0,
    taxPercent: terms.taxPercent ?? orgDefaultTaxPercent ?? 0, shippingAmount: terms.shippingAmount || 0, feeAmount: terms.feeAmount || 0,
  });
  return { subtotal: calc.subtotal, total: calc.grandTotal };
}
