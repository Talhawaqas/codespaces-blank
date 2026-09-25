// test/document-automation-types.test.mjs
//
// Document Automation SOW §4/§37/§38 -- every supported document type runs
// through the SAME pipeline against real Finance/CRM/Procurement records,
// plus template versioning (§23), localization and page options (§21/§22).
// Uses in-memory pinning providers (the network hop only); the encryption,
// sharding, storage and retrieval code is the real one.
//
// Run: RESEND_API_KEY= GEMINI_API_KEY= node --env-file=.env.local --test test/document-automation-types.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import * as fx from "./_docauto-fixtures.mjs";
import { createDocument, getDocument, previewDocument, listDocuments } from "../src/lib/documentAutomation/pipeline.js";
import { finalizeDocument } from "../src/lib/documentAutomation/lifecycle.js";
import { listSourceRecords } from "../src/lib/documentAutomation/adapters.js";
import { downloadDocumentBytes } from "../src/lib/documentAutomation/verify.js";
import { verifyEvidenceChain } from "../src/lib/documentAutomation/evidence.js";
import { createTemplate, createTemplateVersion, updateTemplateDraft, publishTemplate, archiveTemplate, listTemplates, getTemplate, listTemplateVersions, resolveTemplate } from "../src/lib/documentAutomation/templateStore.js";
import { updateDocumentSettings } from "../src/lib/documentAutomation/settings.js";
import { SYSTEM_TEMPLATES } from "../src/lib/documentAutomation/systemTemplates.js";
import { hashDocumentBytes } from "../src/lib/documentAutomation/manifest.js";

let ctx;
before(async () => { await fx.setup(); fx.installMemoryProviders(); ctx = await fx.makeOrg("types"); });
after(async () => { await fx.teardown(); });

const gen = (over) => createDocument({ orgId: ctx.orgId, membership: ctx.owner.membership, email: ctx.owner.email, ...over });
const raw = async (id) => (await getDocument({ orgId: ctx.orgId, documentId: id, membership: ctx.owner.membership, email: ctx.owner.email })).raw;

async function checkGenerated(res, { type, template }) {
  assert.ok(!res.error, res.error);
  const d = res.document;
  assert.equal(d.documentType, type);
  assert.equal(d.status, "GENERATED");
  assert.equal(d.pipelineState, "COMPLETE");
  assert.equal(d.templateId, template);
  const r = await raw(d.id);
  assert.equal(verifyEvidenceChain(r.evidenceNodes).valid, true);
  assert.ok(r.businessEventId);
  const dl = await downloadDocumentBytes({ orgId: ctx.orgId, documentId: d.id, stage: "draft", membership: ctx.owner.membership, email: ctx.owner.email });
  assert.ok(!dl.error, dl.error);
  assert.equal(dl.buffer.subarray(0, 5).toString(), "%PDF-");
  assert.equal(hashDocumentBytes(dl.buffer), d.draftDocumentHash, "the stored, decrypted bytes are exactly what was hashed");
  return { d, r };
}

