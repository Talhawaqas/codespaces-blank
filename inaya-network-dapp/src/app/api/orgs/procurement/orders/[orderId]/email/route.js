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
    const recipient = to ? String(to).trim() : supplier?.email;
    if (!recipient) return NextResponse.json({ error: "No recipient email available — pass one explicitly or add an email to this supplier." }, { status: 400 });

    const rows = po.items.map((i) => `<tr><td>${i.description}</td><td style="text-align:right">${i.quantity}</td><td style="text-align:right">${i.unitPrice ?? "—"}</td></tr>`).join("");
    const total = po.items.reduce((s, i) => s + i.quantity * (i.unitPrice || 0), 0);
    const html = `<h2>Purchase Order</h2><p>From: ${org?.name || "Our company"}</p><p>Status: ${po.status}</p>
      <table border="1" cellpadding="6" style="border-collapse:collapse"><tr><th>Description</th><th>Qty</th><th>Unit Price</th></tr>${rows}</table>
      <p><strong>Total: ${po.currency || "USD"} ${total.toFixed(2)}</strong></p>`;

    const result = await sendEmail({ to: recipient, subject: `Purchase Order from ${org?.name || "Inaya"}`, html, text: `Purchase order, total ${po.currency || "USD"} ${total.toFixed(2)}, status ${po.status}.` });
    return NextResponse.json({ sent: result.sent, to: recipient, reason: result.reason || null });
  } catch (err) {
    console.error("orgs/procurement/orders/[orderId]/email POST failed:", err);
    return NextResponse.json({ error: "Could not email the purchase order." }, { status: 500 });
  }
}
