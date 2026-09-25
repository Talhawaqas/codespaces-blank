// src/lib/documentAutomation/adapters.js
//
// Document Automation SOW §4/§7/§37 -- the DataAdapter for every document
// type. An adapter pulls AUTHORIZED source data from the existing Inaya
// modules (Finance, CRM, Procurement, Business Insights), never trusting a
// client-supplied total, org id or storage reference, and returns:
//   - a JSON-safe `snapshot` of exactly what was read (hashed into the
//     manifest as sourceDataHash, so approval can detect that the source
//     changed since the version an approver looked at)
//   - the inputs to the deterministic calculation
//   - the view-model fragments the template renders
// Every adapter fails closed: a record the actor cannot access answers
// "not found", never "forbidden", so ids cannot be enumerated.

import { getOrgCollections, toObjectId, canAccessDepartment, canAccessFinance, canManageOrg } from "../orgs.js";
import { getAccessibleScope } from "../document-permissions.js";
import { generateBusinessBrief } from "../business-brief.js";
import { isSupportedCurrency } from "../currency.js";
import { calculateDocument } from "./calculations.js";
import { addressLines, addressesDiffer } from "./settings.js";
import { label as i18nLabel, formatMoney, formatDate } from "./i18n.js";
import { parseDecimal, d8ToMinor, currencyExponent, minorToDecimalString, minorToNumber } from "./money.js";

const NOT_FOUND = (what) => ({ error: `${what} not found.`, status: 404 });
export const todayUtc = () => new Date().toISOString().slice(0, 10);
const iso = (v) => (v ? new Date(v).toISOString() : null);
const idStr = (v) => (v ? String(v) : null);
const MAX_STATEMENT_INVOICES = 500;

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function cleanLineInput(raw, idx) {
  if (!raw || typeof raw !== "object") throw new Error(`Line ${idx + 1} is invalid.`);
  const out = { description: raw.description, quantity: raw.quantity, unitPrice: raw.unitPrice };
  for (const k of ["discountPercent", "discountAmount", "taxPercent", "sku"]) if (raw[k] !== undefined && raw[k] !== null && raw[k] !== "") out[k] = raw[k];
  return out;
}

function orgSnapshot(orgDoc, settings) {
  const bp = settings.billingProfile || {};
  return {
    name: orgDoc?.name || bp.legalName || "Organization",
    legalName: bp.legalName || orgDoc?.name || null,
    address: bp.address || null,
    addressLines: bp.address ? addressLines(bp.address) : Array.isArray(orgDoc?.addressLines) ? orgDoc.addressLines : [],
    email: bp.email || orgDoc?.billingEmail || null,
    phone: bp.phone || null,
    taxId: bp.taxId || null,
    taxLabel: bp.taxLabel || null,
    website: bp.website || null,
    footerNote: bp.footerNote || null,
    brandColor: bp.brandColor || null,
    defaultTaxPercent: bp.defaultTaxPercent || 0,
    defaultPaymentTerms: bp.defaultPaymentTerms || null,
    defaultTerms: bp.defaultTerms || null,
    hasLogo: !!bp.logo,
  };
}

function customerSnapshot(contact) {
  return {
    id: idStr(contact._id), name: contact.name, company: contact.company || null, email: contact.email || null,
    phone: contact.phone || null, taxId: contact.taxId || null,
    billingAddress: contact.billingAddress || null, shippingAddress: contact.shippingAddress || null,
    paymentTerms: contact.paymentTerms || null,
  };
}

function partyView(customer) {
  const billing = addressLines(customer.billingAddress);
  const shipping = customer.shippingAddress && addressesDiffer(customer.billingAddress, customer.shippingAddress) ? addressLines(customer.shippingAddress) : [];
  return {
    party: { name: customer.name, company: customer.company && customer.company !== customer.name ? customer.company : null, email: customer.email, phone: customer.phone, taxId: customer.taxId, addressLines: billing, shipToLines: shipping },
    shippingDiffers: shipping.length > 0,
  };
}

/** Sums approved incoming payments (exact, minor units) that share the
 *  document's currency. Payments record USD today (finance/payments route),
 *  so a non-USD invoice honestly shows no payments rather than mixing
 *  currencies. */
function sumPaymentsMinor(payments, currency) {
  const exp = currencyExponent(currency);
  let total = 0n;
  const used = [];
  const skipped = [];
  for (const p of payments) {
    if ((p.currency || "USD") !== currency) { skipped.push({ id: idStr(p._id), currency: p.currency || "USD" }); continue; }
    total += d8ToMinor(parseDecimal(p.amount, "payment amount"), exp, "HALF_UP");
    used.push({ id: idStr(p._id), amount: p.amount, date: iso(p.paymentDate), createdAt: iso(p.createdAt) });
  }
  return { totalMinor: total, used, skipped };
}

