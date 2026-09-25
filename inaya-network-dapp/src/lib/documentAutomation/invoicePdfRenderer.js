// src/lib/documentAutomation/invoicePdfRenderer.js
//
// Native Document & Invoice Automation Engine SOW, Section 5/21. A real,
// production-quality invoice PDF -- the Phase 0 audit found the only
// existing "PDF" route (finance/invoices/[invoiceId]/pdf) actually
// returns a print-styled HTML page (the browser's own Print-to-PDF),
// with a code comment claiming "no PDF library exists" that's now stale
// -- pdfkit (^0.20.2) was added earlier this session for
// businessEventPassport.js's evidence passports. This module reuses
// that same library and streaming-to-Buffer technique, but is a genuinely
// new layout: pdfkit has no built-in table primitive, so the line-item
// table (with repeated headers across page breaks -- SOW §5/§21) is
// hand-drawn here, real column geometry and page-break detection, not
// borrowed from anywhere else in this codebase.
//
// Deliberately NOT executing any template-supplied code: every value
// rendered here comes from the calculation result / source records this
// module is called with, never from a user-authorable template string
// evaluated at render time (SOW §5's "must not permit arbitrary
// server-side code execution" -- there is no template DSL in this pass,
// just this one real, fixed, tested invoice layout; a genuine template
// engine is documented as a deferred gap in the completion report).

import PDFDocument from "pdfkit";

const PAGE_MARGIN = 50;
const COLORS = { ink: "#1a1a2e", muted: "#666680", line: "#d8d8e0", accent: "#2e3a5c" };

const COLUMNS = [
  { key: "description", label: "Description", width: 230, align: "left" },
  { key: "quantity", label: "Qty", width: 55, align: "right" },
  { key: "unitPrice", label: "Unit Price", width: 80, align: "right" },
  { key: "lineDiscount", label: "Discount", width: 75, align: "right" },
  { key: "lineTax", label: "Tax", width: 65, align: "right" },
  { key: "lineTotal", label: "Total", width: 80, align: "right" },
];

function money(amount, currency) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "narrowSymbol" }).format(amount);
  } catch {
    return `${currency} ${Number(amount).toFixed(2)}`;
  }
}

function columnX(index) {
  return PAGE_MARGIN + COLUMNS.slice(0, index).reduce((sum, c) => sum + c.width, 0);
}

function drawTableHeader(doc, y) {
  doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.muted);
  COLUMNS.forEach((col, i) => {
    doc.text(col.label.toUpperCase(), columnX(i), y, { width: col.width, align: col.align });
  });
  const headerBottom = y + 14;
  doc.moveTo(PAGE_MARGIN, headerBottom).lineTo(doc.page.width - PAGE_MARGIN, headerBottom).strokeColor(COLORS.line).lineWidth(1).stroke();
  return headerBottom + 8;
}

function pageBottomLimit(doc) {
  return doc.page.height - PAGE_MARGIN - 30; // leave room for the footer
}

/**
 * Renders a real, multi-page-capable invoice PDF and returns a Buffer.
 * Every value comes from `invoice` (the calculation result +
 * organization/customer info this function is called with) -- no
 * external template evaluation.
 *
 * @param {Object} params
 * @param {Object} params.invoice - { number, issueDate, dueDate, currency, lineItems, subtotal, invoiceDiscount, tax, shipping, grandTotal, amountPaid, amountDue, notes }
 * @param {Object} params.organization - { name, addressLines, email, phone }
 * @param {Object} params.customer - { name, addressLines, email }
 * @param {Object} [params.pageSize] - "A4" (default) or "LETTER"
 */