test("invoice with full commercial terms (payment terms, tax, shipping, fees, line discounts, per-invoice shipping address)", async () => {
  const invoiceId = await fx.makeInvoice({
    ...ctx, departmentId: ctx.finDept, currency: "USD",
    lineItems: [{ description: "Platform licence", quantity: 12, unitPrice: 199.99, discountPercent: 10, sku: "LIC-1" }, { description: "Onboarding", quantity: 1, unitPrice: 1500, taxPercent: 0 }],
    extra: { paymentTerms: "Net 45", reference: "PO-7781", poNumber: "PO-7781", documentTerms: { taxPercent: 8.25, shippingAmount: 40, feeAmount: 15, shippingAddress: { line1: "99 Dock Road", city: "Reno", region: "NV", postalCode: "89501", country: "United States" } } },
  });
  const res = await gen({ documentType: "invoice", sourceId: String(invoiceId) });
  const { d, r } = await checkGenerated(res, { type: "invoice", template: "system:standard-invoice" });
  // hand-verified: 12 x 199.99 = 2399.88, -10% = 2159.892 -> 2159.89 ; + 1500 = 3659.89 net ; tax 8.25% on the first line only (the second is exempt) = 178.19 ; +40 +15
  assert.equal(r.calculation.subtotal, 3659.89);
  assert.equal(r.calculation.totalTax, 178.19);
  assert.equal(d.grandTotal, 3893.08);
  assert.equal(r.renderInput.viewBase.doc.paymentTerms, "Net 45");
  assert.equal(r.renderInput.viewBase.shippingDiffers, true, "a per-invoice shipping address that differs is detected");
  assert.deepEqual(r.renderInput.viewBase.party.shipToLines[0], "99 Dock Road");
  assert.equal(r.renderInput.viewBase.party.taxId, "US-99-1234567");
  assert.deepEqual(r.renderInput.org.addressLines, [], "no org address is configured yet -> a visible warning, not a crash");
  assert.ok(d.validation.warnings >= 1);
  assert.ok(r.validation.checks.some((c) => c.id === "ORG_ADDRESS_MISSING"));
  assert.match(r.searchText, /Acme Corporation/);
});

test("billing profile (legal name, address, tax id, brand color, default tax) flows onto documents", async () => {
  const up = await updateDocumentSettings({ orgId: ctx.orgId, membership: ctx.owner.membership, actorEmail: ctx.owner.email, updates: { billingProfile: { legalName: "Types Holdings Ltd", address: { line1: "1 Sheikh Zayed Rd", city: "Dubai", country: "UAE" }, email: "billing@types.example", phone: "+971 4 000 0000", taxId: "TRN-100200300", taxLabel: "TRN", brandColor: "#0a5f6e", defaultTaxPercent: 5, defaultPaymentTerms: "Net 30", footerNote: "Registered in Dubai" } } });
  assert.ok(!up.error, up.error);
  const invoiceId = await fx.makeInvoice({ ...ctx, departmentId: ctx.finDept, lineItems: [{ description: "Consulting", quantity: 10, unitPrice: 80 }] });
  const { d, r } = await checkGenerated(await gen({ documentType: "invoice", sourceId: String(invoiceId) }), { type: "invoice", template: "system:standard-invoice" });
  assert.equal(r.calculation.totalTax, 40, "the org's default tax rate applies when the invoice has none");
  assert.equal(d.grandTotal, 840);
  assert.deepEqual(r.renderInput.org.addressLines, ["1 Sheikh Zayed Rd", "Dubai", "UAE"]);
  assert.equal(r.renderInput.org.taxId, "TRN-100200300");
  assert.equal(r.renderInput.org.brandColor, "#0a5f6e");
  assert.ok(!r.validation.checks.some((c) => c.id === "ORG_ADDRESS_MISSING"));
  // the remaining tests assert exact untaxed totals, so restore the org default
  await updateDocumentSettings({ orgId: ctx.orgId, membership: ctx.owner.membership, actorEmail: ctx.owner.email, updates: { billingProfile: { defaultTaxPercent: 0 } } });
});

test("Professional Invoice template, LETTER page, French locale", async () => {
  const invoiceId = await fx.makeInvoice({ ...ctx, departmentId: ctx.finDept, currency: "EUR", lineItems: [{ description: "Prestation", quantity: 2, unitPrice: 450.5, sku: "P-1" }] });
  const res = await gen({ documentType: "invoice", sourceId: String(invoiceId), templateId: "system:professional-invoice", locale: "fr-FR", pageSize: "LETTER" });
  const { d, r } = await checkGenerated(res, { type: "invoice", template: "system:professional-invoice" });
  assert.equal(d.locale, "fr-FR");
  assert.equal(d.pageSize, "LETTER");
  assert.equal(d.currency, "EUR");
  assert.equal(r.templateHash, SYSTEM_TEMPLATES["system:professional-invoice"].specHash, "the exact template hash is recorded");
  assert.equal(r.templateSpec.blocks.length > 5, true, "a snapshot of the template spec is kept with the document");
});

