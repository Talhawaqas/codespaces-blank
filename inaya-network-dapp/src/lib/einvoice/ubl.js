// src/lib/einvoice/ubl.js
//
// Business Workspace gap closure, Batch 3 — structured e-invoice export:
// a UBL 2.1 Invoice in the Peppol BIS Billing 3.0 profile (EN 16931).
//
// What this is: a standards-format file a buyer's accounting system or a
// Peppol access point can ingest. What it is NOT: transmission over the
// Peppol network (that needs a certified access point) or a country
// clearance system (ZATCA, FBR, FatturaPA, CFDI need government
// registration). Both are stated in the UI and docs.
//
// Amounts come from the same exact decimal engine that produced the stored
// invoice totals (documentAutomation/calculations.js). If the recomputed
// total doesn't match what's stored, export is refused rather than emitting
// a file that disagrees with the invoice record.

import { calculateDocument } from "../documentAutomation/calculations.js";

export const PEPPOL_CUSTOMIZATION_ID = "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0";
export const PEPPOL_PROFILE_ID = "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0";
const EXPORTABLE = ["SENT", "OVERDUE", "PAID"];

export function escapeXml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}

const dateOnly = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const isCountry = (c) => /^[A-Z]{2}$/.test(String(c || ""));
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ""));

/** Seller from the org's Document Automation billing profile; buyer from the CRM contact. */
export function partiesFrom({ org, billingProfile = {}, contact = {} }) {
  return {
    seller: {
      name: billingProfile.legalName || org?.name || null, taxId: billingProfile.taxId || null,
      email: billingProfile.email || null, address: billingProfile.address || null,
    },
    buyer: {
      name: contact.company || contact.name || null, contactName: contact.name || null, taxId: contact.taxId || null,
      email: contact.email || null, address: contact.billingAddress || null,
    },
  };
}

/** Returns a list of plain-language problems; empty means the invoice can be exported. */
export function validateForPeppol(invoice, { seller, buyer }) {
  const problems = [];
  if (!EXPORTABLE.includes(invoice?.status)) problems.push(`Only a sent, overdue or paid invoice can be exported (this one is ${invoice?.status || "unknown"}).`);
  if (!invoice?.invoiceNumber) problems.push("The invoice has no invoice number.");
  if (!Array.isArray(invoice?.lineItems) || invoice.lineItems.length === 0) problems.push("The invoice has no line items.");
  if (!/^[A-Z]{3}$/.test(String(invoice?.currency || ""))) problems.push("The invoice currency must be a 3-letter ISO code.");
  const party = (p, label, where) => {
    if (!p.name) problems.push(`${label} legal name is missing (${where}).`);
    if (!p.taxId) problems.push(`${label} VAT / tax ID is missing (${where}).`);
    if (!isEmail(p.email)) problems.push(`${label} email is missing — it's used as the Peppol electronic address (${where}).`);
    if (!p.address?.city) problems.push(`${label} address city is missing (${where}).`);
    if (!isCountry(p.address?.country)) problems.push(`${label} address country must be a 2-letter ISO code such as DE or PK (${where}).`);
  };
  party(seller, "Seller", "Documents → Settings → Billing profile");
  party(buyer, "Buyer", "the customer's CRM contact billing details");
  const rates = new Set((invoice?.lineItems || []).map((l) => (l.taxPercent === undefined || l.taxPercent === null || l.taxPercent === "" ? "default" : String(l.taxPercent))));
  const t = invoice?.documentTerms || {};
  if (rates.size > 1 && (t.discountPercent || t.discountAmount)) problems.push("An invoice-level discount combined with different tax rates per line can't be exported yet.");
  return problems;
}

function addressXml(a) {
  return `<cac:PostalAddress>${a.line1 ? `<cbc:StreetName>${escapeXml(a.line1)}</cbc:StreetName>` : ""}${a.line2 ? `<cbc:AdditionalStreetName>${escapeXml(a.line2)}</cbc:AdditionalStreetName>` : ""}<cbc:CityName>${escapeXml(a.city)}</cbc:CityName>${a.postalCode ? `<cbc:PostalZone>${escapeXml(a.postalCode)}</cbc:PostalZone>` : ""}${a.region ? `<cbc:CountrySubentity>${escapeXml(a.region)}</cbc:CountrySubentity>` : ""}<cac:Country><cbc:IdentificationCode>${escapeXml(a.country)}</cbc:IdentificationCode></cac:Country></cac:PostalAddress>`;
}