function invoiceCalcInput(invoice, orgSnap, overrides = {}) {
  const ex = invoice.documentTerms || {};
  return {
    currency: invoice.currency || "USD",
    lineItems: (invoice.lineItems || []).map(cleanLineInput),
    invoiceDiscountPercent: ex.discountPercent ?? invoice.discountPercent ?? 0,
    invoiceDiscountAmount: ex.discountAmount ?? invoice.discountAmount ?? 0,
    taxPercent: ex.taxPercent ?? invoice.taxPercent ?? orgSnap.defaultTaxPercent ?? 0,
    shippingAmount: ex.shippingAmount ?? invoice.shippingAmount ?? 0,
    feeAmount: ex.feeAmount ?? invoice.feeAmount ?? 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// Invoice
// ---------------------------------------------------------------------
async function loadInvoice({ orgId, sourceId, membership, settings, orgDoc, locale }) {
  if (!canAccessFinance(membership)) return NOT_FOUND("Invoice");
  const { invoices, crmContacts, payments } = await getOrgCollections();
  const invoice = await invoices.findOne({ _id: toObjectId(sourceId), orgId: toObjectId(orgId), deletedAt: null });
  if (!invoice || !canAccessDepartment(membership, invoice.departmentId)) return NOT_FOUND("Invoice");
  const contact = await crmContacts.findOne({ _id: invoice.contactId, orgId: toObjectId(orgId), deletedAt: null });
  if (!contact) return { error: "The invoice's customer record could not be found.", status: 404 };

  const paid = await payments.find({ orgId: toObjectId(orgId), relatedInvoiceId: invoice._id, direction: "INCOMING", status: "APPROVED", deletedAt: null }).toArray();
  const currency = invoice.currency || "USD";
  const orgSnap = orgSnapshot(orgDoc, settings);
  const peers = await invoices.find({ orgId: toObjectId(orgId), contactId: invoice.contactId, _id: { $ne: invoice._id }, currency, status: { $in: ["SENT", "PAID", "OVERDUE"] }, deletedAt: null }).project({ total: 1 }).limit(200).toArray();
  const customerStats = { count: peers.length, average: peers.length ? peers.reduce((s, i) => s + (Number(i.total) || 0), 0) / peers.length : 0 };
  const paidSum = sumPaymentsMinor(paid, currency);
  const customer = customerSnapshot(contact);
  const ex = invoice.documentTerms || {};
  if (ex.shippingAddress) customer.shippingAddress = ex.shippingAddress; // per-invoice override of the customer's default
  const input = invoiceCalcInput(invoice, orgSnap, { amountPaid: minorToDecimalString(paidSum.totalMinor, currencyExponent(currency)), roundingMode: settings.defaults.roundingMode });
  const { party, shippingDiffers } = partyView(customer);

  return {
    departmentId: invoice.departmentId,
    sourceRecordType: "INVOICE", sourceRecordId: invoice._id,
    sourceRecords: [{ type: "INVOICE", id: idStr(invoice._id), version: iso(invoice.updatedAt) }, { type: "CRM_CONTACT", id: idStr(contact._id), version: iso(contact.updatedAt) }],
    snapshot: {
      invoice: { id: idStr(invoice._id), invoiceNumber: invoice.invoiceNumber, issueDate: iso(invoice.issueDate), dueDate: iso(invoice.dueDate), currency, status: invoice.status, notes: invoice.notes || null, terms: ex.terms || invoice.terms || null, reference: invoice.reference || null, poNumber: invoice.poNumber || null, paymentTerms: invoice.paymentTerms || null, updatedAt: iso(invoice.updatedAt), calcInput: input },
      customer, payments: { used: paidSum.used, skipped: paidSum.skipped }, org: orgSnap,
    },
    currency, calcInput: input, org: orgSnap,
    view: {
      doc: {
        issueDate: iso(invoice.issueDate), dueDate: iso(invoice.dueDate), currency, status: invoice.status,
        reference: invoice.reference || invoice.invoiceNumber || null, poNumber: invoice.poNumber || null,
        paymentTerms: invoice.paymentTerms || customer.paymentTerms || orgSnap.defaultPaymentTerms || null,
        notes: invoice.notes || null, terms: ex.terms || invoice.terms || orgSnap.defaultTerms || null,
      },
      party, shippingDiffers, lineSource: "lines",
    },
    counterparty: { name: customer.name, id: customer.id }, amountKey: "grandTotal",
    context: { invoice, customer, sourceStatus: invoice.status, skippedPayments: paidSum.skipped, paymentsUsed: paidSum.used, customerRecord: contact, customerStats },
  };
}

// ---------------------------------------------------------------------
// Purchase order
// ---------------------------------------------------------------------
async function loadPurchaseOrder({ orgId, sourceId, membership, settings, orgDoc }) {
  const { purchaseOrders, suppliers } = await getOrgCollections();
  const po = await purchaseOrders.findOne({ _id: toObjectId(sourceId), orgId: toObjectId(orgId), deletedAt: null });
  if (!po || !canAccessDepartment(membership, po.departmentId)) return NOT_FOUND("Purchase order");
  const supplier = await suppliers.findOne({ _id: po.supplierId, orgId: toObjectId(orgId) });
  if (!supplier) return { error: "The purchase order's supplier record could not be found.", status: 404 };
  const currency = po.currency || "USD";
  const orgSnap = orgSnapshot(orgDoc, settings);
  const missingPrice = po.items.filter((i) => i.unitPrice === null || i.unitPrice === undefined).length;
  const input = {
    currency,
    lineItems: po.items.map((i) => ({ description: i.description, quantity: i.quantity, unitPrice: i.unitPrice ?? 0, ...(i.sku ? { sku: i.sku } : {}) })),
    taxPercent: 0, roundingMode: settings.defaults.roundingMode,
  };
  const supplierSnap = { id: idStr(supplier._id), name: supplier.name, email: supplier.contactEmail || null, phone: supplier.phone || null };
  return {
    departmentId: po.departmentId, sourceRecordType: "PURCHASE_ORDER", sourceRecordId: po._id,
    sourceRecords: [{ type: "PURCHASE_ORDER", id: idStr(po._id), version: iso(po.updatedAt) }, { type: "SUPPLIER", id: idStr(supplier._id), version: iso(supplier.updatedAt) }],
    snapshot: { purchaseOrder: { id: idStr(po._id), status: po.status, currency, updatedAt: iso(po.updatedAt), items: po.items.map((i) => ({ description: i.description, sku: i.sku || null, quantity: i.quantity, unitPrice: i.unitPrice ?? null, receivedQuantity: i.receivedQuantity || 0 })) }, supplier: supplierSnap, org: orgSnap },
    currency, calcInput: input, org: orgSnap,
    view: {
      doc: { issueDate: todayUtc(), currency, status: po.status, reference: idStr(po._id).slice(-8).toUpperCase(), notes: null, terms: orgSnap.defaultTerms },
      party: { name: supplier.name, company: null, email: supplier.contactEmail || null, phone: supplier.phone || null, taxId: null, addressLines: [], shipToLines: [] },
      shippingDiffers: false, lineSource: "lines",
    },
    counterparty: { name: supplier.name, id: idStr(supplier._id) },
    context: { po, supplier, missingPrice, sourceStatus: po.status },
  };
}

// ---------------------------------------------------------------------
// Quotation (from a CRM deal)
// ---------------------------------------------------------------------
async function loadQuotation({ orgId, sourceId, membership, settings, orgDoc, options }) {
  const { crmDeals, crmContacts } = await getOrgCollections();
  const deal = await crmDeals.findOne({ _id: toObjectId(sourceId), orgId: toObjectId(orgId), deletedAt: null });
  if (!deal || !canAccessDepartment(membership, deal.departmentId)) return NOT_FOUND("Deal");
  const contact = await crmContacts.findOne({ _id: deal.contactId, orgId: toObjectId(orgId), deletedAt: null });
  if (!contact) return { error: "The deal's customer record could not be found.", status: 404 };
  const orgSnap = orgSnapshot(orgDoc, settings);
  const customer = customerSnapshot(contact);
  const currency = String(options.currency || settings.defaults.currency || "USD").toUpperCase();
  let lineItems;
  if (Array.isArray(options.lineItems) && options.lineItems.length) lineItems = options.lineItems.map(cleanLineInput);
  else if (deal.value !== null && deal.value !== undefined) lineItems = [{ description: deal.title, quantity: 1, unitPrice: deal.value }];
  else lineItems = [];
  const issueDate = options.issueDate || todayUtc();
  const validUntil = options.validUntil || addDays(issueDate, 30);
  const input = { currency, lineItems: lineItems.length ? lineItems : [{ description: deal.title, quantity: 1, unitPrice: 0 }], taxPercent: options.taxPercent ?? orgSnap.defaultTaxPercent ?? 0, invoiceDiscountPercent: options.discountPercent || 0, roundingMode: settings.defaults.roundingMode };
  const { party, shippingDiffers } = partyView(customer);
  return {
    departmentId: deal.departmentId, sourceRecordType: "CRM_DEAL", sourceRecordId: deal._id,
    sourceRecords: [{ type: "CRM_DEAL", id: idStr(deal._id), version: iso(deal.updatedAt) }, { type: "CRM_CONTACT", id: idStr(contact._id), version: iso(contact.updatedAt) }],
    snapshot: { deal: { id: idStr(deal._id), title: deal.title, value: deal.value ?? null, status: deal.status, updatedAt: iso(deal.updatedAt) }, customer, options: { currency, lineItems, issueDate, validUntil, notes: options.notes || null, terms: options.terms || null, paymentTerms: options.paymentTerms || null }, org: orgSnap },
    currency, calcInput: input, org: orgSnap,
    view: {
      doc: { issueDate, validUntil, currency, status: deal.status, reference: deal.title, paymentTerms: options.paymentTerms || customer.paymentTerms || orgSnap.defaultPaymentTerms, notes: options.notes || null, terms: options.terms || orgSnap.defaultTerms },
      party, shippingDiffers, lineSource: "lines",
    },
    counterparty: { name: customer.name, id: customer.id },
    context: { deal, customer, noLines: lineItems.length === 0, sourceStatus: deal.status },
  };
}

// ---------------------------------------------------------------------
// Receipt (from an approved incoming payment)
// ---------------------------------------------------------------------
async function loadReceipt({ orgId, sourceId, membership, settings, orgDoc }) {
  if (!canAccessFinance(membership)) return NOT_FOUND("Payment");
  const { payments, invoices, crmContacts } = await getOrgCollections();
  const payment = await payments.findOne({ _id: toObjectId(sourceId), orgId: toObjectId(orgId), deletedAt: null });
  if (!payment || !canAccessDepartment(membership, payment.departmentId)) return NOT_FOUND("Payment");
  if (payment.direction !== "INCOMING" || !payment.relatedInvoiceId) return { error: "A receipt can only be issued for an incoming payment linked to an invoice.", status: 400 };
  const invoice = await invoices.findOne({ _id: payment.relatedInvoiceId, orgId: toObjectId(orgId), deletedAt: null });
  if (!invoice) return { error: "The payment's invoice could not be found.", status: 404 };
  const contact = await crmContacts.findOne({ _id: invoice.contactId, orgId: toObjectId(orgId), deletedAt: null });
  if (!contact) return { error: "The invoice's customer record could not be found.", status: 404 };
  const currency = invoice.currency || "USD";
  const exp = currencyExponent(currency);
  const orgSnap = orgSnapshot(orgDoc, settings);
  const customer = customerSnapshot(contact);

  const invoiceCalc = calculateDocument(invoiceCalcInput(invoice, orgSnap, { roundingMode: settings.defaults.roundingMode }));
  const allPaid = await payments.find({ orgId: toObjectId(orgId), relatedInvoiceId: invoice._id, direction: "INCOMING", status: "APPROVED", deletedAt: null }).toArray();
  const uptoThis = allPaid.filter((p) => new Date(p.createdAt) <= new Date(payment.createdAt));
  const paidToDate = sumPaymentsMinor(uptoThis, currency);
  const thisPayment = (payment.currency || "USD") === currency ? d8ToMinor(parseDecimal(payment.amount, "payment amount"), exp, "HALF_UP") : 0n;
  const invoiceTotalMinor = BigInt(invoiceCalc._minorUnits.grandTotal);
  const dueMinor = invoiceTotalMinor - paidToDate.totalMinor;
  const { party, shippingDiffers } = partyView(customer);
  const n = (m) => minorToNumber(m, exp);
  const calc = {
    currency, currencyExponent: exp, subtotal: invoiceCalc.subtotal, totalTax: invoiceCalc.totalTax,
    grandTotal: invoiceCalc.grandTotal, amountPaid: n(thisPayment), amountDue: n(dueMinor),
    _minorUnits: { invoiceTotal: Number(invoiceTotalMinor), payment: Number(thisPayment), paidToDate: Number(paidToDate.totalMinor), amountDue: Number(dueMinor), currency, exponent: exp },
  };
  return {
    departmentId: payment.departmentId, sourceRecordType: "PAYMENT", sourceRecordId: payment._id,
    sourceRecords: [{ type: "PAYMENT", id: idStr(payment._id), version: iso(payment.createdAt) }, { type: "INVOICE", id: idStr(invoice._id), version: iso(invoice.updatedAt) }, { type: "CRM_CONTACT", id: idStr(contact._id), version: iso(contact.updatedAt) }],
    snapshot: { payment: { id: idStr(payment._id), amount: payment.amount, currency: payment.currency || "USD", method: payment.method || null, paymentDate: iso(payment.paymentDate), status: payment.status }, invoice: { id: idStr(invoice._id), invoiceNumber: invoice.invoiceNumber, currency, total: invoiceCalc.grandTotal, updatedAt: iso(invoice.updatedAt) }, paidToDate: paidToDate.used, customer, org: orgSnap },
    currency, calcCustom: calc, org: orgSnap,
    view: {
      doc: { issueDate: todayUtc(), currency, status: payment.status, reference: idStr(payment._id).slice(-8).toUpperCase(), originalNumber: invoice.invoiceNumber, paymentMethod: payment.method || null, paymentDate: iso(payment.paymentDate), notes: null },
      party, shippingDiffers, lineSource: null,
    },
    counterparty: { name: customer.name, id: customer.id },
    context: { payment, invoice, customer, sourceStatus: payment.status, currencyMismatch: (payment.currency || "USD") !== currency },
  };
}

// ---------------------------------------------------------------------
// Statement of account (permission-scoped across every visible invoice)
// ---------------------------------------------------------------------
async function loadStatement({ orgId, sourceId, membership, email, settings, orgDoc, options, locale }) {
  if (!canAccessFinance(membership)) return NOT_FOUND("Customer");
  const { crmContacts, payments } = await getOrgCollections();
  const contact = await crmContacts.findOne({ _id: toObjectId(sourceId), orgId: toObjectId(orgId), deletedAt: null });
  if (!contact || !canAccessDepartment(membership, contact.departmentId)) return NOT_FOUND("Customer");

  const scope = await getAccessibleScope({ orgId, membership, email });
  const invoices = scope.visibleInvoices.filter((i) => String(i.contactId) === String(contact._id) && ["SENT", "PAID", "OVERDUE"].includes(i.status));
  if (invoices.length > MAX_STATEMENT_INVOICES) return { error: `This customer has more than ${MAX_STATEMENT_INVOICES} invoices; narrow the period.`, status: 400 };
  const currencies = [...new Set(invoices.map((i) => i.currency || "USD"))];
  const currency = String(options.currency || currencies[0] || settings.defaults.currency || "USD").toUpperCase();
  if (currencies.length > 1 && !options.currency) return { error: `This customer has invoices in several currencies (${currencies.join(", ")}). Choose one currency for the statement.`, status: 400 };
  const exp = currencyExponent(currency);
  const periodTo = options.periodTo || todayUtc();
  const periodFrom = options.periodFrom || addDays(periodTo, -365);
  const orgSnap = orgSnapshot(orgDoc, settings);
  const customer = customerSnapshot(contact);

  const inCurrency = invoices.filter((i) => (i.currency || "USD") === currency);
  const visibleDeptIds = scope.visibleDepartments.map((d) => d._id);
  const invoiceIds = inCurrency.map((i) => i._id);
  const paymentDocs = invoiceIds.length && visibleDeptIds.length
    ? await payments.find({ orgId: toObjectId(orgId), departmentId: { $in: visibleDeptIds }, relatedInvoiceId: { $in: invoiceIds }, direction: "INCOMING", status: "APPROVED", deletedAt: null }).toArray()
    : [];
  const payInCurrency = paymentDocs.filter((p) => (p.currency || "USD") === currency);

  const events = [];
  for (const inv of inCurrency) {
    const calc = calculateDocument(invoiceCalcInput(inv, orgSnap, { roundingMode: settings.defaults.roundingMode }));
    events.push({ date: iso(inv.issueDate).slice(0, 10), reference: inv.invoiceNumber, kind: "invoice", charge: BigInt(calc._minorUnits.grandTotal), payment: 0n, id: idStr(inv._id) });
  }
  for (const p of payInCurrency) {
    events.push({ date: iso(p.paymentDate).slice(0, 10), reference: idStr(p._id).slice(-8).toUpperCase(), kind: "payment", charge: 0n, payment: d8ToMinor(parseDecimal(p.amount, "payment amount"), exp, "HALF_UP"), id: idStr(p._id) });
  }
  events.sort((a, b) => (a.date === b.date ? (a.kind === b.kind ? 0 : a.kind === "invoice" ? -1 : 1) : a.date < b.date ? -1 : 1));

  let opening = 0n;
  const inPeriod = [];
  for (const e of events) {
    if (e.date < periodFrom) opening += e.charge - e.payment;
    else if (e.date <= periodTo) inPeriod.push(e);
  }
  let running = opening;
  let totalCharges = 0n;
  let totalPayments = 0n;
  const n = (m) => minorToNumber(m, exp);
  const rows = inPeriod.map((e) => {
    running += e.charge - e.payment;
    totalCharges += e.charge; totalPayments += e.payment;
    return { date: e.date, reference: e.reference, kind: i18nLabel(locale, e.kind === "invoice" ? "invoiceRef" : "payments"), charge: e.charge ? n(e.charge) : null, payment: e.payment ? n(e.payment) : null, balance: n(running), __currency: currency };
  });
  const closing = running;
  const calc = {
    currency, currencyExponent: exp, openingBalance: n(opening), totalCharges: n(totalCharges), totalPayments: n(totalPayments), closingBalance: n(closing),
    grandTotal: n(closing), amountDue: n(closing), amountPaid: n(totalPayments),
    _minorUnits: { opening: Number(opening), totalCharges: Number(totalCharges), totalPayments: Number(totalPayments), closing: Number(closing), rows: inPeriod.map((e) => [e.date, e.kind, e.id, Number(e.charge), Number(e.payment)]), currency, exponent: exp },
  };
  const { party, shippingDiffers } = partyView(customer);
  return {
    departmentId: contact.departmentId, sourceRecordType: "CRM_CONTACT", sourceRecordId: contact._id,
    seriesSuffix: `${periodFrom}:${periodTo}:${currency}`,
    sourceRecords: [{ type: "CRM_CONTACT", id: idStr(contact._id), version: iso(contact.updatedAt) }, ...inCurrency.map((i) => ({ type: "INVOICE", id: idStr(i._id), version: iso(i.updatedAt) })), ...payInCurrency.map((p) => ({ type: "PAYMENT", id: idStr(p._id), version: iso(p.createdAt) }))],
    snapshot: { customer, period: { from: periodFrom, to: periodTo }, currency, events: events.map((e) => [e.date, e.kind, e.id, e.reference, Number(e.charge), Number(e.payment)]), org: orgSnap },
    currency, calcCustom: calc, org: orgSnap,
    view: { doc: { issueDate: todayUtc(), currency, periodFrom, periodTo, generatedAt: new Date().toISOString(), reference: null, notes: null }, party, shippingDiffers, lineSource: null, statementRows: rows },
    counterparty: { name: customer.name, id: customer.id },
    context: { contact, invoiceCount: inCurrency.length, rowCount: rows.length, excludedOtherCurrency: invoices.length - inCurrency.length, sourceStatus: null },
  };
}

// ---------------------------------------------------------------------
// Credit note / debit note (adjustments referencing a real invoice)
// ---------------------------------------------------------------------
function adjustmentLoader(kind) {
  return async ({ orgId, sourceId, membership, settings, orgDoc, options }) => {
    if (!canAccessFinance(membership)) return NOT_FOUND("Invoice");
    const { invoices, crmContacts, generatedDocuments } = await getOrgCollections();
    const invoice = await invoices.findOne({ _id: toObjectId(sourceId), orgId: toObjectId(orgId), deletedAt: null });
    if (!invoice || !canAccessDepartment(membership, invoice.departmentId)) return NOT_FOUND("Invoice");
    const contact = await crmContacts.findOne({ _id: invoice.contactId, orgId: toObjectId(orgId), deletedAt: null });
    if (!contact) return { error: "The invoice's customer record could not be found.", status: 404 };
    const reason = typeof options.reason === "string" ? options.reason.trim() : "";
    if (!reason) return { error: `A reason is required to issue a ${kind === "credit" ? "credit" : "debit"} note.`, status: 400 };
    if (reason.length > 500) return { error: "The reason is too long (500 characters maximum).", status: 400 };
    if (!Array.isArray(options.lineItems) || options.lineItems.length === 0) return { error: `At least one ${kind === "credit" ? "credited" : "additional charge"} line is required.`, status: 400 };

    const currency = invoice.currency || "USD";
    const exp = currencyExponent(currency);
    const orgSnap = orgSnapshot(orgDoc, settings);
    const customer = customerSnapshot(contact);
    const originalCalc = calculateDocument(invoiceCalcInput(invoice, orgSnap, { roundingMode: settings.defaults.roundingMode }));
    const input = { currency, lineItems: options.lineItems.map(cleanLineInput), taxPercent: options.taxPercent ?? invoice.taxPercent ?? orgSnap.defaultTaxPercent ?? 0, roundingMode: settings.defaults.roundingMode };

    let priorMinor = 0n;
    if (kind === "credit") {
      const prior = await generatedDocuments.find({ orgId: toObjectId(orgId), documentType: "credit_note", sourceRecordId: invoice._id, status: { $in: ["FINALIZED", "DELIVERED", "VIEWED", "PAID"] }, deletedAt: null }).toArray();
      for (const d of prior) priorMinor += BigInt(d.calculation?._minorUnits?.grandTotal || 0);
    }
    const { party, shippingDiffers } = partyView(customer);
    const issueDate = options.issueDate || todayUtc();
    return {
      departmentId: invoice.departmentId, sourceRecordType: "INVOICE", sourceRecordId: invoice._id,
      sourceRecords: [{ type: "INVOICE", id: idStr(invoice._id), version: iso(invoice.updatedAt) }, { type: "CRM_CONTACT", id: idStr(contact._id), version: iso(contact.updatedAt) }],
      snapshot: { invoice: { id: idStr(invoice._id), invoiceNumber: invoice.invoiceNumber, issueDate: iso(invoice.issueDate), currency, status: invoice.status, total: originalCalc.grandTotal, updatedAt: iso(invoice.updatedAt) }, adjustment: { kind, reason, lineItems: input.lineItems, taxPercent: input.taxPercent, issueDate }, priorCreditedMinor: Number(priorMinor), customer, org: orgSnap },
      currency, calcInput: input, org: orgSnap,
      view: {
        doc: { issueDate, currency, status: invoice.status, reference: null, originalNumber: invoice.invoiceNumber, originalDate: iso(invoice.issueDate), reason, notes: options.notes || null, terms: options.terms || orgSnap.defaultTerms },
        party, shippingDiffers, lineSource: "lines",
      },
      counterparty: { name: customer.name, id: customer.id },
      context: { invoice, customer, kind, originalTotalMinor: BigInt(originalCalc._minorUnits.grandTotal), priorCreditedMinor: priorMinor, exp, sourceStatus: invoice.status },
    };
  };
}

// ---------------------------------------------------------------------
// Delivery note (from an invoice's goods lines)
// ---------------------------------------------------------------------
async function loadDeliveryNote({ orgId, sourceId, membership, settings, orgDoc, options }) {
  if (!canAccessFinance(membership)) return NOT_FOUND("Invoice");
  const { invoices, crmContacts } = await getOrgCollections();
  const invoice = await invoices.findOne({ _id: toObjectId(sourceId), orgId: toObjectId(orgId), deletedAt: null });
  if (!invoice || !canAccessDepartment(membership, invoice.departmentId)) return NOT_FOUND("Invoice");
  const contact = await crmContacts.findOne({ _id: invoice.contactId, orgId: toObjectId(orgId), deletedAt: null });
  if (!contact) return { error: "The invoice's customer record could not be found.", status: 404 };
  const orgSnap = orgSnapshot(orgDoc, settings);
  const customer = customerSnapshot(contact);
  const delivered = options.delivered && typeof options.delivered === "object" ? options.delivered : {};
  const rows = [];
  const problems = [];
  (invoice.lineItems || []).forEach((l, i) => {
    const ordered = Number(l.quantity);
    const d = delivered[i] === undefined ? ordered : Number(delivered[i]);
    if (!Number.isFinite(d) || d < 0 || d > ordered) problems.push(`Line ${i + 1}: delivered quantity must be between 0 and ${ordered}.`);
    rows.push({ description: l.description, sku: l.sku || null, ordered, delivered: Number.isFinite(d) ? d : 0, pending: Math.max(0, ordered - (Number.isFinite(d) ? d : 0)) });
  });
  const shipLines = addressLines(customer.shippingAddress || customer.billingAddress);
  return {
    departmentId: invoice.departmentId, sourceRecordType: "INVOICE", sourceRecordId: invoice._id,
    seriesSuffix: `delivery`,
    sourceRecords: [{ type: "INVOICE", id: idStr(invoice._id), version: iso(invoice.updatedAt) }, { type: "CRM_CONTACT", id: idStr(contact._id), version: iso(contact.updatedAt) }],
    snapshot: { invoice: { id: idStr(invoice._id), invoiceNumber: invoice.invoiceNumber, status: invoice.status, updatedAt: iso(invoice.updatedAt) }, rows, customer, org: orgSnap },
    currency: invoice.currency || "USD", calcCustom: { currency: invoice.currency || "USD", currencyExponent: currencyExponent(invoice.currency || "USD"), grandTotal: 0, _minorUnits: { rows: rows.map((r) => [r.ordered, r.delivered]) } }, org: orgSnap,
    view: {
      doc: { issueDate: options.issueDate || todayUtc(), currency: invoice.currency || "USD", status: invoice.status, reference: invoice.invoiceNumber, poNumber: invoice.poNumber || null, notes: options.notes || null },
      party: { name: customer.name, company: customer.company, email: customer.email, phone: customer.phone, taxId: customer.taxId, addressLines: shipLines, shipToLines: [] },
      shippingDiffers: false, lineSource: null, deliveryLines: rows,
    },
    counterparty: { name: customer.name, id: customer.id },
    context: { invoice, problems, sourceStatus: invoice.status },
  };
}

// ---------------------------------------------------------------------
// Business report (permission-scoped Business Insights)
// ---------------------------------------------------------------------
async function loadBusinessReport({ orgId, membership, email, settings, orgDoc, options, locale }) {
  if (!["daily", "weekly", "monthly", "yearly"].includes(options.period)) return { error: "A business report period must be daily, weekly, monthly or yearly.", status: 400 };
  const period = options.period;
  const brief = await generateBusinessBrief({ orgId, membership, email, period, orgName: orgDoc?.name, includeNarrative: false });
  if (brief.error) return { error: brief.error, status: 400 };
  const orgSnap = orgSnapshot(orgDoc, settings);
  const currency = settings.defaults.currency || "USD";
  const pct = (n) => `${n > 0 ? "+" : ""}${n}%`;
  const c = brief.comparison;
  const k = brief.kpis;
  const kpiRows = [
    { label: "Revenue", value: formatMoney(c.revenue.current, currency, locale), change: pct(c.revenue.changePct) },
    { label: "Expenses", value: formatMoney(c.expenses.current, currency, locale), change: pct(c.expenses.changePct) },
    { label: "Deals won", value: String(c.dealsWon.current), change: pct(c.dealsWon.changePct) },
    { label: "Tasks completed", value: String(c.tasksCompleted.current), change: pct(c.tasksCompleted.changePct) },
    { label: "Open pipeline value", value: formatMoney(k.pipelineValue.value, currency, locale), change: "" },
    { label: "Overdue invoices", value: String(k.overdueInvoices.value), change: "" },
    { label: "Pending approvals", value: String(k.pendingApprovals.value), change: "" },
    { label: "Active employees", value: String(k.headcount.value), change: "" },
  ];
  const bulletRows = [...brief.highlights, ...brief.alerts.map((a) => `[${a.severity}] ${a.message}`)].map((text) => ({ text }));
  const to = todayUtc();
  const from = addDays(to, -brief.periodDays);
  return {
    departmentId: null, sourceRecordType: "REPORT_PERIOD", sourceRecordId: null,
    seriesSuffix: `${period}:${to}`,
    sourceRecords: [{ type: "BUSINESS_INSIGHTS", id: `${period}:${to}`, version: null }],
    snapshot: { period, from, to, kpiRows, bulletRows, org: orgSnap },
    currency, calcCustom: { currency, currencyExponent: currencyExponent(currency), grandTotal: 0, _minorUnits: { kpi: kpiRows.map((r) => [r.label, r.value, r.change]) } }, org: orgSnap,
    view: {
      doc: { issueDate: to, currency, periodFrom: from, periodTo: to, generatedAt: new Date().toISOString(), title: `${i18nLabel(locale, "businessReport")} - ${period}`, summary: `${period[0].toUpperCase()}${period.slice(1)} report for ${orgDoc?.name || "the organization"}, ${formatDate(from, locale)} - ${formatDate(to, locale)}. Figures are limited to the records the report's author is permitted to see.` },
      party: { name: "", addressLines: [], shipToLines: [] }, shippingDiffers: false, lineSource: null, kpiRows, bulletRows,
    },
    counterparty: { name: orgDoc?.name || "", id: null },
    context: { period, sourceStatus: null },
  };
}

export const ADAPTERS = {
  invoice: loadInvoice,
  purchase_order: loadPurchaseOrder,
  quotation: loadQuotation,
  receipt: loadReceipt,
  statement: loadStatement,
  credit_note: adjustmentLoader("credit"),
  debit_note: adjustmentLoader("debit"),
  delivery_note: loadDeliveryNote,
  business_report: loadBusinessReport,
};

// ---------------------------------------------------------------------
// Source pickers (Create Document -> Select Type -> Select Record)
// ---------------------------------------------------------------------
export async function listSourceRecords({ orgId, membership, email, documentType, limit = 100 }) {
  const scope = await getAccessibleScope({ orgId, membership, email });
  const { payments } = await getOrgCollections();
  const contactName = new Map(scope.visibleContacts.map((c) => [String(c._id), c.name]));
  const canFin = canAccessFinance(membership);
  const row = (id, title, subtitle, extra = {}) => ({ id: String(id), title, subtitle, ...extra });
  switch (documentType) {
    case "invoice": case "credit_note": case "debit_note": case "delivery_note":
      return canFin ? scope.visibleInvoices.slice(0, limit).map((i) => row(i._id, i.invoiceNumber, `${contactName.get(String(i.contactId)) || "Customer"} - ${i.status}`, { amount: i.total, currency: i.currency || "USD" })) : [];
    case "purchase_order":
      return scope.visiblePurchaseOrders.slice(0, limit).map((po) => row(po._id, po.title || `PO ${String(po._id).slice(-6).toUpperCase()}`, po.status, { currency: po.currency || "USD" }));
    case "quotation":
      return scope.visibleDeals.slice(0, limit).map((d) => row(d._id, d.title, `${contactName.get(String(d.contactId)) || "Customer"} - ${d.status}`, { amount: d.value ?? null }));
    case "receipt": {
      if (!canFin) return [];
      const deptIds = scope.visibleDepartments.map((d) => d._id);
      if (!deptIds.length) return [];
      const rows = await payments.find({ orgId: toObjectId(orgId), departmentId: { $in: deptIds }, direction: "INCOMING", status: "APPROVED", relatedInvoiceId: { $ne: null }, deletedAt: null }).sort({ createdAt: -1 }).limit(limit).toArray();
      return rows.map((p) => row(p._id, `Payment ${String(p._id).slice(-6).toUpperCase()}`, `${p.method || "payment"} - ${String(p.paymentDate).slice(0, 10)}`, { amount: p.amount, currency: p.currency || "USD" }));
    }
    case "statement":
      return canFin ? scope.visibleContacts.slice(0, limit).map((c) => row(c._id, c.name, c.company || c.email || c.type)) : [];
    case "business_report":
      return [row("monthly", "Monthly report", "Last 30 days"), row("weekly", "Weekly report", "Last 7 days"), row("daily", "Daily report", "Last 24 hours"), row("yearly", "Yearly report", "Last 365 days")];
    default:
      return [];
  }
}

export { canManageOrg };
