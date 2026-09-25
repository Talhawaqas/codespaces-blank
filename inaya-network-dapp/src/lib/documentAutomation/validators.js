// src/lib/documentAutomation/validators.js
//
// Document Automation SOW §11/§27 -- the Validator step of the pipeline
// (Document -> Validation -> Approval) and the explainability surface.
//
// Everything here is deterministic and rule-based: each check records the
// rule that fired and the exact values it looked at, so an auditor (or the
// approver) can see WHY a warning exists -- inputs, checks, rules, outputs --
// without any model's reasoning being exposed (§11). An `error` blocks
// generation (missing/invalid source data must never yield a document that
// looks complete); a `warning` is surfaced to the approver and stored with
// the document. AI, where used, only ever summarizes these findings (see
// aiAssist.js) and can neither change them nor a total.

import { detectPromptInjection } from "../aiSecurity/promptInjection.js";

const UNSUPPORTED_SCRIPT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Devanagari}\p{Script=Thai}\p{Script=Hebrew}\p{Script=Bengali}\p{Script=Tamil}]/u;

function check(id, severity, message, rule, inputs = {}) {
  return { id, severity, message, rule, inputs };
}

function collectStrings(value, out = [], depth = 0) {
  if (depth > 6 || out.length > 2000) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out, depth + 1));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => collectStrings(v, out, depth + 1));
  return out;
}

const PRICED = ["invoice", "quotation", "purchase_order", "credit_note", "debit_note"];
const ISSUED_INVOICE_STATES = ["SENT", "PAID", "OVERDUE"];
const APPROVED_PO_STATES = ["APPROVED", "ORDERED", "PARTIALLY_RECEIVED", "RECEIVED"];

/**
 * @param {Object} p
 * @param {string} p.documentType
 * @param {Object} p.adapted   adapter output
 * @param {Object} p.calc      calculation result
 */
