// app/api/orgs/finance/expenses/route.js
//
// GET  /api/orgs/finance/expenses?orgId=...&departmentId=...&status=...
// POST /api/orgs/finance/expenses  { orgId, departmentId, vendor, category, amount, expenseDate?, description? }
//   -> create at status DRAFT.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, canAccessFinance, toObjectId } from "../../../../../lib/orgs.js";
import { getAccessibleScope } from "../../../../../lib/document-permissions.js";
import { EXPENSE_STATES } from "../../../../../lib/expense-workflow.js";

function serializeExpense(e) {
  return {
    id: e._id.toString(), orgId: e.orgId.toString(), departmentId: e.departmentId.toString(),
    vendor: e.vendor, category: e.category, amount: e.amount, currency: e.currency, expenseDate: e.expenseDate,
    description: e.description || null, status: e.status, createdByEmail: e.createdByEmail, createdAt: e.createdAt, updatedAt: e.updatedAt,
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const departmentId = searchParams.get("departmentId");
    const status = searchParams.get("status");
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
      const { expenses } = await getOrgCollections();
      list = await expenses.find({ orgId: toObjectId(orgId), departmentId: toObjectId(departmentId), deletedAt: null }).sort({ createdAt: -1 }).toArray();
    } else {
      const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
      list = scope.visibleExpenses;
    }
    if (status && EXPENSE_STATES.includes(status)) list = list.filter((e) => e.status === status);

    return NextResponse.json({ expenses: list.map(serializeExpense) });
  } catch (err) {
    console.error("orgs/finance/expenses GET failed:", err);
    return NextResponse.json({ error: "Could not fetch expenses." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { orgId, departmentId, vendor: rawVendor, category: rawCategory, amount, expenseDate, description } = await req.json();
    const vendor = String(rawVendor || "").trim();
    const category = String(rawCategory || "").trim();
    if (!orgId || !departmentId) return NextResponse.json({ error: "orgId and departmentId are required." }, { status: 400 });
    if (!vendor) return NextResponse.json({ error: "Vendor is required." }, { status: 400 });
    if (!category) return NextResponse.json({ error: "Category is required." }, { status: 400 });
    if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: "amount must be a positive number." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessDepartment(auth.membership, departmentId) || !canAccessFinance(auth.membership)) {
      return NextResponse.json({ error: "You don't have permission to do that." }, { status: 403 });
    }

    const { departments, expenses } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const departmentObjectId = toObjectId(departmentId);
    const department = await departments.findOne({ _id: departmentObjectId, orgId: orgObjectId });
    if (!department) return NextResponse.json({ error: "Department not found." }, { status: 404 });

    const now = new Date().toISOString();
    const result = await expenses.insertOne({
      orgId: orgObjectId, departmentId: departmentObjectId, vendor, category, amount, currency: "USD",
      expenseDate: expenseDate || now, description: description ? String(description).trim() : null,
      status: "DRAFT", createdByEmail: auth.session.email, createdAt: now, updatedAt: now, deletedAt: null,
    });

    return NextResponse.json(serializeExpense({
      _id: result.insertedId, orgId: orgObjectId, departmentId: departmentObjectId, vendor, category, amount,
      currency: "USD", expenseDate: expenseDate || now, description, status: "DRAFT",
      createdByEmail: auth.session.email, createdAt: now, updatedAt: now,
    }));
  } catch (err) {
    console.error("orgs/finance/expenses POST failed:", err);
    return NextResponse.json({ error: "Could not create the expense." }, { status: 500 });
  }
}
