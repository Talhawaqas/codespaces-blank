// app/api/orgs/sales/orders/route.js
//
// GET  /api/orgs/sales/orders?orgId=...&status=...&contactId=...
//   -> sales (wholesale) orders in the departments this member can access, newest first.
// POST /api/orgs/sales/orders  { orgId, departmentId, contactId, warehouseId, currency?, lines: [{ productId, quantity, unitPrice, description?, lotNumber? }], deliveryDate?, notes? }
//   -> creates a DRAFT order. See src/lib/sales-orders.js for the workflow.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../../lib/orgs.js";
import { createSalesOrder, serializeSalesOrder, SALES_ORDER_STATES } from "../../../../../lib/sales-orders.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { salesOrders, crmContacts, warehouses } = await getOrgCollections();
    const org = toObjectId(orgId);
    const q = { orgId: org, deletedAt: null };
    const status = searchParams.get("status");
    if (SALES_ORDER_STATES.includes(status)) q.status = status;
    const contactId = searchParams.get("contactId");
    if (contactId) q.contactId = toObjectId(contactId);
    const orders = (await salesOrders.find(q).sort({ createdAt: -1 }).limit(500).toArray()).filter((o) => canAccessDepartment(auth.membership, o.departmentId));

    const [contacts, allWarehouses] = await Promise.all([
      crmContacts.find({ orgId: org, _id: { $in: [...new Set(orders.map((o) => o.contactId.toString()))].map(toObjectId) } }, { projection: { name: 1, company: 1 } }).toArray(),
      warehouses.find({ orgId: org }, { projection: { name: 1 } }).toArray(),
    ]);
    const customer = new Map(contacts.map((c) => [c._id.toString(), c.company || c.name]));
    const warehouse = new Map(allWarehouses.map((w) => [w._id.toString(), w.name]));
    return NextResponse.json({ orders: orders.map((o) => serializeSalesOrder(o, { customer: customer.get(o.contactId.toString()), warehouse: warehouse.get(o.warehouseId.toString()) })) });
  } catch (err) {
    console.error("orgs/sales/orders GET failed:", err);
    return NextResponse.json({ error: "Could not fetch sales orders." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    if (!body.orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, body.orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const result = await createSalesOrder({ ...body, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result.order);
  } catch (err) {
    console.error("orgs/sales/orders POST failed:", err);
    return NextResponse.json({ error: "Could not create the sales order." }, { status: 500 });
  }
}
