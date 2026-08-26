// app/api/orgs/inventory/products/[productId]/route.js
//
// GET single product (with totalStock/lowStock, same as the list route);
// PATCH field edits including status (ACTIVE/DISCONTINUED); DELETE
// soft-deletes. Department-access-only, collaborative record.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../../../lib/orgs.js";
import { totalStockForProduct, isLowStock } from "../../../../../../lib/inventory.js";

const STATUSES = ["ACTIVE", "DISCONTINUED"];

function serializeProduct(p, totalStock) {
  return {
    id: p._id.toString(), orgId: p.orgId.toString(), departmentId: p.departmentId.toString(),
    sku: p.sku, name: p.name, description: p.description || null, unitPrice: p.unitPrice ?? null,
    reorderThreshold: p.reorderThreshold || 0, status: p.status,
    totalStock, lowStock: isLowStock(p, totalStock),
    createdByEmail: p.createdByEmail, createdAt: p.createdAt, updatedAt: p.updatedAt,
  };
}

async function loadAuthorized(req, orgId, productId) {
  await ensureOrgIndexes();
  const auth = await requireMembership(req, orgId);
  if (auth.error) return { error: auth.error, status: auth.status };

  const { products } = await getOrgCollections();
  const product = await products.findOne({ _id: toObjectId(productId), orgId: toObjectId(orgId), deletedAt: null });
  if (!product) return { error: "Product not found.", status: 404 };
  if (!canAccessDepartment(auth.membership, product.departmentId)) return { error: "Product not found.", status: 404 };

  return { auth, product, products };
}

export async function GET(req, { params }) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    const result = await loadAuthorized(req, orgId, params.productId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    const total = await totalStockForProduct(orgId, result.product._id);
    return NextResponse.json(serializeProduct(result.product, total));
  } catch (err) {
    console.error("orgs/inventory/products/[productId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch the product." }, { status: 500 });
  }
}

export async function PATCH(req, { params }) {
  try {
    const { orgId, name, description, unitPrice, reorderThreshold, status } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    const result = await loadAuthorized(req, orgId, params.productId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    const { products, product } = result;

    const updateFields = { updatedAt: new Date().toISOString() };
    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) return NextResponse.json({ error: "Product name cannot be empty." }, { status: 400 });
      updateFields.name = trimmed;
    }
    if (description !== undefined) updateFields.description = description ? String(description).trim() : null;
    if (unitPrice !== undefined) {
      if (unitPrice !== null && !Number.isFinite(unitPrice)) return NextResponse.json({ error: "unitPrice must be a number." }, { status: 400 });
      updateFields.unitPrice = unitPrice;
    }
    if (reorderThreshold !== undefined) {
      if (!Number.isFinite(reorderThreshold) || reorderThreshold < 0) return NextResponse.json({ error: "reorderThreshold must be a non-negative number." }, { status: 400 });
      updateFields.reorderThreshold = reorderThreshold;
    }
    if (status !== undefined) {
      if (!STATUSES.includes(status)) return NextResponse.json({ error: "Invalid status." }, { status: 400 });
      updateFields.status = status;
    }

    await products.updateOne({ _id: product._id }, { $set: updateFields });
    const updated = await products.findOne({ _id: product._id });
    const total = await totalStockForProduct(orgId, product._id);
    return NextResponse.json(serializeProduct(updated, total));
  } catch (err) {
    console.error("orgs/inventory/products/[productId] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update the product." }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    const result = await loadAuthorized(req, orgId, params.productId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    await result.products.updateOne({ _id: result.product._id }, { $set: { deletedAt: new Date().toISOString() } });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    console.error("orgs/inventory/products/[productId] DELETE failed:", err);
    return NextResponse.json({ error: "Could not delete the product." }, { status: 500 });
  }
}
