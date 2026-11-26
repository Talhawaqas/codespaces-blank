// app/api/orgs/billing/activation-request/route.js
//
// POST { orgId, planId, interval?, extraUsers?, pilot?, paymentMethod: "nayapay"|"bank_transfer",
//        contact: { name, phone, companySize?, preferredContact?, message? } }
// A company asks for a package. Replaces self-serve card checkout for every region (founder
// decision, 15 Nov 2026): PKR packages for companies in Pakistan, USD everywhere else, paid by
// NayaPay or bank transfer. The request is recorded, emailed to the activation inbox, and filed
// into its Customers folder (src/lib/mailboxFiling.js). Owner/admin only.

import { NextResponse, after } from "next/server";
import { ensureOrgIndexes, requireMembership, getOrgCollections, toObjectId } from "../../../../../lib/orgs.js";
import { requestPkPlan, requestUsdPlan, cleanActivationContact, PAYMENT_METHODS } from "../../../../../lib/billingRequests.js";
import { pricingRegion } from "../../../../../lib/pkPricing.js";
import { fileActivationRequestsSoon } from "../../../../../lib/mailboxFiling.js";

export const maxDuration = 60;

export async function POST(req) {
  try {
    let body = {};
    try { body = await req.json(); } catch { body = {}; }
    const { orgId, planId, interval = "month", pilot = false, extraUsers = 0, addOns = {}, paymentMethod } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    if (!PAYMENT_METHODS[paymentMethod]) return NextResponse.json({ error: "Choose NayaPay or bank transfer." }, { status: 400 });
    const { contact, error } = cleanActivationContact(body.contact);
    if (error) return NextResponse.json({ error }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { orgs } = await getOrgCollections();
    const org = await orgs.findOne({ _id: toObjectId(orgId) }, { projection: { billingRegion: 1 } });
    const region = pricingRegion({ country: req.headers.get("x-vercel-ip-country"), orgRegion: org?.billingRegion });
    const args = { orgId, planId, interval, extraUsers: Number(extraUsers) || 0, addOns, actorEmail: auth.session.email, membership: auth.membership, contact, paymentMethod };
    const result = region === "PK" ? await requestPkPlan({ ...args, pilot: !!pilot }) : await requestUsdPlan(args);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    // File the email into the Customers folder once it has arrived, without delaying the response.
    after(() => fileActivationRequestsSoon().catch((err) => console.error("activation-request: filing failed:", err.message)));
    return NextResponse.json({ ...result, region });
  } catch (err) {
    console.error("orgs/billing/activation-request failed:", err);
    return NextResponse.json({ error: "Could not record your request. Please try again." }, { status: 500 });
  }
}