export function runValidators({ documentType, adapted, calc }) {
  const checks = [];
  const { org, snapshot, context = {} } = adapted;
  const view = adapted.view;

  if (adapted.error) return { checks: [check("SOURCE_ERROR", "error", adapted.error, "Source data could not be loaded.")], errors: 1, warnings: 0, passed: false };

  if (!org?.address && !(org?.addressLines || []).length) checks.push(check("ORG_ADDRESS_MISSING", "warning", "The organization's address is not set, so it will not appear on the document.", "billingProfile.address is empty", { field: "billingProfile.address" }));
  if (!org?.taxId && (calc.totalTax || 0) > 0) checks.push(check("ORG_TAX_ID_MISSING", "warning", "Tax is charged but the organization's tax ID is not set.", "totalTax > 0 and billingProfile.taxId is empty", { totalTax: calc.totalTax }));

  if (PRICED.includes(documentType) || documentType === "receipt") {
    if (!calc.currency) checks.push(check("CURRENCY_MISSING", "error", "The document has no currency.", "currency is required"));
  }
  if (PRICED.includes(documentType) && !(calc.grandTotal > 0)) checks.push(check("ZERO_TOTAL", "error", "The document total is zero, so there is nothing to issue.", "grandTotal must be greater than 0", { grandTotal: calc.grandTotal }));

  const customer = snapshot?.customer;
  if (customer && ["invoice", "quotation", "credit_note", "debit_note", "statement"].includes(documentType)) {
    if (!customer.email) checks.push(check("CUSTOMER_EMAIL_MISSING", "info", "The customer has no email address on record.", "customer.email is empty", { customer: customer.name }));
    if (!customer.billingAddress) checks.push(check("CUSTOMER_ADDRESS_MISSING", "warning", "The customer has no billing address on record.", "customer.billingAddress is empty", { customer: customer.name }));
  }

  switch (documentType) {
    case "invoice": {
      const inv = context.invoice;
      if (inv.status === "CANCELLED") checks.push(check("INVOICE_CANCELLED", "error", "This invoice is cancelled and cannot be issued as a document.", "invoice.status is CANCELLED", { status: inv.status }));
      if (inv.dueDate && inv.issueDate && new Date(inv.dueDate) < new Date(inv.issueDate)) checks.push(check("DUE_BEFORE_ISSUE", "warning", "The due date is earlier than the issue date.", "dueDate < issueDate", { issueDate: inv.issueDate, dueDate: inv.dueDate }));
      if (calc.amountDue < 0) checks.push(check("OVERPAID", "warning", "Approved payments exceed the invoice total.", "amountDue < 0", { amountDue: calc.amountDue }));
      if (inv.status === "PAID" && calc.amountDue > 0) checks.push(check("PAID_BUT_BALANCE", "warning", "The invoice is marked PAID but approved payments do not cover the total.", "status PAID and amountDue > 0", { amountDue: calc.amountDue }));
      if ((context.skippedPayments || []).length) checks.push(check("PAYMENTS_OTHER_CURRENCY", "warning", "Some payments are in a different currency and were not counted toward this invoice.", "payment.currency != invoice.currency", { skipped: context.skippedPayments }));
      if (context.customerStats?.count >= 3 && calc.grandTotal > context.customerStats.average * 10) checks.push(check("ANOMALY_LARGE_TOTAL", "warning", `This total is more than 10x this customer's average invoice (${context.customerStats.average.toFixed(2)}).`, "grandTotal > 10 x average of the customer's previous invoices (needs >= 3)", { grandTotal: calc.grandTotal, average: context.customerStats.average, priorInvoices: context.customerStats.count }));
      break;
    }
    case "purchase_order": {
      const po = context.po;
      if (!APPROVED_PO_STATES.includes(po.status)) checks.push(check("PO_NOT_APPROVED", "error", `Only an approved purchase order can be issued as a document (this one is ${po.status}).`, "purchaseOrder.status must be APPROVED, ORDERED, PARTIALLY_RECEIVED or RECEIVED (the existing procurement approval flow)", { status: po.status }));
      if (context.missingPrice > 0) checks.push(check("PO_MISSING_PRICES", "warning", `${context.missingPrice} line(s) have no unit price and are shown as 0.`, "item.unitPrice is null", { lines: context.missingPrice }));
      break;
    }
    case "quotation": {
      if (context.noLines) checks.push(check("NO_AMOUNT", "error", "The deal has no value and no quotation lines were supplied.", "deal.value is null and options.lineItems is empty"));
      const q = view.doc;
      if (q.validUntil && q.issueDate && q.validUntil < q.issueDate) checks.push(check("VALID_UNTIL_PAST", "error", "The quotation's validity date is before its issue date.", "validUntil < issueDate", { issueDate: q.issueDate, validUntil: q.validUntil }));
      if (context.deal?.status === "LOST") checks.push(check("DEAL_LOST", "warning", "This deal is marked LOST.", "deal.status is LOST"));
      break;
    }
    case "receipt": {
      if (context.payment.status !== "APPROVED") checks.push(check("PAYMENT_NOT_APPROVED", "error", "A receipt can only be issued for an approved payment.", "payment.status must be APPROVED", { status: context.payment.status }));
      if (context.currencyMismatch) checks.push(check("RECEIPT_CURRENCY_MISMATCH", "error", "The payment's currency differs from the invoice's, so a receipt cannot be issued.", "payment.currency != invoice.currency"));
      break;
    }
    case "statement": {
      if (context.rowCount === 0 && calc.openingBalance === 0) checks.push(check("EMPTY_STATEMENT", "warning", "There is no activity or balance for this customer in the period.", "no rows and opening balance is 0"));
      if (context.excludedOtherCurrency > 0) checks.push(check("STATEMENT_OTHER_CURRENCY", "info", `${context.excludedOtherCurrency} invoice(s) in other currencies are not included.`, "invoice.currency != statement currency"));
      break;
    }
    case "credit_note": case "debit_note": {
      const inv = context.invoice;
      if (!ISSUED_INVOICE_STATES.includes(inv.status)) checks.push(check("INVOICE_NOT_ISSUED", "error", `A ${documentType === "credit_note" ? "credit" : "debit"} note can only reference an issued invoice (this one is ${inv.status}).`, "invoice.status must be SENT, PAID or OVERDUE", { status: inv.status }));
      if (documentType === "credit_note") {
        const thisMinor = BigInt(calc._minorUnits.grandTotal);
        if (thisMinor + context.priorCreditedMinor > context.originalTotalMinor) checks.push(check("CREDIT_EXCEEDS_INVOICE", "error", "Credit notes would exceed the invoice total.", "this credit + previously issued credit notes > invoice total (minor units)", { thisCredit: Number(thisMinor), alreadyCredited: Number(context.priorCreditedMinor), invoiceTotal: Number(context.originalTotalMinor) }));
      }
      break;
    }
    case "delivery_note": {
      for (const p of context.problems || []) checks.push(check("DELIVERY_QUANTITY", "error", p, "0 <= delivered <= ordered"));
      if (!ISSUED_INVOICE_STATES.includes(context.invoice.status)) checks.push(check("INVOICE_NOT_ISSUED", "error", `A delivery note needs an issued invoice (this one is ${context.invoice.status}).`, "invoice.status must be SENT, PAID or OVERDUE", { status: context.invoice.status }));
      break;
    }
    default: break;
  }

  const strings = collectStrings({ snapshot: adapted.snapshot });
  const offending = strings.find((s) => UNSUPPORTED_SCRIPT_RE.test(s));
  if (offending) checks.push(check("UNSUPPORTED_SCRIPT", "warning", "Some text uses a script the bundled fonts do not cover (e.g. Chinese, Japanese, Korean, Hebrew, Devanagari); those characters may print blank.", "text contains a script outside Latin/Greek/Cyrillic/Arabic", { sample: offending.slice(0, 40) }));

  const injected = strings.find((s) => detectPromptInjection(s).detected);
  if (injected) checks.push(check("PROMPT_INJECTION_IN_SOURCE", "warning", "A source field contains text that looks like an instruction to an AI system. It is printed as plain text and never interpreted; AI summaries are disabled for this document.", "AI Security promptInjection patterns matched a source string", { sample: injected.slice(0, 60) }));

  const errors = checks.filter((c) => c.severity === "error").length;
  const warnings = checks.filter((c) => c.severity === "warning").length;
  return { checks, errors, warnings, passed: errors === 0 };
}
