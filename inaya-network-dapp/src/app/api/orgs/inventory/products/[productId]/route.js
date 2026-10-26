// app/api/orgs/inventory/products/[productId]/route.js
//
// GET single product (with totalStock/lowStock, same as the list route);
// PATCH field edits including status (ACTIVE/DISCONTINUED); DELETE
// soft-deletes. Department-access-only, collaborative record.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../../../lib/orgs.js";
import { totalStockForProduct, isLowStock } from "../../../../../../lib/inventory.js";
import { findOpenReorderRequest } from "../../../../../../lib/inventory-reorder.js";
import { validateUnitFields, DEFAULT_UNIT } from "../../../../../../lib/inventory-units.js";
import { openingLotsForExistingStock } from "../../../../../../lib/inventory-lots.js";

const STATUSES = ["ACTIVE", "DISCONTINUED"];

function serializeProduct(p, totalStock) {
  return {
    id: p._id.toString(), orgId: p.orgId.toString(), departmentId: p.departmentId.toString(),
    sku: p.sku, name: p.name, description: p.description || null, unitPrice: p.unitPrice ?? null,
    reorderThreshold: p.reorderThreshold || 0, status: p.status,
    reorderQuantity: p.reorderQuantity ?? null, autoReorder: !!p.autoReorder,
    barcode: p.barcode || null, unit: p.unit || DEFAULT_UNIT, purchaseUnit: p.purchaseUnit || null, unitsPerPurchaseUnit: p.unitsPerPurchaseUnit ?? null,
    trackLots: !!p.trackLots,
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
    const serialized = serializeProduct(result.product, total);
    if (serialized.lowStock) {
      const open = await findOpenReorderRequest(orgId, result.product._id);
      serialized.openReorderRequestId = open ? open._id.toString() : null;
    }
    return NextResponse.json(serialized);
  } catch (err) {
    console.error("orgs/inventory/products/[productId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch the product." }, { status: 500 });
  }
}

export async function PATCH(req, { params }) {
  try {
    const body = await req.json();
    const { orgId, name, description, unitPrice, reorderThreshold, status, reorderQuantity, autoReorder, trackLots } = body;
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
    if (reorderQuantity !== undefined) {
      if (reorderQuantity !== null && (!Number.isInteger(reorderQuantity) || reorderQuantity < 1)) {
        return NextResponse.json({ error: "reorderQuantity must be a whole number of at least 1, or empty." }, { status: 400 });
      }
      updateFields.reorderQuantity = reorderQuantity;
    }
    if (autoReorder !== undefined) {
      if (typeof autoReorder !== "boolean") return NextResponse.json({ error: "autoReorder must be true or false." }, { status: 400 });
      updateFields.autoReorder = autoReorder;
    }

    if (trackLots !== undefined) {
      if (typeof trackLots !== "boolean") return NextResponse.json({ error: "trackLots must be true or false." }, { status: 400 });
      updateFields.trackLots = trackLots;
    }

    const units = validateUnitFields(body, { existing: product });
    if (units.error) return NextResponse.json({ error: units.error }, { status: 400 });
    if (units.fields.barcode && await products.findOne({ orgId: product.orgId, barcode: units.fields.barcode, _id: { $ne: product._id } })) {
      return NextResponse.json({ error: `Barcode "${units.fields.barcode}" is already used by another product.` }, { status: 409 });
    }
    Object.assign(updateFields, units.fields);
    try {
      await products.updateOne({ _id: product._id }, { $set: updateFields });
    } catch (e) {
      if (e?.code === 11000) return NextResponse.json({ error: "That barcode is already used by another product." }, { status: 409 });
      throw e;
    }
    // Turning batch tracking on: stock already held becomes an OPENING-STOCK batch.
    if (trackLots === true && !product.trackLots) {
      const { stockLevels, stockLots } = await getOrgCollections();
      await openingLotsForExistingStock({ stockLevels, stockLots, orgId: product.orgId, productId: product._id });
    }
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