function partyXml(p) {
  return `<cac:Party><cbc:EndpointID schemeID="EM">${escapeXml(p.email)}</cbc:EndpointID><cac:PartyName><cbc:Name>${escapeXml(p.name)}</cbc:Name></cac:PartyName>${addressXml(p.address)}<cac:PartyTaxScheme><cbc:CompanyID>${escapeXml(p.taxId)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme><cac:PartyLegalEntity><cbc:RegistrationName>${escapeXml(p.name)}</cbc:RegistrationName></cac:PartyLegalEntity>${p.contactName && p.contactName !== p.name ? `<cac:Contact><cbc:Name>${escapeXml(p.contactName)}</cbc:Name></cac:Contact>` : ""}</cac:Party>`;
}

const category = (rate) => (rate > 0 ? "S" : "Z");

/**
 * Builds the UBL XML. Returns { xml, totals } or { errors: [...] }.
 * `orgDefaultTaxPercent` is the rate used for lines without their own when
 * the invoice has no stored tax term (same rule as invoice creation).
 */
export function buildUblInvoice(invoice, { seller, buyer, orgDefaultTaxPercent = 0 }) {
  const errors = validateForPeppol(invoice, { seller, buyer });
  if (errors.length) return { errors };
  const t = invoice.documentTerms || {};
  const defaultRate = Number(t.taxPercent ?? orgDefaultTaxPercent ?? 0);
  let calc;
  try {
    calc = calculateDocument({
      currency: invoice.currency, lineItems: invoice.lineItems, invoiceDiscountPercent: t.discountPercent || 0, invoiceDiscountAmount: t.discountAmount || 0,
      taxPercent: defaultRate, shippingAmount: t.shippingAmount || 0, feeAmount: t.feeAmount || 0,
    });
  } catch (e) {
    return { errors: [`The invoice amounts can't be recalculated: ${e.message}`] };
  }
  if (Math.abs(calc.grandTotal - Number(invoice.total)) > 0.005) {
    return { errors: [`The recalculated total (${calc.grandTotal}) doesn't match the stored invoice total (${invoice.total}); the tax settings may have changed since the invoice was created.`] };
  }

  const cur = calc.currency;
  const dp = calc.currencyExponent;
  const amt = (n) => `currencyID="${cur}">${Number(n).toFixed(dp)}`;
  const rateOf = (l) => (l.taxRate === null ? defaultRate : l.taxRate);

  // Tax subtotals per rate: line net (after the invoice discount) plus tax.
  const groups = new Map();
  const add = (rate, base, tax) => {
    const g = groups.get(rate) || { base: 0, tax: 0 };
    g.base += base; g.tax += tax; groups.set(rate, g);
  };
  const discountShare = calc.subtotal > 0 ? calc.invoiceDiscount / calc.subtotal : 0;
  for (const l of calc.lineItems) add(rateOf(l), l.lineNet - l.lineNet * discountShare, l.lineTax);
  // Document-level tax (lines without their own rate) isn't attributed per line by the engine.
  if (calc.tax > 0) add(defaultRate, 0, calc.tax);
  // Shipping and fees are untaxed in the calculation engine, so they're declared zero-rated.
  const charges = [["Shipping", calc.shipping], ["Fees", calc.fees]].filter(([, v]) => v > 0);
  for (const [, v] of charges) add(0, v, 0);
  const round = (n) => Number(n.toFixed(dp));
  const subtotalsXml = [...groups.entries()].map(([rate, g]) =>
    `<cac:TaxSubtotal><cbc:TaxableAmount ${amt(round(g.base))}</cbc:TaxableAmount><cbc:TaxAmount ${amt(round(g.tax))}</cbc:TaxAmount><cac:TaxCategory><cbc:ID>${category(rate)}</cbc:ID><cbc:Percent>${rate}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>`).join("");

  const allowanceXml = [
    ...(calc.invoiceDiscount > 0 ? [`<cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:AllowanceChargeReason>Discount</cbc:AllowanceChargeReason><cbc:Amount ${amt(calc.invoiceDiscount)}</cbc:Amount><cac:TaxCategory><cbc:ID>${category(defaultRate)}</cbc:ID><cbc:Percent>${defaultRate}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:AllowanceCharge>`] : []),
    ...charges.map(([reason, v]) => `<cac:AllowanceCharge><cbc:ChargeIndicator>true</cbc:ChargeIndicator><cbc:AllowanceChargeReason>${reason}</cbc:AllowanceChargeReason><cbc:Amount ${amt(v)}</cbc:Amount><cac:TaxCategory><cbc:ID>Z</cbc:ID><cbc:Percent>0</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:AllowanceCharge>`),
  ].join("");

  const chargeTotal = calc.shipping + calc.fees;
  const taxExclusive = calc.subtotal - calc.invoiceDiscount + chargeTotal;
  const linesXml = calc.lineItems.map((l, i) => {
    const rate = rateOf(l);
    const unitCode = invoice.lineItems[i]?.unitCode || "C62";
    return `<cac:InvoiceLine><cbc:ID>${i + 1}</cbc:ID><cbc:InvoicedQuantity unitCode="${escapeXml(unitCode)}">${l.quantity}</cbc:InvoicedQuantity><cbc:LineExtensionAmount ${amt(l.lineNet)}</cbc:LineExtensionAmount>${l.lineDiscount > 0 ? `<cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:AllowanceChargeReason>Discount</cbc:AllowanceChargeReason><cbc:Amount ${amt(l.lineDiscount)}</cbc:Amount></cac:AllowanceCharge>` : ""}<cac:Item><cbc:Name>${escapeXml(l.description.slice(0, 200))}</cbc:Name>${l.sku ? `<cac:SellersItemIdentification><cbc:ID>${escapeXml(l.sku)}</cbc:ID></cac:SellersItemIdentification>` : ""}<cac:ClassifiedTaxCategory><cbc:ID>${category(rate)}</cbc:ID><cbc:Percent>${rate}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item><cac:Price><cbc:PriceAmount ${amt(l.unitPrice)}</cbc:PriceAmount></cac:Price></cac:InvoiceLine>`;
  }).join("");

  const due = dateOnly(invoice.dueDate);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
<cbc:CustomizationID>${PEPPOL_CUSTOMIZATION_ID}</cbc:CustomizationID>
<cbc:ProfileID>${PEPPOL_PROFILE_ID}</cbc:ProfileID>
<cbc:ID>${escapeXml(invoice.invoiceNumber)}</cbc:ID>
<cbc:IssueDate>${dateOnly(invoice.issueDate || invoice.createdAt)}</cbc:IssueDate>
${due ? `<cbc:DueDate>${due}</cbc:DueDate>` : ""}
<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
${invoice.notes ? `<cbc:Note>${escapeXml(String(invoice.notes).slice(0, 1000))}</cbc:Note>` : ""}
<cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>
<cbc:BuyerReference>${escapeXml(t.poNumber || invoice.poNumber || invoice.invoiceNumber)}</cbc:BuyerReference>
<cac:AccountingSupplierParty>${partyXml(seller)}</cac:AccountingSupplierParty>
<cac:AccountingCustomerParty>${partyXml(buyer)}</cac:AccountingCustomerParty>
${t.paymentTerms || invoice.paymentTerms ? `<cac:PaymentTerms><cbc:Note>${escapeXml(t.paymentTerms || invoice.paymentTerms)}</cbc:Note></cac:PaymentTerms>` : ""}
${allowanceXml}
<cac:TaxTotal><cbc:TaxAmount ${amt(calc.totalTax)}</cbc:TaxAmount>${subtotalsXml}</cac:TaxTotal>
<cac:LegalMonetaryTotal><cbc:LineExtensionAmount ${amt(calc.subtotal)}</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount ${amt(taxExclusive)}</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount ${amt(calc.grandTotal)}</cbc:TaxInclusiveAmount>${calc.invoiceDiscount > 0 ? `<cbc:AllowanceTotalAmount ${amt(calc.invoiceDiscount)}</cbc:AllowanceTotalAmount>` : ""}${chargeTotal > 0 ? `<cbc:ChargeTotalAmount ${amt(chargeTotal)}</cbc:ChargeTotalAmount>` : ""}<cbc:PayableAmount ${amt(calc.grandTotal)}</cbc:PayableAmount></cac:LegalMonetaryTotal>
${linesXml}
</Invoice>
`.replace(/\n\n+/g, "\n");
  return { xml, totals: { subtotal: calc.subtotal, totalTax: calc.totalTax, grandTotal: calc.grandTotal } };
}
