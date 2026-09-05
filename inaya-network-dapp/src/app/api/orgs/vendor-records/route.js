// app/api/orgs/vendor-records/route.js
// GET   ?orgId= -> list vendors
// POST  { orgId, name, service, ... } -> add a vendor
// PATCH { orgId, vendorId, securityReviewStatus, risk } -> update review status

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { createVendor, updateVendorSecurityReview, listVendors } from "../../../../lib/vendor-management.js";

function serialize(v) {
  return { id: v._id.toString(), name: v.name, service: v.service, securityReviewStatus: v.securityReviewStatus, risk: v.risk, renewalDate: v.renewalDate };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const vendors = await listVendors(orgId);
    return NextResponse.json({ vendors: vendors.map(serialize) });
  } catch (err) {
    console.error("orgs/vendor-records GET failed:", err);
    return NextResponse.json({ error: "Could not fetch vendor records." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    if (!body.orgId || !body.name || !body.service) return NextResponse.json({ error: "orgId, name, and service are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, body.orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await createVendor({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ vendor: serialize(result.vendor) });
  } catch (err) {
    console.error("orgs/vendor-records POST failed:", err);
    return NextResponse.json({ error: "Could not add vendor." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, vendorId, securityReviewStatus, risk } = await req.json();
    if (!orgId || !vendorId || !securityReviewStatus) return NextResponse.json({ error: "orgId, vendorId, and securityReviewStatus are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await updateVendorSecurityReview({ orgId, vendorId, securityReviewStatus, risk, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ vendor: serialize(result.vendor) });
  } catch (err) {
    console.error("orgs/vendor-records PATCH failed:", err);
    return NextResponse.json({ error: "Could not update vendor review status." }, { status: 500 });
  }
}
