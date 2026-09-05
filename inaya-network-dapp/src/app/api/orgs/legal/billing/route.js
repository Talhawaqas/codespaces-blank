// app/api/orgs/legal/billing/route.js
// GET   ?orgId=&matterId= -> list billing records for a matter
// POST  { orgId, matterId, arrangement:"hourly"|"fixed"|"retainer", ... } -> generate a bill
// PATCH { orgId, billingId, action } -> transition (send/markPaid/cancel)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { generateHourlyInvoice, createFixedOrRetainerBilling, transitionLegalBilling, listBillingForMatter } from "../../../../../lib/legal-billing-workflow.js";

function serialize(b) {
  return { id: b._id.toString(), arrangement: b.arrangement, status: b.status, total: b.total, currency: b.currency, createdAt: b.createdAt };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const matterId = searchParams.get("matterId");
    if (!orgId || !matterId) return NextResponse.json({ error: "orgId and matterId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const billing = await listBillingForMatter(orgId, matterId);
    return NextResponse.json({ billing: billing.map(serialize) });
  } catch (err) {
    console.error("orgs/legal/billing GET failed:", err);
    return NextResponse.json({ error: "Could not fetch billing records." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, matterId, arrangement } = body;
    if (!orgId || !matterId || !arrangement) return NextResponse.json({ error: "orgId, matterId, and arrangement are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = arrangement === "hourly"
      ? await generateHourlyInvoice({ orgId, matterId, clientId: body.clientId, actorEmail: auth.session.email, membership: auth.membership })
      : await createFixedOrRetainerBilling({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ billing: serialize(result.billing) });
  } catch (err) {
    console.error("orgs/legal/billing POST failed:", err);
    return NextResponse.json({ error: "Could not generate bill." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, billingId, action } = await req.json();
    if (!orgId || !billingId || !action) return NextResponse.json({ error: "orgId, billingId, and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await transitionLegalBilling({ orgId, billingId, action, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ billing: serialize(result.billing) });
  } catch (err) {
    console.error("orgs/legal/billing PATCH failed:", err);
    return NextResponse.json({ error: "Could not update billing status." }, { status: 500 });
  }
}