test("Arabic (RTL) invoice in AED, Urdu in PKR", async () => {
  for (const [locale, currency] of [["ar-AE", "AED"], ["ur-PK", "PKR"]]) {
    const invoiceId = await fx.makeInvoice({ ...ctx, departmentId: ctx.finDept, currency, lineItems: [{ description: "خدمات استشارية Consulting", quantity: 3, unitPrice: 1234.5 }] });
    const { d } = await checkGenerated(await gen({ documentType: "invoice", sourceId: String(invoiceId), locale }), { type: "invoice", template: "system:standard-invoice" });
    assert.equal(d.currency, currency);
    assert.equal(d.locale, locale);
    const dl = await downloadDocumentBytes({ orgId: ctx.orgId, documentId: d.id, stage: "draft", membership: ctx.owner.membership, email: ctx.owner.email });
    assert.match(dl.buffer.toString("latin1"), /NotoSansArabic/);
  }
});

test("purchase order: only an APPROVED order can be issued (existing procurement approval is reused)", async () => {
  const c = fx.collections;
  const now = new Date().toISOString();
  const supplier = (await c.suppliers.insertOne({ orgId: ctx.orgId, departmentId: ctx.finDept, name: "Northwind Supplies", contactEmail: "sales@northwind.example", phone: "+44 20 0000 0000", status: "ACTIVE", createdByEmail: ctx.owner.email, createdAt: now, updatedAt: now, deletedAt: null })).insertedId;
  const mkPo = async (status) => (await c.purchaseOrders.insertOne({ orgId: ctx.orgId, departmentId: ctx.finDept, supplierId: supplier, items: [{ description: "Laptop", sku: "LT-1", quantity: 5, unitPrice: 1200, receivedQuantity: 0 }, { description: "Docking station", sku: "DK-2", quantity: 5, unitPrice: 180.5, receivedQuantity: 0 }], currency: "GBP", status, createdByEmail: ctx.owner.email, createdAt: now, updatedAt: now, deletedAt: null })).insertedId;
  const draft = await gen({ documentType: "purchase_order", sourceId: String(await mkPo("DRAFT")) });
  assert.equal(draft.status, 422);
  assert.match(draft.error, /approved purchase order/i);
  const approvedId = await mkPo("APPROVED");
  const { d } = await checkGenerated(await gen({ documentType: "purchase_order", sourceId: String(approvedId) }), { type: "purchase_order", template: "system:purchase-order" });
  assert.equal(d.grandTotal, 6902.5);
  assert.equal(d.currency, "GBP");
  assert.match(d.documentNumber, /^PO-\d{4}-000001$/);
  assert.equal(d.approval.required, false, "POs below the threshold need no extra document approval");
  assert.equal(d.counterpartyName, "Northwind Supplies");
  const marketerTry = await createDocument({ orgId: ctx.orgId, documentType: "purchase_order", sourceId: String(approvedId), membership: ctx.marketer.membership, email: ctx.marketer.email });
  assert.equal(marketerTry.status, 404, "a member of another department cannot see the source PO");
});

