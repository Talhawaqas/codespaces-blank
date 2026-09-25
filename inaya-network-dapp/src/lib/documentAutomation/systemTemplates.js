// src/lib/documentAutomation/systemTemplates.js
//
// Document Automation SOW §38 -- the initial template registry. All ten
// templates are plain data in the safe template language of
// templateSchema.js (no code); they are validated at load by the test
// suite and hashed so every generated document records the exact template
// version and hash it used (§23). They are immutable: an organization
// customizes one by cloning it into its own versioned template, never by
// editing these.

import { validateTemplateSpec, TEMPLATE_SCHEMA_ID } from "./templateSchema.js";

const cond = {
  hasTax: { path: "calc.totalTax", op: "gt", value: 0 },
  hasLineDiscount: { path: "calc.lineDiscountTotal", op: "gt", value: 0 },
  hasInvoiceDiscount: { path: "calc.invoiceDiscount", op: "gt", value: 0 },
  hasShipping: { path: "calc.shipping", op: "gt", value: 0 },
  hasFees: { path: "calc.fees", op: "gt", value: 0 },
  hasPaid: { path: "flags.hasAmountPaid", op: "truthy" },
  notes: { path: "doc.notes", op: "exists" },
  terms: { path: "doc.terms", op: "exists" },
  approvalRequired: { path: "approval.required", op: "truthy" },
};

const dateField = (labelKey, path, when) => ({ labelKey, value: `{{${path}|date}}`, ...(when ? { when } : {}) });
const textField = (labelKey, path) => ({ labelKey, value: `{{${path}}}`, when: { path, op: "exists" } });

const partyColumn = (titleLabel, lineRefs) => ({ titleLabel, lines: lineRefs });
const customerLines = ["{{party.name}}", "{{party.company}}", "{{party.addressLines}}", "{{party.email}}", "{{party.phone}}"];

const footer = { text: "{{org.footerNote}}", pageNumbers: true, showDocumentId: true, showHash: true, showVerify: true };

function header(titleLabel, fields) {
  return { type: "header", titleLabel, showLogo: true, showOrgAddress: true, showTaxId: true, fields };
}

const approvalBlocks = [
  { type: "approval", when: cond.approvalRequired },
  { type: "signature", when: cond.approvalRequired, lines: [{ labelKey: "authorizedSignatory", path: "approval.approvedBy" }] },
];

const priceTotals = (extra = []) => ({
  type: "totals",
  rows: [
    { labelKey: "subtotal", path: "calc.subtotal" },
    { labelKey: "discount", path: "calc.lineDiscountTotal", negate: true, when: cond.hasLineDiscount },
    { labelKey: "invoiceDiscount", path: "calc.invoiceDiscount", negate: true, when: cond.hasInvoiceDiscount },
    { labelKey: "tax", path: "calc.totalTax", when: cond.hasTax },
    { labelKey: "shipping", path: "calc.shipping", when: cond.hasShipping },
    { labelKey: "fees", path: "calc.fees", when: cond.hasFees },
    { labelKey: "total", path: "calc.grandTotal", emphasize: true },
    ...extra,
  ],
});

const paidRows = [
  { labelKey: "amountPaid", path: "calc.amountPaid", negate: true, when: cond.hasPaid },
  { labelKey: "amountDue", path: "calc.amountDue", emphasize: true, when: cond.hasPaid },
];

const lineTable = (columns) => ({ type: "table", source: "lines", repeatHeader: true, columns });

const metaCommon = {
  type: "meta", columns: 3,
  fields: [
    textField("reference", "doc.reference"), textField("poNumber", "doc.poNumber"),
    textField("paymentTerms", "doc.paymentTerms"), { labelKey: "customerTaxId", value: "{{party.taxId}}", when: { path: "party.taxId", op: "exists" } },
  ],
};
const notesBlocks = [
  { type: "text", titleLabel: "notes", text: "{{doc.notes}}", when: cond.notes },
  { type: "text", titleLabel: "terms", text: "{{doc.terms}}", when: cond.terms, muted: true },
];

function tpl(key, documentType, name, description, spec) {
  const full = { schema: TEMPLATE_SCHEMA_ID, documentType, name, description, footer, ...spec };
  const result = validateTemplateSpec(full);
  if (!result.valid) throw new Error(`System template "${key}" is invalid: ${result.errors.join("; ")}`);
  return { templateId: `system:${key}`, key, documentType, version: 1, versionLabel: "1.0.0", name, isSystem: true, status: "PUBLISHED", spec: result.spec, specHash: result.specHash };
}

