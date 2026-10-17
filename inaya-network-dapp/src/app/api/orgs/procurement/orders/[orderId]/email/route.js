// app/api/orgs/procurement/orders/[orderId]/email/route.js
//
// POST /api/orgs/procurement/orders/:orderId/email
// Body: { orgId, to? } — to defaults to the PO's supplier's own email;
// an explicit `to` overrides it (e.g. a different contact at the
// supplier). Reuses the existing generic sendEmail() -- no new email
// pipeline. Degrades safely (per sendEmail()'s own contract) if
// RESEND_API_KEY isn't configured, rather than failing the request.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../../../../lib/orgs.js";
import { sendEmail } from "../../../../../../../lib/email.js";
import { computePoTotals } from "../../../../../../../lib/purchase-order-totals.js";

const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export async function POST(req, { params }) {
  try {
    const { orderId } = params;
    const { orgId, to } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { purchaseOrders, suppliers, orgs } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const po = await purchaseOrders.findOne({ _id: toObjectId(orderId), orgId: orgObjectId, deletedAt: null });
    if (!po) return NextResponse.json({ error: "Purchase order not found." }, { status: 404 });
    if (!canAccessDepartment(auth.membership, po.departmentId)) return NextResponse.json({ error: "You don't have permission to do that." }, { status: 403 });

    const [supplier, org] = await Promise.all([
      suppliers.findOne({ _id: po.supplierId, orgId: orgObjectId }),
      orgs.findOne({ _id: orgObjectId }),
    ]);
    // Suppliers are stored with contactEmail; `email` kept as a fallback for any older record.
    const recipient = to ? String(to).trim() : (supplier?.contactEmail || supplier?.email);
    if (!recipient) return NextResponse.json({ error: "No recipient email available — pass one explicitly or add an email to this supplier." }, { status: 400 });

    const currency = po.currency || "USD";
    const { subtotal, taxRate, taxAmount, shippingCost, total } = computePoTotals(po);
    const rows = po.items.map((i) => `<tr><td>${escapeHtml(i.description)}</td><td style="text-align:right">${escapeHtml(i.quantity)}</td><td style="text-align:right">${i.unitPrice ?? "—"}</td></tr>`).join("");
    const extraLines = taxAmount || shippingCost
      ? `<p>Subtotal: ${currency} ${subtotal.toFixed(2)}</p>${taxAmount ? `<p>Tax (${taxRate}%): ${currency} ${taxAmount.toFixed(2)}</p>` : ""}${shippingCost ? `<p>Shipping: ${currency} ${shippingCost.toFixed(2)}</p>` : ""}`
      : "";
    const delivery = po.expectedDeliveryDate ? `<p>Expected delivery: ${escapeHtml(po.expectedDeliveryDate)}</p>` : "";
    const html = `<h2>Purchase Order</h2><p>From: ${escapeHtml(org?.name || "Our company")}</p><p>Status: ${escapeHtml(po.status)}</p>${delivery}
      <table border="1" cellpadding="6" style="border-collapse:collapse"><tr><th>Description</th><th>Qty</th><th>Unit Price</th></tr>${rows}</table>
      ${extraLines}<p><strong>Total: ${currency} ${total.toFixed(2)}</strong></p>`;

    const result = await sendEmail({ to: recipient, subject: `Purchase Order from ${org?.name || "Inaya"}`, html, text: `Purchase order, total ${currency} ${total.toFixed(2)}, status ${po.status}.` });
    return NextResponse.json({ sent: result.sent, to: recipient, reason: result.reason || null });
  } catch (err) {
    console.error("orgs/procurement/orders/[orderId]/email POST failed:", err);
    return NextResponse.json({ error: "Could not email the purchase order." }, { status: 500 });
  }
}