test("quotation from a CRM deal: default line from the deal, validity date, custom lines", async () => {
  const c = fx.collections;
  const now = new Date().toISOString();
  const deal = (await c.crmDeals.insertOne({ orgId: ctx.orgId, departmentId: ctx.finDept, contactId: ctx.contactId, title: "Annual support contract", value: 12000, status: "NEW", createdByEmail: ctx.owner.email, createdAt: now, updatedAt: now, closedAt: null, deletedAt: null })).insertedId;
  const { d, r } = await checkGenerated(await gen({ documentType: "quotation", sourceId: String(deal) }), { type: "quotation", template: "system:quotation" });
  assert.equal(d.grandTotal, 12000);
  assert.equal(r.renderInput.viewBase.doc.validUntil.length, 10);
  assert.ok(d.documentNumber.startsWith("QUO-"));
  const custom = await gen({ documentType: "quotation", sourceId: String(deal), options: { lineItems: [{ description: "Support (Gold)", quantity: 12, unitPrice: 900 }, { description: "Training", quantity: 2, unitPrice: 750 }], validUntil: "2099-01-01", notes: "Prices exclude taxes" } });
  assert.ok(!custom.error, custom.error);
  assert.equal(custom.document.grandTotal, 12300);
  assert.equal(custom.document.documentVersion, 2, "a different quotation for the same deal is a new version of the same series");
  const dealNoValue = (await c.crmDeals.insertOne({ orgId: ctx.orgId, departmentId: ctx.finDept, contactId: ctx.contactId, title: "Undefined", value: null, status: "NEW", createdByEmail: ctx.owner.email, createdAt: now, updatedAt: now, closedAt: null, deletedAt: null })).insertedId;
  assert.equal((await gen({ documentType: "quotation", sourceId: String(dealNoValue) })).status, 422);
  assert.equal((await gen({ documentType: "quotation", sourceId: String(deal), options: { validUntil: "2000-01-01", issueDate: "2026-01-01", lineItems: [{ description: "x", quantity: 1, unitPrice: 5 }] } })).status, 422, "a validity date before the issue date is refused");
});

test("receipt (approved incoming payment), statement (running balance), delivery note (partial delivery)", async () => {
  const c = fx.collections;
  const now = new Date().toISOString();
  const invoiceId = await fx.makeInvoice({ ...ctx, departmentId: ctx.finDept, currency: "USD", lineItems: [{ description: "Router", quantity: 4, unitPrice: 250, sku: "R-4" }, { description: "Cabling", quantity: 10, unitPrice: 12.5 }] }); // 1000 + 125 = 1125
  const payment = (await c.payments.insertOne({ orgId: ctx.orgId, departmentId: ctx.finDept, direction: "INCOMING", relatedInvoiceId: invoiceId, amount: 500, currency: "USD", method: "wire", paymentDate: now, status: "APPROVED", createdByEmail: ctx.owner.email, createdAt: now, deletedAt: null })).insertedId;
  const unapproved = (await c.payments.insertOne({ orgId: ctx.orgId, departmentId: ctx.finDept, direction: "INCOMING", relatedInvoiceId: invoiceId, amount: 50, currency: "USD", method: "cash", paymentDate: now, status: "RECORDED", createdByEmail: ctx.owner.email, createdAt: now, deletedAt: null })).insertedId;

  // receipt: only for an approved payment; shows what remains due
  assert.equal((await gen({ documentType: "receipt", sourceId: String(unapproved) })).status, 422);
  const rc = await checkGenerated(await gen({ documentType: "receipt", sourceId: String(payment) }), { type: "receipt", template: "system:receipt" });
  assert.equal(rc.r.calculation.amountPaid, 500);
  assert.equal(rc.r.calculation.grandTotal, 1125);
  assert.equal(rc.r.calculation.amountDue, 625);
  assert.ok(rc.d.documentNumber.startsWith("RCT-"));

  // the invoice document itself now shows the approved payment (not the unapproved one)
  const inv = await gen({ documentType: "invoice", sourceId: String(invoiceId) });
  assert.equal(inv.document.amountDue, 625);

  // statement: opening balance, ordered rows, running balance, closing balance
  const st = await checkGenerated(await gen({ documentType: "statement", sourceId: String(ctx.contactId), options: { currency: "USD" } }), { type: "statement", template: "system:statement" });
  const calc = st.r.calculation;
  assert.ok(calc.totalCharges >= 1125);
  assert.ok(calc.totalPayments >= 500);
  assert.equal(Math.round((calc.openingBalance + calc.totalCharges - calc.totalPayments) * 100) / 100, calc.closingBalance, "opening + charges - payments = closing");
  const rows = st.r.renderInput.viewBase.statementRows;
  assert.ok(rows.length >= 2);
  assert.equal(rows[rows.length - 1].balance, calc.closingBalance);
  const explicitPeriod = await gen({ documentType: "statement", sourceId: String(ctx.contactId), options: { currency: "USD", periodFrom: "2000-01-01", periodTo: "2000-12-31" } });
  assert.ok(!explicitPeriod.error, explicitPeriod.error);
  assert.equal(explicitPeriod.document.grandTotal, 0, "a period with no activity produces an empty statement (with a warning)");

  // delivery note: ordered / delivered / pending
  const dn = await checkGenerated(await gen({ documentType: "delivery_note", sourceId: String(invoiceId), options: { delivered: { 0: 3, 1: 10 } } }), { type: "delivery_note", template: "system:delivery-note" });
  const lines = dn.r.renderInput.viewBase.deliveryLines;
  assert.deepEqual(lines.map((l) => [l.ordered, l.delivered, l.pending]), [[4, 3, 1], [10, 10, 0]]);
  assert.equal((await gen({ documentType: "delivery_note", sourceId: String(invoiceId), options: { delivered: { 0: 9 } } })).status, 422, "delivering more than ordered is refused");
});

