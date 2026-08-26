// app/api/orgs/crm/deals/[dealId]/route.js
//
// GET single deal; PATCH field edits (title/value only — stage changes
// go through transition/route.js); DELETE soft-deletes. Same collaborative,
// department-access-only permission model as contacts — no creator/
// assignee restriction, a deal is a shared team record.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../../../lib/orgs.js";

function serializeDeal(d) {
  return {
    id: d._id.toString(), orgId: d.orgId.toString(), departmentId: d.departmentId.toString(),
    contactId: d.contactId.toString(), projectId: d.projectId ? d.projectId.toString() : null,
    title: d.title, value: d.value ?? null, status: d.status,
    createdByEmail: d.createdByEmail, createdAt: d.createdAt, updatedAt: d.updatedAt, closedAt: d.closedAt || null,
  };
}

async function loadAuthorized(req, orgId, dealId) {
  await ensureOrgIndexes();
  const auth = await requireMembership(req, orgId);
  if (auth.error) return { error: auth.error, status: auth.status };

  const { crmDeals } = await getOrgCollections();
  const deal = await crmDeals.findOne({ _id: toObjectId(dealId), orgId: toObjectId(orgId), deletedAt: null });
  if (!deal) return { error: "Deal not found.", status: 404 };
  if (!canAccessDepartment(auth.membership, deal.departmentId)) return { error: "Deal not found.", status: 404 };

  return { auth, deal, crmDeals };
}

export async function GET(req, { params }) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    const result = await loadAuthorized(req, orgId, params.dealId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(serializeDeal(result.deal));
  } catch (err) {
    console.error("orgs/crm/deals/[dealId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch the deal." }, { status: 500 });
  }
}

export async function PATCH(req, { params }) {
  try {
    const { orgId, title, value } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    const result = await loadAuthorized(req, orgId, params.dealId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    const { crmDeals, deal } = result;

    const updateFields = { updatedAt: new Date().toISOString() };
    if (title !== undefined) {
      const trimmed = String(title).trim();
      if (!trimmed) return NextResponse.json({ error: "Deal title cannot be empty." }, { status: 400 });
      updateFields.title = trimmed;
    }
    if (value !== undefined) {
      if (value !== null && !Number.isFinite(value)) return NextResponse.json({ error: "value must be a number." }, { status: 400 });
      updateFields.value = value;
    }

    await crmDeals.updateOne({ _id: deal._id }, { $set: updateFields });
    const updated = await crmDeals.findOne({ _id: deal._id });
    return NextResponse.json(serializeDeal(updated));
  } catch (err) {
    console.error("orgs/crm/deals/[dealId] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update the deal." }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    const result = await loadAuthorized(req, orgId, params.dealId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    await result.crmDeals.updateOne({ _id: result.deal._id }, { $set: { deletedAt: new Date().toISOString() } });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    console.error("orgs/crm/deals/[dealId] DELETE failed:", err);
    return NextResponse.json({ error: "Could not delete the deal." }, { status: 500 });
  }
}
