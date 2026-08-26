// app/api/orgs/finance/payments/route.js
//
// GET  /api/orgs/finance/payments?orgId=...&departmentId=...&direction=...
// POST /api/orgs/finance/payments  { orgId, departmentId, direction, amount, method?, paymentDate?, relatedInvoiceId?, relatedExpenseId? }
//   -> records at status RECORDED. No state machine (see plan) — a
//      separate canManageFinance-gated approve action (approve/route.js)
//      flips it to APPROVED, matching the SOW's flat "payment approval" bullet.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, canAccessFinance, toObjectId } from "../../../../../lib/orgs.js";
import { getAccessibleScope } from "../../../../../lib/document-permissions.js";
import { logOrgActivity } from "../../../../../lib/org-activity-log.js";

const DIRECTIONS = ["INCOMING", "OUTGOING"];

function serializePayment(p) {
  return {
    id: p._id.toString(), orgId: p.orgId.toString(), departmentId: p.departmentId.toString(), direction: p.direction,
    relatedInvoiceId: p.relatedInvoiceId ? p.relatedInvoiceId.toString() : null,
    relatedExpenseId: p.relatedExpenseId ? p.relatedExpenseId.toString() : null,
    amount: p.amount, currency: p.currency, method: p.method || null, paymentDate: p.paymentDate, status: p.status,
    createdByEmail: p.createdByEmail, createdAt: p.createdAt,
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const departmentId = searchParams.get("departmentId");
    const direction = searchParams.get("direction");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessFinance(auth.membership)) return NextResponse.json({ error: "You don't have finance access." }, { status: 403 });

    let list;
    if (departmentId) {
      if (!canAccessDepartment(auth.membership, departmentId)) {
        return NextResponse.json({ error: "You don't have access to this department." }, { status: 403 });
      }
      const { payments } = await getOrgCollections();
      list = await payments.find({ orgId: toObjectId(orgId), departmentId: toObjectId(departmentId), deletedAt: null }).sort({ createdAt: -1 }).toArray();
    } else {
      // Payments have no dedicated getAccessibleScope() entry (a flat,
      // low-cardinality record type); resolve visible departments the
      // same way the scope resolver does, then query directly.
      const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
      const deptIds = scope.visibleDepartments.map((d) => d._id);
      const { payments } = await getOrgCollections();
      list = deptIds.length ? await payments.find({ orgId: toObjectId(orgId), departmentId: { $in: deptIds }, deletedAt: null }).sort({ createdAt: -1 }).toArray() : [];
    }
    if (direction && DIRECTIONS.includes(direction)) list = list.filter((p) => p.direction === direction);

    return NextResponse.json({ payments: list.map(serializePayment) });
  } catch (err) {
    console.error("orgs/finance/payments GET failed:", err);
    return NextResponse.json({ error: "Could not fetch payments." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { orgId, departmentId, direction, amount, method, paymentDate, relatedInvoiceId, relatedExpenseId } = await req.json();
    if (!orgId || !departmentId || !DIRECTIONS.includes(direction)) {
      return NextResponse.json({ error: "orgId, departmentId, and a valid direction (INCOMING|OUTGOING) are required." }, { status: 400 });
    }
    if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: "amount must be a positive number." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessDepartment(auth.membership, departmentId) || !canAccessFinance(auth.membership)) {
      return NextResponse.json({ error: "You don't have permission to do that." }, { status: 403 });
    }

    const { departments, invoices, expenses, payments } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const departmentObjectId = toObjectId(departmentId);
    const department = await departments.findOne({ _id: departmentObjectId, orgId: orgObjectId });
    if (!department) return NextResponse.json({ error: "Department not found." }, { status: 404 });

    let relatedInvoiceObjectId = null;
    if (relatedInvoiceId) {
      const invoice = await invoices.findOne({ _id: toObjectId(relatedInvoiceId), orgId: orgObjectId });
      if (!invoice) return NextResponse.json({ error: "Related invoice not found." }, { status: 404 });
      relatedInvoiceObjectId = invoice._id;
    }
    let relatedExpenseObjectId = null;
    if (relatedExpenseId) {
      const expense = await expenses.findOne({ _id: toObjectId(relatedExpenseId), orgId: orgObjectId });
      if (!expense) return NextResponse.json({ error: "Related expense not found." }, { status: 404 });
      relatedExpenseObjectId = expense._id;
    }

    const now = new Date().toISOString();
    const result = await payments.insertOne({
      orgId: orgObjectId, departmentId: departmentObjectId, direction, relatedInvoiceId: relatedInvoiceObjectId,
      relatedExpenseId: relatedExpenseObjectId, amount, currency: "USD", method: method ? String(method).trim() : null,
      paymentDate: paymentDate || now, status: "RECORDED", createdByEmail: auth.session.email, createdAt: now, deletedAt: null,
    });

    await logOrgActivity({
      orgId: orgObjectId, recordType: "PAYMENT", recordId: result.insertedId, actorEmail: auth.session.email,
      action: "PAYMENT_RECORDED", previousState: null, newState: "RECORDED", metadata: { direction, amount },
    });

    return NextResponse.json(serializePayment({
      _id: result.insertedId, orgId: orgObjectId, departmentId: departmentObjectId, direction,
      relatedInvoiceId: relatedInvoiceObjectId, relatedExpenseId: relatedExpenseObjectId, amount, currency: "USD",
      method, paymentDate: paymentDate || now, status: "RECORDED", createdByEmail: auth.session.email, createdAt: now,
    }));
  } catch (err) {
    console.error("orgs/finance/payments POST failed:", err);
    return NextResponse.json({ error: "Could not record the payment." }, { status: 500 });
  }
}