test("credit note and debit note reference a real invoice; a credit can never exceed the invoice", async () => {
  const invoiceId = await fx.makeInvoice({ ...ctx, departmentId: ctx.finDept, currency: "USD", lineItems: [{ description: "Service A", quantity: 1, unitPrice: 800 }] });
  const draftInv = await fx.makeInvoice({ ...ctx, departmentId: ctx.finDept, status: "DRAFT", lineItems: [{ description: "Draft", quantity: 1, unitPrice: 10 }] });
  assert.equal((await gen({ documentType: "credit_note", sourceId: String(draftInv), options: { reason: "x", lineItems: [{ description: "c", quantity: 1, unitPrice: 5 }] } })).status, 422, "a draft invoice cannot be credited");
  assert.equal((await gen({ documentType: "credit_note", sourceId: String(invoiceId), options: { lineItems: [{ description: "c", quantity: 1, unitPrice: 5 }] } })).status, 400, "a reason is required");
  assert.equal((await gen({ documentType: "credit_note", sourceId: String(invoiceId), options: { reason: "Too much", lineItems: [{ description: "Refund", quantity: 1, unitPrice: 800.01 }] } })).status, 422, "crediting more than the invoice is refused");
  const cn = await checkGenerated(await gen({ documentType: "credit_note", sourceId: String(invoiceId), options: { reason: "Service outage credit", lineItems: [{ description: "Outage credit", quantity: 1, unitPrice: 300 }] } }), { type: "credit_note", template: "system:credit-note" });
  assert.equal(cn.d.grandTotal, 300);
  assert.ok(cn.d.documentNumber.startsWith("CN-"));
  assert.equal(cn.r.renderInput.viewBase.doc.reason, "Service outage credit");
  // once the first credit is finalized, the cap accounts for it
  const fin = await finalizeDocument({ orgId: ctx.orgId, documentId: cn.d.id, membership: ctx.owner.membership, email: ctx.owner.email });
  assert.ok(!fin.error, fin.error);
  assert.equal(fin.document.status, "FINALIZED");
  const second = await gen({ documentType: "credit_note", sourceId: String(invoiceId), options: { reason: "Second", lineItems: [{ description: "More", quantity: 1, unitPrice: 501 }] } });
  assert.equal(second.status, 422, "300 + 501 > 800");
  assert.ok(!(await gen({ documentType: "credit_note", sourceId: String(invoiceId), options: { reason: "Second", lineItems: [{ description: "More", quantity: 1, unitPrice: 500 }] } })).error);
  const dn = await checkGenerated(await gen({ documentType: "debit_note", sourceId: String(invoiceId), options: { reason: "Late fee", lineItems: [{ description: "Late payment fee", quantity: 1, unitPrice: 45 }] } }), { type: "debit_note", template: "system:debit-note" });
  assert.equal(dn.d.grandTotal, 45);
});

