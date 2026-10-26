// app/api/orgs/inventory/boms/route.js
//
// GET  /api/orgs/inventory/boms?orgId=...   -> bills of materials in the member's departments
// POST /api/orgs/inventory/boms  { orgId, productId, outputQuantity, components: [{ productId, quantity }], notes? }
//   -> creates or replaces the BOM for that finished product (src/lib/production.js).

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../../lib/orgs.js";
import { saveBom, serializeBom } from "../../../../../lib/production.js";

async function productNames(products, org, ids) {
  return new Map((await products.find({ orgId: org, _id: { $in: ids } }, { projection: { name: 1 } }).toArray()).map((p) => [p._id.toString(), p.name]));
}

export async function GET(req) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { boms, products } = await getOrgCollections();
    const org = toObjectId(orgId);
    const list = (await boms.find({ orgId: org, deletedAt: null }).sort({ updatedAt: -1 }).limit(500).toArray()).filter((b) => canAccessDepartment(auth.membership, b.departmentId));
    const names = await productNames(products, org, list.flatMap((b) => [b.productId, ...b.components.map((c) => c.productId)]));
    return NextResponse.json({ boms: list.map((b) => serializeBom(b, names)) });
  } catch (err) {
    console.error("orgs/inventory/boms GET failed:", err);
    return NextResponse.json({ error: "Could not fetch bills of materials." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    if (!body.orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, body.orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const result = await saveBom({ ...body, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    const { products } = await getOrgCollections();
    const org = toObjectId(body.orgId);
    const names = await productNames(products, org, [result.bom.productId, ...result.bom.components.map((c) => c.productId)]);
    return NextResponse.json(serializeBom(result.bom, names));
  } catch (err) {
    console.error("orgs/inventory/boms POST failed:", err);
    return NextResponse.json({ error: "Could not save the bill of materials." }, { status: 500 });
  }
}
