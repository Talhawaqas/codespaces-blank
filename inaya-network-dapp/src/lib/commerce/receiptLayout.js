// src/lib/commerce/receiptLayout.js -- Inaya Commerce: full-page receipts for laser / inkjet printers (post-SOW, beta).
// A proper A4 or A5 page (chosen once per till in Point of Sale > Setup), instead of a narrow till-roll strip in the
// middle of the page. Built only from the receipt data the server returns for the sale (or the till's offline receipt),
// so the page always matches the transaction. Pure: returns a complete HTML document for the print window.

export const PAGE_LAYOUTS = ["strip", "A4", "A5"];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const TENDER = { CASH: "Cash", BANK_TRANSFER: "Bank transfer", MANUAL_REFERENCE: "Other", EXCHANGE_CREDIT: "Exchange credit", GIFT_CARD: "Gift card", STORE_CREDIT: "Store credit" };
export function moneyText(v, cur) {
  try { return new Intl.NumberFormat("en-GB", { style: "currency", currency: cur || "PKR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v || 0); }
  catch { return `${cur || ""} ${(Number(v) || 0).toFixed(2)}`.trim(); }
}

/** Full-page receipt document. size: "A4" | "A5". */
export function fullPageReceiptHtml(r, size = "A4") {
  const a5 = size === "A5"; const cur = r.currency; const m = (v) => esc(moneyText(v, cur));
  const when = r.completedAt ? new Date(r.completedAt) : null;
  const rows = (r.lines || []).map((l) => `<tr><td>${esc(l.name)}${l.note ? `<div class="sub">${esc(l.note)}</div>` : ""}</td><td class="n">${esc(l.quantity)}</td><td class="n">${m(l.unitPrice)}</td>${l.discount ? `<td class="n">−${m(l.discount)}</td>` : "<td class=\"n\">–</td>"}<td class="n">${l.taxRate ? `${esc(l.taxRate)}%` : "–"}</td><td class="n">${m(l.total)}</td></tr>`).join("");
  const t = r.totals || {};
  const taxRows = (t.taxBreakdown || []).filter((x) => x.tax).map((x) => `<tr><td>${esc(x.name || "Tax")} ${esc(x.rate)}%${r.taxMode === "inclusive" ? " (included)" : ""} on ${m(x.taxable)}</td><td class="n">${m(x.tax)}</td></tr>`).join("");
  const tenders = (r.tenders || []).map((x) => `<tr><td>${esc(TENDER[x.method] || x.method)}${x.reference ? ` (${esc(x.reference)})` : ""}</td><td class="n">${m(x.amount)}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.saleNumber || "Receipt")}</title><style>
@page { size: ${a5 ? "A5" : "A4"}; margin: ${a5 ? "10mm" : "16mm"}; }
* { box-sizing: border-box; } body { margin: 0; font: ${a5 ? "9.5pt" : "10.5pt"}/1.45 "Segoe UI", Arial, sans-serif; color: #111; }
.head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 12px; }
.co { font-size: ${a5 ? "14pt" : "17pt"}; font-weight: 700; } .muted { color: #555; } h1 { font-size: ${a5 ? "12pt" : "14pt"}; margin: 0; text-align: right; letter-spacing: .5px; }
table { width: 100%; border-collapse: collapse; } th { text-align: left; font-size: 8.5pt; text-transform: uppercase; color: #444; border-bottom: 1px solid #999; padding: 4px 4px; }
td { padding: 5px 4px; border-bottom: 1px solid #e3e3e3; vertical-align: top; } .n { text-align: right; white-space: nowrap; } th.n { text-align: right; }
tr { break-inside: avoid; } .sub { font-size: 8pt; color: #666; }
.totals { width: ${a5 ? "70%" : "48%"}; margin-left: auto; margin-top: 10px; } .totals td { border: 0; padding: 3px 4px; } .grand td { font-weight: 700; font-size: ${a5 ? "11pt" : "12.5pt"}; border-top: 2px solid #111; padding-top: 6px; }
.foot { margin-top: 18px; padding-top: 8px; border-top: 1px solid #ccc; font-size: 8.5pt; color: #444; white-space: pre-line; }
</style></head><body>
<div class="head"><div><div class="co">${esc(r.company)}</div><div class="muted">${esc(r.location)}</div></div>
<div><h1>RECEIPT</h1><div class="muted" style="text-align:right">${esc(r.saleNumber)}<br>${when ? esc(when.toLocaleString()) : ""}${r.cashier ? `<br>Served by ${esc(r.cashier)}` : ""}</div></div></div>
<table><thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Unit price</th><th class="n">Discount</th><th class="n">Tax</th><th class="n">Amount</th></tr></thead><tbody>${rows}</tbody></table>
<table class="totals"><tbody>
<tr><td>Subtotal</td><td class="n">${m(t.subtotal)}</td></tr>
${t.discounts ? `<tr><td>Discounts</td><td class="n">−${m(t.discounts)}</td></tr>` : ""}${taxRows}
<tr class="grand"><td>Total</td><td class="n">${m(t.total)}</td></tr>${tenders}
${r.cashRounding ? `<tr><td>Cash rounding</td><td class="n">${m(r.cashRounding)}</td></tr>` : ""}${r.change > 0 ? `<tr><td>Change</td><td class="n">${m(r.change)}</td></tr>` : ""}
</tbody></table>
<div class="foot">${[r.returnPolicy, r.footer].filter(Boolean).map(esc).join("\n")}</div>
</body></html>`;
}

/** Any receipt markup already on screen (e.g. a refund receipt), re-set for a full A4/A5 page. */
export function fullPageFromMarkup(innerHtml, title, size = "A4") {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>@page { size: ${size === "A5" ? "A5" : "A4"}; margin: ${size === "A5" ? "10mm" : "16mm"}; }
body { margin: 0; font: ${size === "A5" ? "10pt" : "11pt"}/1.5 "Segoe UI", Arial, sans-serif; color: #111; } .flex { display: flex; } .justify-between { justify-content: space-between; }
.text-center { text-align: center; } .font-bold { font-weight: 700; } .whitespace-pre-line { white-space: pre-line; } hr { border: 0; border-top: 1px solid #999; margin: 8px 0; } p { margin: 3px 0; } .text-\\[10px\\] { font-size: 8.5pt; color: #555; }
</style></head><body>${innerHtml}</body></html>`;
}
