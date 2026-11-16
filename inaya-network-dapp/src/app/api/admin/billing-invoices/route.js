// app/api/admin/billing-invoices/route.js
//
// Admin only (admin dashboard session). The invoice portal behind /admin/billing (src/lib/invoicing.js):
//   GET                                   -> saved payment details
//   GET ?preview=<requestId>&months=<n>   -> draft invoice PDF for checking
//   POST { action: "saveChannels", channels }
//   POST { action: "email", requestId, months } -> numbers, renders and emails the invoice

import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../lib/admin-auth";
import { getPaymentChannels, savePaymentChannels, previewInvoice, emailInvoice } from "../../../../lib/invoicing.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req) {
  if (!isAdminAuthenticated(req)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const url = new URL(req.url);
    const preview = url.searchParams.get("preview");
    if (preview) {
      const r = await previewInvoice({ requestId: preview, months: url.searchParams.get("months") });
      if (r.error) return NextResponse.json({ error: r.error }, { status: r.status });
      return new Response(r.pdf, { headers: { "Content-Type": "application/pdf", "Content-Disposition": "inline; filename=\"invoice-draft.pdf\"", "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ channels: await getPaymentChannels() });
  } catch (err) {
    console.error("admin/billing-invoices GET failed:", err);
    return NextResponse.json({ error: "Could not load invoice data." }, { status: 500 });
  }
}

export async function POST(req) {
  if (!isAdminAuthenticated(req)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  try {
    if (body.action === "saveChannels") return NextResponse.json({ channels: await savePaymentChannels(body.channels) });
    if (body.action === "email") {
      const r = await emailInvoice({ requestId: body.requestId, months: body.months });
      if (r.error) return NextResponse.json({ error: r.error }, { status: r.status });
      return NextResponse.json(r);
    }
    return NextResponse.json({ error: "action must be saveChannels or email." }, { status: 400 });
  } catch (err) {
    console.error("admin/billing-invoices POST failed:", err);
    return NextResponse.json({ error: "Could not complete that." }, { status: 500 });
  }
}
