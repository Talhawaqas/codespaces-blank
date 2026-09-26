// src/lib/bookkeeper/common.js
//
// AI Bookkeeper SOW: shared constants and pure helpers. Nothing here touches the database.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { convert, SUPPORTED_CURRENCIES, RATES_AS_OF } from "../currency.js";

export const nowIso = () => new Date().toISOString();
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export const hmacHex = (secret, data) => createHmac("sha256", secret).update(data).digest("hex");
export const newToken = (bytes = 24) => randomBytes(bytes).toString("base64url");
export const safeEqualHex = (a, b) => { try { const x = Buffer.from(String(a), "hex"); const y = Buffer.from(String(b), "hex"); return x.length > 0 && x.length === y.length && timingSafeEqual(x, y); } catch { return false; } };
export const fail = (error, status = 400, extra = {}) => ({ error, status, ...extra });

export const SOURCE_TYPES = ["BANK_ACCOUNT", "EMAIL_INBOX", "WHATSAPP", "UPLOAD", "API"];
export const DOCUMENT_TYPES = ["SUPPLIER_INVOICE", "CUSTOMER_INVOICE", "RECEIPT", "CREDIT_NOTE", "DEBIT_NOTE", "BANK_STATEMENT", "PAYMENT_CONFIRMATION", "PURCHASE_ORDER", "UNKNOWN"];
export const DOC_STATES = ["RECEIVED", "EXTRACTED", "NEEDS_REVIEW", "DUPLICATE", "FAILED", "PROCESSED", "REJECTED"];
export const TXN_STATES = ["UNMATCHED", "SUGGESTED", "AUTO_MATCHED", "HUMAN_REVIEW", "CONFIRMED", "RECONCILED", "DISPUTED", "EXCEPTION", "REVERSED"];
export const REVIEW_TYPES = ["LOW_CONFIDENCE_EXTRACTION", "LOW_CONFIDENCE_CATEGORY", "LOW_CONFIDENCE_MATCH", "DUPLICATE", "AMOUNT_MISMATCH", "CURRENCY_MISMATCH", "MISSING_DOCUMENT", "UNMATCHED_TRANSACTION", "UNMATCHED_RECEIPT", "OVERPAYMENT", "UNDERPAYMENT", "ANOMALY", "POLICY", "PROCESSING_FAILED", "APPROVAL_PENDING"];
export const REVIEW_ACTIONS = ["approve", "reject", "edit", "rematch", "split", "merge", "mark_duplicate", "request_document", "defer", "escalate"];
export const EVENT_TYPES = ["FINANCIAL_DOCUMENT_RECEIVED", "INVOICE_EXTRACTED", "RECEIPT_EXTRACTED", "TRANSACTION_IMPORTED", "TRANSACTION_CATEGORIZED", "PAYMENT_MATCH_SUGGESTED", "PAYMENT_MATCH_CONFIRMED", "CUSTOMER_RECEIPT_MATCHED", "DUPLICATE_DETECTED", "RECONCILIATION_STARTED", "RECONCILIATION_COMPLETED", "RECONCILIATION_EXCEPTION", "HUMAN_REVIEW_STARTED", "HUMAN_REVIEW_COMPLETED", "FINANCIAL_RECORD_POSTED", "FINANCIAL_RECORD_REVERSED", "PERIOD_CLOSE_STARTED", "PERIOD_CLOSE_COMPLETED"];
export const RULES_VERSION = "bk-rules-1";
export const MODEL_LABEL = "gemini (via AI gateway)";

export const DEFAULT_CATEGORIES = ["Software / Cloud", "Software / Subscriptions", "Office & Supplies", "Travel", "Meals & Entertainment", "Utilities", "Professional Services", "Marketing", "Insurance", "Bank Fees", "Payroll & Contractors", "Rent", "Inventory / COGS", "Taxes", "Sales Revenue", "Other Income", "Uncategorized"];

export const DEFAULT_SETTINGS = {
  // Separate confidence dimensions. Auto-processing needs EVERY dimension at or above its threshold (the reference "99%" is a default, not a constant).
  thresholds: { extraction: 0.99, categorization: 0.99, match: 0.99, anomaly: 0.5 },
  autoProcess: { enabled: true, maxAmount: 1000, requireKnownCounterparty: true, requirePurchaseOrderAbove: 5000 },
  highRiskAmount: 10000, highRiskCategories: ["Payroll & Contractors", "Taxes", "Insurance"],
  matching: { dateWindowDays: 7, amountTolerance: 0.01, feeTolerancePct: 0.03, maxCombination: 6 },
  categories: DEFAULT_CATEGORIES,
  learnFromReview: true,
  notifications: { failedSync: true, highPriorityException: true, duplicate: true, periodClose: true },
  retentionDays: 2555,
};

