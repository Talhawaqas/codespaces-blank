// app/api/orgs/inventory/production/route.js
//
// GET  /api/orgs/inventory/production?orgId=...[&status=...]
//   -> production orders in the member's departments, plus `plan`: what the
//      open orders need against stock, with any shortfall (src/lib/production.js).
// POST /api/orgs/inventory/production  { orgId, productId, quantity, warehouseId, dueDate?, notes? }
//   -> creates a PLANNED production order from the product's bill of materials.
// POST /api/orgs/inventory/production  { orgId, action: "draftShortages" }
//   -> drafts a purchase request per short component (skips any already open).

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../../lib/orgs.js";
import { createProductionOrder, serializeProductionOrder, materialsPlan, draftShortageRequests, productionNames as names, PRODUCTION_STATES } from "../../../../../lib/production.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { productionOrders } = await getOrgCollections();
    const q = { orgId: toObjectId(orgId), deletedAt: null };
    const status = searchParams.get("status");
    if (PRODUCTION_STATES.includes(status)) q.status = status;
    const orders = (await productionOrders.find(q).sort({ createdAt: -1 }).limit(500).toArray()).filter((o) => canAccessDepartment(auth.membership, o.departmentId));
    const n = await names(orgId, orders);
    return NextResponse.json({ orders: orders.map((o) => serializeProductionOrder(o, n)), plan: await materialsPlan({ orgId, membership: auth.membership }) });
  } catch (err) {
    console.error("orgs/inventory/production GET failed:", err);
    return NextResponse.json({ error: "Could not fetch production orders." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    if (!body.orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, body.orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (body.action === "draftShortages") {
      return NextResponse.json(await draftShortageRequests({ orgId: body.orgId, membership: auth.membership, actorEmail: auth.session.email }));
    }
    const result = await createProductionOrder({ ...body, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(serializeProductionOrder(result.order, await names(body.orgId, [result.order])));
  } catch (err) {
    console.error("orgs/inventory/production POST failed:", err);
    return NextResponse.json({ error: "Could not create the production order." }, { status: 500 });
  }
}
