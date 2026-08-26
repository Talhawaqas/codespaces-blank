// app/api/orgs/inventory/products/route.js
//
// GET  /api/orgs/inventory/products?orgId=...&departmentId=...&lowStockOnly=true
//   -> each product is annotated with totalStock (summed across every
//      warehouse from the real stock_levels collection, one extra query,
//      not re-derived per-product) and lowStock (totalStock <=
//      reorderThreshold, only meaningful when reorderThreshold > 0 — see
//      inventory.js's isLowStock()).
// POST /api/orgs/inventory/products  { orgId, departmentId, sku, name, description?, unitPrice?, reorderThreshold? }
//   -> create. sku must be unique per org (enforced by both an app-level
//      check here for a clean 409 and the unique index as the real
//      guarantee under a race).

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../../lib/orgs.js";
import { getAccessibleScope } from "../../../../../lib/document-permissions.js";
import { isLowStock } from "../../../../../lib/inventory.js";

function serializeProduct(p, totalStock) {
  return {
    id: p._id.toString(), orgId: p.orgId.toString(), departmentId: p.departmentId.toString(),
    sku: p.sku, name: p.name, description: p.description || null, unitPrice: p.unitPrice ?? null,
    reorderThreshold: p.reorderThreshold || 0, status: p.status,
    totalStock, lowStock: isLowStock(p, totalStock),
    createdByEmail: p.createdByEmail, createdAt: p.createdAt, updatedAt: p.updatedAt,
  };
}

async function attachStock(list) {
  if (list.length === 0) return [];
  const { stockLevels } = await getOrgCollections();
  const productIds = list.map((p) => p._id);
  const levels = await stockLevels.find({ productId: { $in: productIds } }).toArray();
  const totalByProduct = new Map();
  for (const l of levels) {
    const key = l.productId.toString();
    totalByProduct.set(key, (totalByProduct.get(key) || 0) + l.quantity);
  }
  return list.map((p) => serializeProduct(p, totalByProduct.get(p._id.toString()) || 0));
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const departmentId = searchParams.get("departmentId");
    const lowStockOnly = searchParams.get("lowStockOnly") === "true";
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    let list;
    if (departmentId) {
      if (!canAccessDepartment(auth.membership, departmentId)) {
        return NextResponse.json({ error: "You don't have access to this department." }, { status: 403 });
      }
      const { products } = await getOrgCollections();
      list = await products.find({ orgId: toObjectId(orgId), departmentId: toObjectId(departmentId), deletedAt: null }).sort({ name: 1 }).toArray();
    } else {
      const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
      list = scope.visibleProducts;
    }

    let serialized = await attachStock(list);
    if (lowStockOnly) serialized = serialized.filter((p) => p.lowStock);

    return NextResponse.json({ products: serialized });
  } catch (err) {
    console.error("orgs/inventory/products GET failed:", err);
    return NextResponse.json({ error: "Could not fetch products." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { orgId, departmentId, sku: rawSku, name: rawName, description, unitPrice, reorderThreshold } = await req.json();
    const sku = String(rawSku || "").trim();
    const name = String(rawName || "").trim();
    if (!orgId || !departmentId) return NextResponse.json({ error: "orgId and departmentId are required." }, { status: 400 });
    if (!sku) return NextResponse.json({ error: "SKU is required." }, { status: 400 });
    if (!name) return NextResponse.json({ error: "Product name is required." }, { status: 400 });
    if (unitPrice !== undefined && unitPrice !== null && !Number.isFinite(unitPrice)) return NextResponse.json({ error: "unitPrice must be a number." }, { status: 400 });
    if (reorderThreshold !== undefined && reorderThreshold !== null && (!Number.isFinite(reorderThreshold) || reorderThreshold < 0)) {
      return NextResponse.json({ error: "reorderThreshold must be a non-negative number." }, { status: 400 });
    }

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessDepartment(auth.membership, departmentId)) {
      return NextResponse.json({ error: "You don't have access to this department." }, { status: 403 });
    }

    const { departments, products } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const departmentObjectId = toObjectId(departmentId);
    const department = await departments.findOne({ _id: departmentObjectId, orgId: orgObjectId });
    if (!department) return NextResponse.json({ error: "Department not found." }, { status: 404 });

    const existing = await products.findOne({ orgId: orgObjectId, sku });
    if (existing) return NextResponse.json({ error: `A product with SKU "${sku}" already exists in this company.` }, { status: 409 });

    const now = new Date().toISOString();
    const result = await products.insertOne({
      orgId: orgObjectId, departmentId: departmentObjectId, sku, name,
      description: description ? String(description).trim() : null,
      unitPrice: unitPrice ?? null, reorderThreshold: reorderThreshold ?? 0,
      status: "ACTIVE", createdByEmail: auth.session.email, createdAt: now, updatedAt: now, deletedAt: null,
    });

    return NextResponse.json(serializeProduct({
      _id: result.insertedId, orgId: orgObjectId, departmentId: departmentObjectId, sku, name, description,
      unitPrice: unitPrice ?? null, reorderThreshold: reorderThreshold ?? 0, status: "ACTIVE",
      createdByEmail: auth.session.email, createdAt: now, updatedAt: now,
    }, 0));
  } catch (err) {
    console.error("orgs/inventory/products POST failed:", err);
    return NextResponse.json({ error: "Could not create the product." }, { status: 500 });
  }
}
