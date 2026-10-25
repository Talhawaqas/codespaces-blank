// app/api/admin/billing-requests/route.js
//
// Admin only (the admin dashboard session). GET lists PKR package requests;
// POST { action: "activate", requestId, months, paymentReference? } turns a
// paid request into an active plan, { action: "decline", requestId } closes
// one. See src/lib/billingRequests.js.

import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../lib/admin-auth";
import { listBillingRequests, activatePkRequest, declinePkRequest } from "../../../../lib/billingRequests.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  if (!isAdminAuthenticated(req)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    return NextResponse.json({ requests: await listBillingRequests() });
  } catch (err) {
    console.error("admin/billing-requests GET failed:", err);
    return NextResponse.json({ error: "Could not load requests." }, { status: 500 });
  }
}

export async function POST(req) {
  if (!isAdminAuthenticated(req)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  try {
    const result = body.action === "activate"
      ? await activatePkRequest({ requestId: body.requestId, months: body.months, paymentReference: body.paymentReference })
      : body.action === "decline"
      ? await declinePkRequest({ requestId: body.requestId })
      : { error: "action must be activate or decline.", status: 400 };
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("admin/billing-requests POST failed:", err);
    return NextResponse.json({ error: "Could not update the request." }, { status: 500 });
  }
}