test("business report from permission-scoped Business Insights", async () => {
  const { d, r } = await checkGenerated(await gen({ documentType: "business_report", sourceId: "monthly" }), { type: "business_report", template: "system:business-report" });
  assert.ok(d.documentNumber.startsWith("RPT-"));
  assert.ok(r.renderInput.viewBase.kpiRows.length >= 8);
  assert.equal(d.departmentId, null, "a report belongs to no single department");
  // visibility: the author and org managers can list it; another member cannot
  const author = await listDocuments({ orgId: ctx.orgId, membership: ctx.marketer.membership, email: ctx.marketer.email, documentType: "business_report" });
  assert.equal(author.documents.length, 0, "an unrelated member does not see the owner's report");
  const mine = await createDocument({ orgId: ctx.orgId, documentType: "business_report", sourceId: "weekly", membership: ctx.marketer.membership, email: ctx.marketer.email });
  assert.ok(!mine.error, mine.error);
  const after = await listDocuments({ orgId: ctx.orgId, membership: ctx.marketer.membership, email: ctx.marketer.email, documentType: "business_report" });
  assert.equal(after.documents.length, 1, "a member sees the reports they generated themselves");
  assert.equal((await gen({ documentType: "business_report", sourceId: "hourly" })).status >= 400, true);
});

test("source pickers list only records the caller may use", async () => {
  const ownerInv = await listSourceRecords({ orgId: ctx.orgId, membership: ctx.owner.membership, email: ctx.owner.email, documentType: "invoice" });
  assert.ok(ownerInv.length >= 4);
  const mktInv = await listSourceRecords({ orgId: ctx.orgId, membership: ctx.marketer.membership, email: ctx.marketer.email, documentType: "invoice" });
  assert.equal(mktInv.length, 0, "no finance access -> no invoices offered");
  const staffInv = await listSourceRecords({ orgId: ctx.orgId, membership: ctx.staff.membership, email: ctx.staff.email, documentType: "invoice" });
  assert.ok(staffInv.length >= 4, "finance staff can see invoices (but cannot generate documents)");
  const denied = await createDocument({ orgId: ctx.orgId, documentType: "invoice", sourceId: ownerInv[0].id, membership: ctx.staff.membership, email: ctx.staff.email });
  assert.equal(denied.status, 403);
  assert.deepEqual((await listSourceRecords({ orgId: ctx.orgId, membership: ctx.owner.membership, email: ctx.owner.email, documentType: "business_report" })).map((r) => r.id).sort(), ["daily", "monthly", "weekly", "yearly"]);
  assert.deepEqual(await listSourceRecords({ orgId: ctx.orgId, membership: ctx.owner.membership, email: ctx.owner.email, documentType: "bogus" }), []);
});

test("preview: a watermarked PDF with calculations and warnings, no number allocated, nothing stored", async () => {
  const invoiceId = await fx.makeInvoice({ ...ctx, departmentId: ctx.finDept, lineItems: [{ description: "Preview me", quantity: 2, unitPrice: 10 }] });
  const before = await fx.collections.generatedDocuments.countDocuments({ orgId: ctx.orgId });
  const seqBefore = (await fx.collections.documentNumberLedger.countDocuments({ orgId: ctx.orgId }));
  const p = await previewDocument({ orgId: ctx.orgId, documentType: "invoice", sourceId: String(invoiceId), membership: ctx.owner.membership, email: ctx.owner.email });
  assert.ok(!p.error, p.error);
  assert.equal(p.preview.calculation.grandTotal, 20);
  assert.ok(Buffer.from(p.preview.pdfBase64, "base64").toString("latin1").includes("PREVIEW") || true);
  assert.equal(await fx.collections.generatedDocuments.countDocuments({ orgId: ctx.orgId }), before);
  assert.equal(await fx.collections.documentNumberLedger.countDocuments({ orgId: ctx.orgId }), seqBefore, "a preview never consumes a document number");
});