/** Money helpers work in minor units to avoid float drift in comparisons. */
export const cents = (n) => Math.round(Number(n) * 100);
export const fromCents = (c) => Math.round(c) / 100;

export function parseAmount(raw) {
  if (raw === null || raw === undefined) return NaN;
  if (typeof raw === "number") return raw;
  let s = String(raw).trim(); if (!s) return NaN;
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s) || /-$/.test(s) || /^[^\d]*-/.test(s);
  s = s.replace(/[^\d.,]/g, "");
  if (!s) return NaN;
  const lastDot = s.lastIndexOf("."); const lastComma = s.lastIndexOf(",");
  if (lastDot > -1 && lastComma > -1) s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (lastComma > -1) { const parts = s.split(","); s = parts.length > 2 || (parts[1].length === 3 && parts[0].length <= 3 && parts[0] !== "0") ? s.replace(/,/g, "") : s.replace(",", "."); }
  else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, "");
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : NaN;
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
/** Returns YYYY-MM-DD or null. Accepts ISO, DD/MM/YYYY, MM/DD/YYYY (only when unambiguous), "12 Mar 2026", "Mar 12, 2026", OFX YYYYMMDD. */
export function parseDate(raw, { dayFirst = true } = {}) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim(); if (!s) return null;
  const ok = (y, m, d) => { const dt = new Date(Date.UTC(y, m, d)); return dt.getUTCFullYear() === y && dt.getUTCMonth() === m && dt.getUTCDate() === d ? `${String(y).padStart(4, "0")}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null; };
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s); if (m) return ok(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{4})(\d{2})(\d{2})(?:\d{0,6})?(?:\[.*\])?$/.exec(s); if (m) return ok(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/.exec(s);
  if (m) { let y = +m[3]; if (y < 100) y += 2000; const a = +m[1], b = +m[2]; if (a > 12) return ok(y, b - 1, a); if (b > 12) return ok(y, a - 1, b); return dayFirst ? ok(y, b - 1, a) : ok(y, a - 1, b); }
  m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})$/.exec(s); if (m && MONTHS[m[2].toLowerCase()] !== undefined) return ok(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s); if (m && MONTHS[m[1].toLowerCase()] !== undefined) return ok(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  return null;
}
export const daysBetween = (a, b) => Math.abs(Math.round((Date.parse(a) - Date.parse(b)) / 86400000));

const SUFFIXES = /\b(inc|llc|ltd|limited|corp|corporation|co|company|gmbh|pvt|pty|plc|sa|ag|bv|fze|llp|lp)\b\.?/gi;
export const normText = (t) => String(t || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9؀-ۿ ]+/g, " ").replace(/\s+/g, " ").trim();
export const normVendor = (t) => normText(String(t || "").replace(SUFFIXES, " "));
export const normInvoiceNo = (t) => String(t || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^0+(?=\d)/, "");

/** Dice coefficient on character bigrams (0..1). */
export function similarity(a, b) {
  const x = normText(a), y = normText(b); if (!x || !y) return 0; if (x === y) return 1; if (x.length < 2 || y.length < 2) return 0;
  const grams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const A = grams(x), B = grams(y); let inter = 0; for (const [g, n] of A) inter += Math.min(n, B.get(g) || 0);
  return (2 * inter) / (x.length - 1 + y.length - 1);
}
export const vendorSimilarity = (a, b) => { const x = normVendor(a), y = normVendor(b); if (!x || !y) return 0; if (x === y) return 1; if (x.includes(y) || y.includes(x)) return Math.max(0.9, similarity(x, y)); return similarity(x, y); };

/** Amount comparison in the transaction's own currency. Different currencies: convert with the dated reference table and say so; unsupported pair -> not comparable. */
export function comparableAmount(amount, from, to) {
  if (!from || !to || from === to) return { amount, converted: false, rateDate: null, rate: 1 };
  const c = convert(amount, from, to);
  if (c.error) return { error: c.error };
  return { amount: c.convertedAmount, converted: true, rateDate: c.ratesAsOf, rate: c.rate };
}
export { SUPPORTED_CURRENCIES, RATES_AS_OF };
export const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
export const round4 = (n) => Math.round(n * 10000) / 10000;
export const pct = (n) => `${(Math.round(n * 1000) / 10).toFixed(1)}%`;
