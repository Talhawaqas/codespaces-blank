// app/api/orgs/inventory/products/[productId]/reorder/route.js
//
// POST /api/orgs/inventory/products/:productId/reorder  { orgId }
//   -> drafts a purchase request for a low-stock product (see
//      lib/inventory-reorder.js). Anyone with access to the product's
//      department may draft one, the same rule as creating a purchase
//      request by hand. Returns the existing request instead of a second
//      one when a reorder is already in flight.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../../../../lib/orgs.js";
import { draftReorderRequest } from "../../../../../../../lib/inventory-reorder.js";

export async function POST(req, { params }) {
  try {
    const { orgId } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { products } = await getOrgCollections();
    const product = await products.findOne({ _id: toObjectId(params.productId), orgId: toObjectId(orgId), deletedAt: null });
    if (!product || !canAccessDepartment(auth.membership, product.departmentId)) {
      return NextResponse.json({ error: "Product not found." }, { status: 404 });
    }

    const result = await draftReorderRequest({ orgId, productId: params.productId, actorEmail: auth.session.email, source: "manual" });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json({
      created: result.created,
      request: {
        id: result.request._id.toString(), title: result.request.title, status: result.request.status,
        estimatedCost: result.request.estimatedCost ?? null, reorderQuantity: result.request.reorderQuantity ?? null,
      },
    });
  } catch (err) {
    console.error("orgs/inventory/products/[productId]/reorder failed:", err);
    return NextResponse.json({ error: "Could not draft the reorder request." }, { status: 500 });
  }
}
