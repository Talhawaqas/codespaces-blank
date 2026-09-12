// app/api/orgs/finance/invoices/[invoiceId]/pdf/route.js
//
// GET /api/orgs/finance/invoices/:invoiceId/pdf?orgId= — Business
// Workspace Remaining Features SOW, "PDF Invoice Generation + Printing."
//
// Returns a full, print-styled HTML document (not JSON) rather than a
// generated binary PDF -- no PDF library exists anywhere in this app
// (confirmed before writing this), and the browser's own Print dialog
// already gives both "print to a real printer" and "save as PDF" from the
// exact same page, with zero new dependency. Values are read verbatim
// from the stored invoice (subtotal/total/currency) -- never recalculated
// here, matching the SOW's own "PDF values exactly match the invoice
// record" acceptance criterion.

import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, canAccessFinance, toObjectId } from "../../../../../../../lib/orgs.js";
import { convert, isSupportedCurrency } from "../../../../../../../lib/currency.js";

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtMoney(amount, currency) {
  return `${currency} ${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export async function GET(req, { params }) {
  try {
    const { invoiceId } = params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const displayCurrency = searchParams.get("displayCurrency");
    if (!orgId) return new Response("orgId is required.", { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return new Response(auth.error, { status: auth.status });
    if (!canAccessFinance(auth.membership)) return new Response("You don't have finance access.", { status: 403 });

    const { invoices, orgs, crmContacts, departments } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const invoice = await invoices.findOne({ _id: toObjectId(invoiceId), orgId: orgObjectId, deletedAt: null });
    if (!invoice) return new Response("Invoice not found.", { status: 404 });
    if (!canAccessDepartment(auth.membership, invoice.departmentId)) return new Response("You don't have access to this department.", { status: 403 });

    const [org, contact, department] = await Promise.all([
      orgs.findOne({ _id: orgObjectId }),
      crmContacts.findOne({ _id: invoice.contactId, orgId: orgObjectId }),
      departments.findOne({ _id: invoice.departmentId, orgId: orgObjectId }),
    ]);

    let conversionRow = "";
    if (displayCurrency && isSupportedCurrency(displayCurrency) && displayCurrency !== invoice.currency) {
      const result = convert(invoice.total, invoice.currency, displayCurrency);
      conversionRow = result.error
        ? `<p class="muted">Converted total unavailable: ${escapeHtml(result.error)}</p>`
        : `<p class="muted">≈ ${fmtMoney(result.convertedAmount, displayCurrency)} at ${result.rate.toFixed(4)} (reference rate as of ${result.ratesAsOf}, not a live rate)</p>`;
    }

    const rows = invoice.lineItems.map((item) => `
      <tr>
        <td>${escapeHtml(item.description)}</td>
        <td class="num">${item.quantity}</td>
        <td class="num">${fmtMoney(item.unitPrice, invoice.currency)}</td>
        <td class="num">${fmtMoney(item.quantity * item.unitPrice, invoice.currency)}</td>
      </tr>`).join("");

    const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Invoice ${escapeHtml(invoice.invoiceNumber)}</title>
<style>
  body { font-family: -apple-system, Arial, sans-serif; color: #0f172a; margin: 0; padding: 40px; }
  .toolbar { display: flex; justify-content: flex-end; gap: 8px; margin-bottom: 24px; }
  .toolbar button { font: inherit; font-weight: 700; font-size: 12px; padding: 10px 16px; border-radius: 8px; border: none; background: #00b3bd; color: white; cursor: pointer; }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #0f172a; padding-bottom: 16px; margin-bottom: 24px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .muted { color: #64748b; font-size: 12px; }
  .parties { display: flex; justify-content: space-between; margin-bottom: 24px; }
  .parties h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin: 0 0 6px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #e2e8f0; font-size: 13px; }
  th { font-size: 11px; text-transform: uppercase; color: #64748b; }
  .num { text-align: right; }
  .totals { margin-left: auto; width: 260px; }
  .totals div { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }
  .totals .grand { font-weight: 700; font-size: 16px; border-top: 2px solid #0f172a; margin-top: 6px; padding-top: 8px; }
  .status { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; background: #e2e8f0; }
  @media print { .toolbar { display: none; } body { padding: 0; } }
</style></head>
<body>
  <div class="toolbar"><button onclick="window.print()">Print / Save as PDF</button></div>
  <header>
    <div><h1>${escapeHtml(org?.name || "Invoice")}</h1><p class="muted">Invoice</p></div>
    <div style="text-align:right">
      <p class="muted">Invoice #</p><p><strong>${escapeHtml(invoice.invoiceNumber)}</strong></p>
    </div>
  </header>
  <div class="parties">
    <div><h3>Bill To</h3><p>${escapeHtml(contact?.name || "Unknown contact")}</p><p class="muted">${escapeHtml(contact?.company || "")}</p><p class="muted">${escapeHtml(contact?.email || "")}</p></div>
    <div style="text-align:right">
      <p class="muted">Department: ${escapeHtml(department?.name || "—")}</p>
      <p class="muted">Issue date: ${new Date(invoice.issueDate).toLocaleDateString()}</p>
      <p class="muted">Due date: ${new Date(invoice.dueDate).toLocaleDateString()}</p>
      <p class="status">${escapeHtml(invoice.status)}</p>
    </div>
  </div>
  <table>
    <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit Price</th><th class="num">Amount</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="totals">
    <div><span>Subtotal</span><span>${fmtMoney(invoice.subtotal, invoice.currency)}</span></div>
    <div class="grand"><span>Total</span><span>${fmtMoney(invoice.total, invoice.currency)}</span></div>
  </div>
  ${conversionRow}
  ${invoice.notes ? `<p class="muted" style="margin-top:24px">${escapeHtml(invoice.notes)}</p>` : ""}
</body></html>`;

    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  } catch (err) {
    console.error("orgs/finance/invoices/[invoiceId]/pdf GET failed:", err);
    return new Response("Could not generate the invoice.", { status: 500 });
  }
}