const invoiceHeaderFields = [
  { labelKey: "number", value: "{{doc.number}}" },
  dateField("issueDate", "doc.issueDate"),
  dateField("dueDate", "doc.dueDate", { path: "doc.dueDate", op: "exists" }),
];

const templates = [
  tpl("standard-invoice", "invoice", "Standard Invoice", "Clean single-currency invoice with line items, tax, discount and shipping.", {
    style: { accentColor: "#2e3a5c" },
    requiredSources: ["invoice", "customer", "organization"],
    blocks: [
      header("invoice", invoiceHeaderFields),
      { type: "parties", columns: [partyColumn("billTo", customerLines), { ...partyColumn("shipTo", ["{{party.shipToLines}}"]), when: { path: "flags.shippingAddressDiffers", op: "truthy" } }] },
      metaCommon,
      lineTable([
        { key: "description", labelKey: "description", width: 40 },
        { key: "quantity", labelKey: "quantity", format: "number", width: 10, align: "end" },
        { key: "unitPrice", labelKey: "unitPrice", format: "currency", width: 17, align: "end" },
        { key: "lineTax", labelKey: "tax", format: "currency", width: 14, align: "end" },
        { key: "lineTotal", labelKey: "lineTotal", format: "currency", width: 19, align: "end" },
      ]),
      priceTotals(paidRows),
      ...notesBlocks, ...approvalBlocks,
    ],
  }),
  tpl("professional-invoice", "invoice", "Professional Invoice", "Detailed invoice with SKU, line discounts and a branded accent.", {
    style: { accentColor: "#0a5f6e", fontScale: 1 },
    requiredSources: ["invoice", "customer", "organization"],
    blocks: [
      header("invoice", [...invoiceHeaderFields, { labelKey: "version", value: "v{{doc.version}}", when: { path: "doc.version", op: "gt", value: 1 } }]),
      { type: "divider" },
      { type: "parties", columns: [partyColumn("billTo", customerLines), { ...partyColumn("shipTo", ["{{party.shipToLines}}"]), when: { path: "flags.shippingAddressDiffers", op: "truthy" } }, partyColumn("from", ["{{org.legalName}}", "{{org.email}}", "{{org.phone}}"])] },
      metaCommon,
      lineTable([
        { key: "sku", labelKey: "sku", width: 10 },
        { key: "description", labelKey: "description", width: 28 },
        { key: "quantity", labelKey: "quantity", format: "number", width: 8, align: "end" },
        { key: "unitPrice", labelKey: "unitPrice", format: "currency", width: 14, align: "end" },
        { key: "lineDiscount", labelKey: "discount", format: "currency", width: 13, align: "end" },
        { key: "lineTax", labelKey: "tax", format: "currency", width: 12, align: "end" },
        { key: "lineTotal", labelKey: "lineTotal", format: "currency", width: 15, align: "end" },
      ]),
      priceTotals([{ labelKey: "taxableAmount", path: "calc.taxableAmount", when: cond.hasTax }, ...paidRows]),
      ...notesBlocks, ...approvalBlocks,
    ],
  }),
  tpl("purchase-order", "purchase_order", "Purchase Order", "Purchase order issued to a supplier from an approved procurement record.", {
    style: { accentColor: "#3b3f73" },
    requiredSources: ["purchase_order", "supplier", "organization"],
    blocks: [
      header("purchaseOrder", [{ labelKey: "number", value: "{{doc.number}}" }, dateField("issueDate", "doc.issueDate"), { labelKey: "status", value: "{{doc.status}}" }]),
      { type: "parties", columns: [partyColumn("supplier", ["{{party.name}}", "{{party.addressLines}}", "{{party.email}}", "{{party.phone}}"]), partyColumn("from", ["{{org.legalName}}", "{{org.addressLines}}", "{{org.email}}"])] },
      { type: "meta", columns: 3, fields: [textField("reference", "doc.reference"), textField("paymentTerms", "doc.paymentTerms")] },
      lineTable([
        { key: "sku", labelKey: "sku", width: 14 },
        { key: "description", labelKey: "description", width: 38 },
        { key: "quantity", labelKey: "quantity", format: "number", width: 10, align: "end" },
        { key: "unitPrice", labelKey: "unitPrice", format: "currency", width: 18, align: "end" },
        { key: "lineTotal", labelKey: "lineTotal", format: "currency", width: 20, align: "end" },
      ]),
      { type: "totals", rows: [{ labelKey: "total", path: "calc.grandTotal", emphasize: true }] },
      ...notesBlocks, ...approvalBlocks,
    ],
  }),
  tpl("quotation", "quotation", "Quotation", "Customer quotation derived from a CRM deal, with a validity date.", {
    style: { accentColor: "#5a3b73" },
    requiredSources: ["deal", "customer", "organization"],
    blocks: [
      header("quotation", [{ labelKey: "number", value: "{{doc.number}}" }, dateField("issueDate", "doc.issueDate"), dateField("validUntil", "doc.validUntil", { path: "doc.validUntil", op: "exists" })]),
      { type: "parties", columns: [partyColumn("customer", customerLines)] },
      { type: "meta", columns: 3, fields: [textField("reference", "doc.reference"), textField("paymentTerms", "doc.paymentTerms")] },
      lineTable([
        { key: "description", labelKey: "description", width: 46 },
        { key: "quantity", labelKey: "quantity", format: "number", width: 10, align: "end" },
        { key: "unitPrice", labelKey: "unitPrice", format: "currency", width: 20, align: "end" },
        { key: "lineTotal", labelKey: "lineTotal", format: "currency", width: 24, align: "end" },
      ]),
      priceTotals(),
      ...notesBlocks, ...approvalBlocks,
    ],
  }),
  tpl("receipt", "receipt", "Receipt", "Payment receipt for a recorded incoming payment against an invoice.", {
    style: { accentColor: "#1f6b46" },
    requiredSources: ["payment", "invoice", "customer", "organization"],
    blocks: [
      header("receipt", [{ labelKey: "number", value: "{{doc.number}}" }, dateField("paymentDate", "doc.paymentDate", { path: "doc.paymentDate", op: "exists" })]),
      { type: "parties", columns: [partyColumn("customer", customerLines)] },
      { type: "meta", columns: 3, fields: [textField("invoiceRef", "doc.originalNumber"), textField("paymentMethod", "doc.paymentMethod"), textField("reference", "doc.reference")] },
      { type: "text", text: "{{doc.summary}}", when: { path: "doc.summary", op: "exists" } },
      { type: "totals", rows: [
        { labelKey: "total", path: "calc.grandTotal" },
        { labelKey: "amountPaid", path: "calc.amountPaid", emphasize: true },
        { labelKey: "amountDue", path: "calc.amountDue" },
      ] },
      { type: "text", titleLabel: "notes", text: "{{doc.notes}}", when: cond.notes },
      ...approvalBlocks,
    ],
  }),
  tpl("statement", "statement", "Customer Statement", "Statement of account listing invoices and payments with a running balance.", {
    style: { accentColor: "#2e3a5c" },
    requiredSources: ["customer", "invoices", "payments", "organization"],
    blocks: [
      header("statement", [{ labelKey: "number", value: "{{doc.number}}" }, dateField("date", "doc.generatedAt")]),
      { type: "parties", columns: [partyColumn("customer", customerLines)] },
      { type: "meta", columns: 3, fields: [dateField("period", "doc.periodFrom"), { labelKey: "period", value: "{{doc.periodTo|date}}" }, { labelKey: "openingBalance", value: "{{calc.openingBalance|currency}}" }] },
      { type: "table", source: "statementRows", repeatHeader: true, columns: [
        { key: "date", labelKey: "date", format: "date", width: 16 },
        { key: "reference", labelKey: "reference", width: 26 },
        { key: "kind", labelKey: "description", width: 14 },
        { key: "charge", labelKey: "charges", format: "currency", width: 15, align: "end" },
        { key: "payment", labelKey: "payments", format: "currency", width: 15, align: "end" },
        { key: "balance", labelKey: "balance", format: "currency", width: 14, align: "end" },
      ] },
      { type: "totals", rows: [
        { labelKey: "charges", path: "calc.totalCharges" },
        { labelKey: "payments", path: "calc.totalPayments", negate: true },
        { labelKey: "closingBalance", path: "calc.closingBalance", emphasize: true },
      ] },
      ...notesBlocks, ...approvalBlocks,
    ],
  }),
  tpl("credit-note", "credit_note", "Credit Note", "Credit note referencing an issued invoice, listing the credited items.", {
    style: { accentColor: "#8a3b2e" },
    requiredSources: ["invoice", "customer", "organization"],
    blocks: [
      header("creditNote", [{ labelKey: "number", value: "{{doc.number}}" }, dateField("issueDate", "doc.issueDate")]),
      { type: "parties", columns: [partyColumn("customer", customerLines)] },
      { type: "meta", columns: 3, fields: [textField("original", "doc.originalNumber"), dateField("date", "doc.originalDate", { path: "doc.originalDate", op: "exists" }), textField("reason", "doc.reason")] },
      lineTable([
        { key: "description", labelKey: "description", width: 44 },
        { key: "quantity", labelKey: "quantity", format: "number", width: 10, align: "end" },
        { key: "unitPrice", labelKey: "unitPrice", format: "currency", width: 20, align: "end" },
        { key: "lineTotal", labelKey: "lineTotal", format: "currency", width: 26, align: "end" },
      ]),
      priceTotals(),
      ...notesBlocks, ...approvalBlocks,
    ],
  }),
  tpl("debit-note", "debit_note", "Debit Note", "Debit note referencing an issued invoice for additional charges.", {
    style: { accentColor: "#6b4a1f" },
    requiredSources: ["invoice", "customer", "organization"],
    blocks: [
      header("debitNote", [{ labelKey: "number", value: "{{doc.number}}" }, dateField("issueDate", "doc.issueDate")]),
      { type: "parties", columns: [partyColumn("customer", customerLines)] },
      { type: "meta", columns: 3, fields: [textField("original", "doc.originalNumber"), dateField("date", "doc.originalDate", { path: "doc.originalDate", op: "exists" }), textField("reason", "doc.reason")] },
      lineTable([
        { key: "description", labelKey: "description", width: 44 },
        { key: "quantity", labelKey: "quantity", format: "number", width: 10, align: "end" },
        { key: "unitPrice", labelKey: "unitPrice", format: "currency", width: 20, align: "end" },
        { key: "lineTotal", labelKey: "lineTotal", format: "currency", width: 26, align: "end" },
      ]),
      priceTotals(),
      ...notesBlocks, ...approvalBlocks,
    ],
  }),
  tpl("delivery-note", "delivery_note", "Delivery Note", "Delivery note listing goods ordered and delivered, with receipt signatures.", {
    style: { accentColor: "#37596b" },
    requiredSources: ["invoice_or_purchase_order", "organization"],
    blocks: [
      header("deliveryNote", [{ labelKey: "number", value: "{{doc.number}}" }, dateField("date", "doc.issueDate")]),
      { type: "parties", columns: [partyColumn("shipTo", customerLines), partyColumn("from", ["{{org.legalName}}", "{{org.addressLines}}"])] },
      { type: "meta", columns: 3, fields: [textField("reference", "doc.reference"), textField("poNumber", "doc.poNumber")] },
      { type: "table", source: "deliveryLines", repeatHeader: true, columns: [
        { key: "sku", labelKey: "sku", width: 16 },
        { key: "description", labelKey: "description", width: 44 },
        { key: "ordered", labelKey: "ordered", format: "number", width: 13, align: "end" },
        { key: "delivered", labelKey: "delivered", format: "number", width: 13, align: "end" },
        { key: "pending", labelKey: "pending", format: "number", width: 14, align: "end" },
      ] },
      { type: "text", titleLabel: "notes", text: "{{doc.notes}}", when: cond.notes },
      { type: "signature", lines: [{ labelKey: "deliveredBy" }, { labelKey: "receivedBy" }] },
    ],
  }),
  tpl("business-report", "business_report", "Business Report", "Periodic business report built from the permission-scoped Business Insights data.", {
    style: { accentColor: "#0a5f6e" },
    requiredSources: ["business_insights", "organization"],
    blocks: [
      header("businessReport", [{ labelKey: "number", value: "{{doc.number}}" }, dateField("date", "doc.generatedAt")]),
      { type: "meta", columns: 2, fields: [dateField("period", "doc.periodFrom"), { labelKey: "period", value: "{{doc.periodTo|date}}" }] },
      { type: "text", titleLabel: "summary", text: "{{doc.summary}}", when: { path: "doc.summary", op: "exists" } },
      { type: "table", source: "kpiRows", titleLabel: "indicator", repeatHeader: true, columns: [
        { key: "label", labelKey: "indicator", width: 50 },
        { key: "value", labelKey: "value", width: 25, align: "end" },
        { key: "change", labelKey: "change", width: 25, align: "end" },
      ] },
      { type: "table", source: "bulletRows", titleLabel: "highlights", columns: [{ key: "text", labelKey: "highlights", width: 100 }] },
      ...approvalBlocks,
    ],
  }),
];

export const SYSTEM_TEMPLATES = Object.fromEntries(templates.map((t) => [t.templateId, t]));
export const DEFAULT_TEMPLATE_BY_TYPE = {
  invoice: "system:standard-invoice", purchase_order: "system:purchase-order", quotation: "system:quotation",
  receipt: "system:receipt", statement: "system:statement", credit_note: "system:credit-note",
  debit_note: "system:debit-note", delivery_note: "system:delivery-note", business_report: "system:business-report",
};

export function getSystemTemplate(templateId) {
  return SYSTEM_TEMPLATES[templateId] || null;
}
export function listSystemTemplates() {
  return templates;
}