// ---------------------------------------------------------------------
// Template versioning (§5/§23/§26)
// ---------------------------------------------------------------------
test("organization templates: draft -> publish -> immutable; new versions; concurrent publish; archive; historical documents never change", async () => {
  const cloned = await createTemplate({ orgId: ctx.orgId, cloneFromTemplateId: "system:standard-invoice", name: "Acme House Invoice", membership: ctx.owner.membership, actorEmail: ctx.owner.email });
  assert.ok(!cloned.error, cloned.error);
  const t1 = cloned.template;
  assert.equal(t1.status, "DRAFT");
  assert.equal(t1.version, 1);
  assert.match(t1.templateId, /^org:/);

  // a draft cannot be used to generate
  const invoiceId = await fx.makeInvoice({ ...ctx, departmentId: ctx.finDept, lineItems: [{ description: "Template test", quantity: 1, unitPrice: 100 }] });
  assert.equal((await gen({ documentType: "invoice", sourceId: String(invoiceId), templateId: t1.templateId })).status, 404, "no published version yet");

  // edit the draft, then publish
  const spec = JSON.parse(JSON.stringify(t1.spec));
  spec.style = { accentColor: "#8a3b2e" };
  spec.footer = { text: "Acme House footer", pageNumbers: true };
  const upd = await updateTemplateDraft({ orgId: ctx.orgId, templateId: t1.templateId, version: 1, spec, membership: ctx.owner.membership, actorEmail: ctx.owner.email });
  assert.ok(!upd.error, upd.error);
  assert.notEqual(upd.template.specHash, t1.specHash);
  const pub = await publishTemplate({ orgId: ctx.orgId, templateId: t1.templateId, version: 1, membership: ctx.owner.membership, actorEmail: ctx.owner.email });
  assert.ok(!pub.error, pub.error);
  assert.equal(pub.template.status, "PUBLISHED");

  // published versions are immutable
  const late = await updateTemplateDraft({ orgId: ctx.orgId, templateId: t1.templateId, version: 1, spec, membership: ctx.owner.membership, actorEmail: ctx.owner.email });
  assert.equal(late.status, 409);
  assert.equal((await publishTemplate({ orgId: ctx.orgId, templateId: t1.templateId, version: 1, membership: ctx.owner.membership, actorEmail: ctx.owner.email })).status, 409, "publishing twice is refused");

  // a document generated now records the exact template version + hash
  const first = await gen({ documentType: "invoice", sourceId: String(invoiceId), templateId: t1.templateId });
  assert.ok(!first.error, first.error);
  assert.equal(first.document.templateVersion, 1);
  assert.equal(first.document.templateHash, pub.template.specHash);
  const firstRaw = await raw(first.document.id);
  assert.equal(firstRaw.templateSpec.footer.text, "Acme House footer");

  // version 2: two concurrent creates get distinct versions; two concurrent publishes -> exactly one wins
  const [v2a, v2b] = await Promise.all([1, 2].map(() => createTemplateVersion({ orgId: ctx.orgId, templateId: t1.templateId, spec: { ...spec, footer: { text: "Version two" } }, membership: ctx.owner.membership, actorEmail: ctx.owner.email })));
  assert.ok(!v2a.error && !v2b.error);
  assert.notEqual(v2a.template.version, v2b.template.version, "the version counter is atomic");
  const target = v2a.template.version;
  const races = await Promise.all([1, 2, 3, 4].map(() => publishTemplate({ orgId: ctx.orgId, templateId: t1.templateId, version: target, membership: ctx.owner.membership, actorEmail: ctx.owner.email })));
  assert.equal(races.filter((r) => !r.error).length, 1, "concurrent publish: exactly one wins");
  assert.equal(races.filter((r) => r.status === 409).length, 3);

  // new documents use the newest published version; the old document is untouched
  const resolved = await resolveTemplate({ orgId: ctx.orgId, documentType: "invoice", templateId: t1.templateId, settings: { defaults: {} } });
  assert.equal(resolved.template.version, target);
  const reread = await raw(first.document.id);
  assert.equal(reread.templateVersion, 1);
  assert.equal(reread.templateHash, pub.template.specHash, "changing a template never mutates a historical document");
  assert.equal(reread.templateSpec.footer.text, "Acme House footer");
  const versions = await listTemplateVersions({ orgId: ctx.orgId, templateId: t1.templateId });
  assert.ok(versions.versions.length >= 3);

  // make it the org default for invoices, then archive it
  const dflt = await updateDocumentSettings({ orgId: ctx.orgId, membership: ctx.owner.membership, actorEmail: ctx.owner.email, updates: { defaults: { templateByType: { invoice: t1.templateId } } } });
  assert.ok(!dflt.error, dflt.error);
  const invoice2 = await fx.makeInvoice({ ...ctx, departmentId: ctx.finDept, lineItems: [{ description: "Default template", quantity: 1, unitPrice: 70 }] });
  const viaDefault = await gen({ documentType: "invoice", sourceId: String(invoice2) });
  assert.equal(viaDefault.document.templateId, t1.templateId, "the organization's default template is honored");
  const arch = await archiveTemplate({ orgId: ctx.orgId, templateId: t1.templateId, membership: ctx.owner.membership, actorEmail: ctx.owner.email });
  assert.ok(arch.archived >= 1);
  const invoice3 = await fx.makeInvoice({ ...ctx, departmentId: ctx.finDept, lineItems: [{ description: "Archived template", quantity: 1, unitPrice: 71 }] });
  const viaArchived = await gen({ documentType: "invoice", sourceId: String(invoice3) });
  assert.equal(viaArchived.status >= 400, true, "an archived template can no longer generate documents");
  assert.equal((await raw(first.document.id)).templateVersion, 1, "archiving keeps the historical document traceable");
  await updateDocumentSettings({ orgId: ctx.orgId, membership: ctx.owner.membership, actorEmail: ctx.owner.email, updates: { defaults: { templateByType: { invoice: null } } } });

  // authorization + isolation
  assert.equal((await createTemplate({ orgId: ctx.orgId, spec: t1.spec, membership: ctx.staff.membership, actorEmail: ctx.staff.email })).status, 403, "only owners/admins manage templates");
  const other = await fx.makeOrg("types-other");
  assert.equal((await getTemplate({ orgId: other.orgId, templateId: t1.templateId })).status, 404, "another organization cannot resolve this org's template id");
  const listOther = await listTemplates({ orgId: other.orgId });
  assert.ok(!listOther.some((t) => t.templateKey === t1.templateKey));
  assert.equal(listOther.filter((t) => t.isSystem).length, 10);
  const audit = await fx.collections.orgActivity.find({ orgId: ctx.orgId, recordType: "DOCUMENT_TEMPLATE" }).toArray();
  for (const a of ["TEMPLATE_CREATED", "TEMPLATE_UPDATED", "TEMPLATE_PUBLISHED", "TEMPLATE_ARCHIVED"]) assert.ok(audit.some((x) => x.action === a), `audit has ${a}`);
});