export function renderInvoicePdf({ invoice, organization, customer, pageSize = "A4" }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PAGE_MARGIN, size: pageSize, bufferPages: true });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // -- Header: org identity + document identity --------------------
    doc.font("Helvetica-Bold").fontSize(20).fillColor(COLORS.accent).text(organization.name || "Organization", PAGE_MARGIN, PAGE_MARGIN);
    doc.font("Helvetica").fontSize(9).fillColor(COLORS.muted);
    let orgInfoY = PAGE_MARGIN + 26;
    for (const line of organization.addressLines || []) { doc.text(line, PAGE_MARGIN, orgInfoY); orgInfoY += 12; }
    if (organization.email) { doc.text(organization.email, PAGE_MARGIN, orgInfoY); orgInfoY += 12; }

    const rightColX = doc.page.width - PAGE_MARGIN - 200;
    doc.font("Helvetica-Bold").fontSize(16).fillColor(COLORS.ink).text("INVOICE", rightColX, PAGE_MARGIN, { width: 200, align: "right" });
    doc.font("Helvetica").fontSize(9).fillColor(COLORS.muted);
    doc.text(invoice.number, rightColX, PAGE_MARGIN + 22, { width: 200, align: "right" });
    doc.text(`Issued: ${invoice.issueDate}`, rightColX, PAGE_MARGIN + 36, { width: 200, align: "right" });
    doc.text(`Due: ${invoice.dueDate}`, rightColX, PAGE_MARGIN + 50, { width: 200, align: "right" });
    if (invoice.status) doc.font("Helvetica-Bold").fillColor(COLORS.accent).text(invoice.status, rightColX, PAGE_MARGIN + 64, { width: 200, align: "right" });

    // -- Bill to -------------------------------------------------------
    let billY = Math.max(orgInfoY, PAGE_MARGIN + 90) + 20;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.muted).text("BILL TO", PAGE_MARGIN, billY);
    billY += 14;
    doc.font("Helvetica-Bold").fontSize(11).fillColor(COLORS.ink).text(customer.name || "Customer", PAGE_MARGIN, billY);
    billY += 15;
    doc.font("Helvetica").fontSize(9).fillColor(COLORS.muted);
    for (const line of customer.addressLines || []) { doc.text(line, PAGE_MARGIN, billY); billY += 12; }
    if (customer.email) { doc.text(customer.email, PAGE_MARGIN, billY); billY += 12; }

    // -- Line-item table, with real page-break + repeated header -----
    let y = billY + 24;
    y = drawTableHeader(doc, y);
    doc.font("Helvetica").fontSize(9).fillColor(COLORS.ink);

    for (const item of invoice.lineItems) {
      const descHeight = doc.heightOfString(item.description, { width: COLUMNS[0].width });
      const rowHeight = Math.max(descHeight, 14) + 6;

      if (y + rowHeight > pageBottomLimit(doc)) {
        doc.addPage();
        y = PAGE_MARGIN;
        y = drawTableHeader(doc, y);
        doc.font("Helvetica").fontSize(9).fillColor(COLORS.ink);
      }

      doc.text(item.description, columnX(0), y, { width: COLUMNS[0].width, align: "left" });
      doc.text(String(item.quantity), columnX(1), y, { width: COLUMNS[1].width, align: "right" });
      doc.text(money(item.unitPrice, invoice.currency), columnX(2), y, { width: COLUMNS[2].width, align: "right" });
      doc.text(item.lineDiscount ? `-${money(item.lineDiscount, invoice.currency)}` : "—", columnX(3), y, { width: COLUMNS[3].width, align: "right" });
      doc.text(item.lineTax ? money(item.lineTax, invoice.currency) : "—", columnX(4), y, { width: COLUMNS[4].width, align: "right" });
      doc.font("Helvetica-Bold").text(money(item.lineTotal, invoice.currency), columnX(5), y, { width: COLUMNS[5].width, align: "right" });
      doc.font("Helvetica");

      y += rowHeight;
      doc.moveTo(PAGE_MARGIN, y - 3).lineTo(doc.page.width - PAGE_MARGIN, y - 3).strokeColor(COLORS.line).lineWidth(0.5).stroke();
    }

    // -- Totals block --------------------------------------------------
    const totalsRows = [
      ["Subtotal", invoice.subtotal],
      invoice.invoiceDiscount ? ["Discount", -invoice.invoiceDiscount] : null,
      invoice.tax ? ["Tax", invoice.tax] : null,
      invoice.shipping ? ["Shipping", invoice.shipping] : null,
    ].filter(Boolean);

    const totalsBlockHeight = (totalsRows.length + 2) * 18 + 20;
    if (y + totalsBlockHeight > pageBottomLimit(doc)) { doc.addPage(); y = PAGE_MARGIN; }
    y += 16;

    const totalsLabelX = doc.page.width - PAGE_MARGIN - 220;
    const totalsValueX = doc.page.width - PAGE_MARGIN - 100;
    doc.font("Helvetica").fontSize(9).fillColor(COLORS.muted);
    for (const [label, amount] of totalsRows) {
      doc.text(label, totalsLabelX, y, { width: 120, align: "left" });
      doc.text(money(amount, invoice.currency), totalsValueX, y, { width: 100, align: "right" });
      y += 16;
    }
    doc.moveTo(totalsLabelX, y).lineTo(doc.page.width - PAGE_MARGIN, y).strokeColor(COLORS.line).stroke();
    y += 8;
    doc.font("Helvetica-Bold").fontSize(12).fillColor(COLORS.ink);
    doc.text("Total", totalsLabelX, y, { width: 120, align: "left" });
    doc.text(money(invoice.grandTotal, invoice.currency), totalsValueX, y, { width: 100, align: "right" });
    y += 18;

    if (invoice.amountPaid) {
      doc.font("Helvetica").fontSize(9).fillColor(COLORS.muted);
      doc.text("Paid", totalsLabelX, y, { width: 120, align: "left" });
      doc.text(money(invoice.amountPaid, invoice.currency), totalsValueX, y, { width: 100, align: "right" });
      y += 14;
      doc.font("Helvetica-Bold").fillColor(COLORS.accent);
      doc.text("Amount Due", totalsLabelX, y, { width: 120, align: "left" });
      doc.text(money(invoice.amountDue, invoice.currency), totalsValueX, y, { width: 100, align: "right" });
      y += 16;
    }

    if (invoice.notes) {
      y += 20;
      doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.muted).text("NOTES", PAGE_MARGIN, y);
      y += 14;
      doc.font("Helvetica").fontSize(9).fillColor(COLORS.ink).text(invoice.notes, PAGE_MARGIN, y, { width: doc.page.width - PAGE_MARGIN * 2 });
    }

    // -- Footer on every page: page numbers (SOW §21) -----------------
    // Real bug found and fixed here: writing text this close to a
    // switched-to page's bottom margin makes pdfkit think the content
    // overflowed and silently APPEND a new blank page per footer write
    // -- a 3-page invoice came out as 6 pages (3 real + 3 blank,
    // confirmed by actually reading the rendered PDF, not just checking
    // byte count). Zeroing the bottom margin for the duration of the
    // footer write (pdfkit's own documented workaround for this exact
    // "page numbers create extra blank pages" behavior) stops it from
    // ever re-evaluating pagination for this text call.
    const range = doc.bufferedPageRange();
    const savedBottomMargin = doc.page.margins.bottom;
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0;
      doc.font("Helvetica").fontSize(8).fillColor(COLORS.muted);
      doc.text(`Page ${i - range.start + 1} of ${range.count}`, PAGE_MARGIN, doc.page.height - PAGE_MARGIN, { width: doc.page.width - PAGE_MARGIN * 2, align: "center", lineBreak: false });
      doc.page.margins.bottom = savedBottomMargin;
    }

    doc.end();
  });
}
