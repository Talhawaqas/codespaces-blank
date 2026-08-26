// app/api/orgs/procurement/requests/[requestId]/route.js
//
// GET single request; PATCH field edits (only while DRAFT — once
// submitted, fields are frozen and only transition/route.js can move it);
// DELETE soft-deletes.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../../../lib/orgs.js";

function serializeRequest(r) {
  return {
    id: r._id.toString(), orgId: r.orgId.toString(), departmentId: r.departmentId.toString(),
    supplierId: r.supplierId ? r.supplierId.toString() : null,
    title: r.title, description: r.description || null, estimatedCost: r.estimatedCost ?? null,
    status: r.status, createdByEmail: r.createdByEmail, createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

async function loadAuthorized(req, orgId, requestId) {
  await ensureOrgIndexes();
  const auth = await requireMembership(req, orgId);
  if (auth.error) return { error: auth.error, status: auth.status };

  const { purchaseRequests } = await getOrgCollections();
  const request = await purchaseRequests.findOne({ _id: toObjectId(requestId), orgId: toObjectId(orgId), deletedAt: null });
  if (!request) return { error: "Purchase request not found.", status: 404 };
  if (!canAccessDepartment(auth.membership, request.departmentId)) return { error: "Purchase request not found.", status: 404 };

  return { auth, request, purchaseRequests };
}

export async function GET(req, { params }) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    const result = await loadAuthorized(req, orgId, params.requestId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(serializeRequest(result.request));
  } catch (err) {
    console.error("orgs/procurement/requests/[requestId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch the purchase request." }, { status: 500 });
  }
}

export async function PATCH(req, { params }) {
  try {
    const { orgId, title, description, estimatedCost } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    const result = await loadAuthorized(req, orgId, params.requestId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    const { purchaseRequests, request } = result;
    if (request.status !== "DRAFT") {
      return NextResponse.json({ error: "Only a DRAFT request's fields can be edited — this one has already been submitted." }, { status: 409 });
    }

    const updateFields = { updatedAt: new Date().toISOString() };
    if (title !== undefined) {
      const trimmed = String(title).trim();
      if (!trimmed) return NextResponse.json({ error: "Request title cannot be empty." }, { status: 400 });
      updateFields.title = trimmed;
    }
    if (description !== undefined) updateFields.description = description ? String(description).trim() : null;
    if (estimatedCost !== undefined) {
      if (estimatedCost !== null && !Number.isFinite(estimatedCost)) return NextResponse.json({ error: "estimatedCost must be a number." }, { status: 400 });
      updateFields.estimatedCost = estimatedCost;
    }

    await purchaseRequests.updateOne({ _id: request._id }, { $set: updateFields });
    const updated = await purchaseRequests.findOne({ _id: request._id });
    return NextResponse.json(serializeRequest(updated));
  } catch (err) {
    console.error("orgs/procurement/requests/[requestId] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update the purchase request." }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    const result = await loadAuthorized(req, orgId, params.requestId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    await result.purchaseRequests.updateOne({ _id: result.request._id }, { $set: { deletedAt: new Date().toISOString() } });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    console.error("orgs/procurement/requests/[requestId] DELETE failed:", err);
    return NextResponse.json({ error: "Could not delete the purchase request." }, { status: 500 });
  }
}