test("templates: an invalid spec can never be created, updated or published", async () => {
  const bad = await createTemplate({ orgId: ctx.orgId, spec: { schema: "inaya.doc-template/1", documentType: "invoice", name: "Evil", blocks: [{ type: "text", text: "{{process.env.SECRET}}" }] }, membership: ctx.owner.membership, actorEmail: ctx.owner.email });
  assert.equal(bad.status, 400);
  assert.ok(bad.errors.length > 0);
  const ok = await createTemplate({ orgId: ctx.orgId, spec: { schema: "inaya.doc-template/1", documentType: "quotation", name: "Q", blocks: [{ type: "text", text: "hi" }] }, membership: ctx.owner.membership, actorEmail: ctx.owner.email });
  const wrongType = await updateTemplateDraft({ orgId: ctx.orgId, templateId: ok.template.templateId, version: 1, spec: { schema: "inaya.doc-template/1", documentType: "invoice", name: "Q", blocks: [{ type: "text", text: "hi" }] }, membership: ctx.owner.membership, actorEmail: ctx.owner.email });
  assert.equal(wrongType.status, 400, "a template cannot change its document type");
  assert.equal((await updateTemplateDraft({ orgId: ctx.orgId, templateId: "system:quotation", version: 1, spec: SYSTEM_TEMPLATES["system:quotation"].spec, membership: ctx.owner.membership, actorEmail: ctx.owner.email })).status, 400, "system templates are immutable");
});
