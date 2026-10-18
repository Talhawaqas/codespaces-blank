// test/einvoice-ubl.test.mjs
//
// Business Workspace gap closure, Batch 3 — UBL 2.1 / Peppol BIS Billing 3.0
// export (src/lib/einvoice/ubl.js) and the per-view URL / breadcrumb helpers
// (src/lib/business-nav.js). Pure: no database.
//
// Run with: node --test test/einvoice-ubl.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUblInvoice, validateForPeppol, partiesFrom, escapeXml, PEPPOL_CUSTOMIZATION_ID } from "../src/lib/einvoice/ubl.js";
import { viewUrl, viewFromUrl, breadcrumbs } from "../src/lib/business-nav.js";

const seller = { name: "Inaya Test GmbH", taxId: "DE123456789", email: "billing@inaya.test", address: { line1: "Hauptstr. 1", city: "Berlin", postalCode: "10115", country: "DE" } };
const buyer = { name: "Acme & Sons <Ltd>", contactName: "Dana", taxId: "NL001234567B01", email: "ap@acme.test", address: { city: "Amsterdam", country: "NL" } };
const invoice = (extra = {}) => ({
  invoiceNumber: "INV-2026-0042", status: "SENT", currency: "EUR", issueDate: "2026-10-01T00:00:00.000Z", dueDate: "2026-10-31T00:00:00.000Z",
  lineItems: [{ description: "Consulting", quantity: 10, unitPrice: 100 }, { description: "Licence", quantity: 1, unitPrice: 250 }],
  documentTerms: { taxPercent: 19, shippingAmount: 15, poNumber: "PO-7" }, total: 1502.5, ...extra,
});
const tag = (xml, name) => [...xml.matchAll(new RegExp(`<cbc:${name}[^>]*>([^<]*)</cbc:${name}>`, "g"))].map((m) => m[1]);

test("UBL: Peppol BIS 3.0 header, parties, totals that match the stored invoice", () => {
  const { xml, totals, errors } = buildUblInvoice(invoice(), { seller, buyer });
  assert.equal(errors, undefined);
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.equal(tag(xml, "CustomizationID")[0], PEPPOL_CUSTOMIZATION_ID);
  assert.equal(tag(xml, "IssueDate")[0], "2026-10-01");
  assert.equal(tag(xml, "DueDate")[0], "2026-10-31");
  assert.equal(tag(xml, "InvoiceTypeCode")[0], "380");
  assert.equal(tag(xml, "BuyerReference")[0], "PO-7");
  assert.deepEqual(tag(xml, "EndpointID"), ["billing@inaya.test", "ap@acme.test"]);
  assert.ok(xml.includes("Acme &amp; Sons &lt;Ltd&gt;"), "names are XML-escaped");
  // 1000 + 250 = 1250 net; 19% = 237.50 tax; + 15 shipping (zero-rated) = 1502.50
  assert.deepEqual(totals, { subtotal: 1250, totalTax: 237.5, grandTotal: 1502.5 });
  assert.deepEqual(tag(xml, "LineExtensionAmount"), ["1250.00", "1000.00", "250.00"], "document total first (LegalMonetaryTotal precedes the lines), then each line");
  assert.equal(tag(xml, "TaxExclusiveAmount")[0], "1265.00");
  assert.equal(tag(xml, "TaxInclusiveAmount")[0], "1502.50");
  assert.equal(tag(xml, "ChargeTotalAmount")[0], "15.00");
  assert.equal(tag(xml, "PayableAmount")[0], "1502.50");
  assert.equal((xml.match(/<cac:InvoiceLine>/g) || []).length, 2);
  assert.ok(/<cbc:TaxableAmount currencyID="EUR">1250.00<\/cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">237.50<\/cbc:TaxAmount><cac:TaxCategory><cbc:ID>S<\/cbc:ID><cbc:Percent>19<\/cbc:Percent>/.test(xml));
  assert.ok(/<cbc:TaxableAmount currencyID="EUR">15.00<\/cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">0.00<\/cbc:TaxAmount><cac:TaxCategory><cbc:ID>Z<\/cbc:ID>/.test(xml), "shipping declared zero-rated");
  // Balanced open/close tags for the elements this builder writes.
  for (const el of ["cac:InvoiceLine", "cac:Party", "cac:TaxSubtotal", "cac:AllowanceCharge"]) {
    assert.equal((xml.match(new RegExp(`<${el}>`, "g")) || []).length, (xml.match(new RegExp(`</${el}>`, "g")) || []).length, el);
  }
});

test("UBL: invoice discount is a document allowance and the totals still reconcile", () => {
  const { xml, totals } = buildUblInvoice(invoice({ documentTerms: { taxPercent: 10, discountPercent: 10 }, total: 1237.5 }), { seller, buyer });
  // 1250 - 125 = 1125; 10% tax = 112.50; total 1237.50
  assert.equal(totals.grandTotal, 1237.5);
  assert.equal(tag(xml, "AllowanceTotalAmount")[0], "125.00");
  assert.equal(tag(xml, "TaxExclusiveAmount")[0], "1125.00");
});

test("UBL: refuses rather than emitting a file that's invalid or disagrees with the invoice", () => {
  assert.ok(validateForPeppol(invoice({ status: "DRAFT" }), { seller, buyer }).some((p) => /sent, overdue or paid/.test(p)));
  const missing = validateForPeppol(invoice(), { seller: { ...seller, taxId: null, address: { city: "Berlin", country: "Germany" } }, buyer: { ...buyer, email: null } });
  assert.ok(missing.some((p) => /Seller VAT/.test(p)));
  assert.ok(missing.some((p) => /Seller address country/.test(p)));
  assert.ok(missing.some((p) => /Buyer email/.test(p)));
  assert.match(buildUblInvoice(invoice({ total: 999 }), { seller, buyer }).errors[0], /doesn't match the stored invoice total/);
  assert.equal(escapeXml(`a&b"c'<`), "a&amp;b&quot;c&apos;&lt;");
  const p = partiesFrom({ org: { name: "Org" }, billingProfile: {}, contact: { name: "Dana", company: "Acme", email: "d@a.co" } });
  assert.equal(p.seller.name, "Org");
  assert.equal(p.buyer.name, "Acme");
});

test("nav: view URLs keep unrelated params, drop another view's params, and unknown views fall back", () => {
  assert.equal(viewUrl("finance", ""), "?view=finance");
  assert.equal(viewUrl("osHome", "?view=finance"), "");
  assert.equal(viewUrl("tasks", "?view=documentAutomation&doc=abc&ref=x"), "?view=tasks&ref=x");
  assert.equal(viewUrl("documentAutomation", "?view=documentAutomation&doc=abc"), "?view=documentAutomation&doc=abc");
  assert.equal(viewFromUrl("?view=crm", ["crm"]), "crm");
  assert.equal(viewFromUrl("?view=nope", ["crm"]), "osHome");
  assert.equal(viewFromUrl("?view=projects", ["crm"]), "projects");
  assert.equal(viewFromUrl("", ["crm"]), "osHome");
});

test("nav: breadcrumbs follow the sidebar groups", () => {
  assert.deepEqual(breadcrumbs("osHome"), [{ label: "Workspace", view: null }]);
  const fin = breadcrumbs("finance", { titles: { finance: { title: "Finance" } } });
  assert.equal(fin[0].view, "osHome");
  assert.equal(fin.at(-1).label, "Finance");
  assert.equal(fin.length, 3);
  assert.equal(breadcrumbs("browse", { titles: { browse: { title: "Projects" } }, browseSection: "projects" }).at(-1).label, "Projects");
});
