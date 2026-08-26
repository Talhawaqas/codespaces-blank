// app/api/orgs/finance/expenses/[expenseId]/route.js
//
// GET single expense; PATCH field edits (only while DRAFT); DELETE
// soft-deletes (only while DRAFT).

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, canAccessFinance, toObjectId } from "../../../../../../lib/orgs.js";

function serializeExpense(e) {
  return {
    id: e._id.toString(), orgId: e.orgId.toString(), departmentId: e.departmentId.toString(),
    vendor: e.vendor, category: e.category, amount: e.amount, currency: e.currency, expenseDate: e.expenseDate,
    description: e.description || null, status: e.status, createdByEmail: e.createdByEmail, createdAt: e.createdAt, updatedAt: e.updatedAt,
  };
}

async function loadAuthorized(req, orgId, expenseId) {
  await ensureOrgIndexes();
  const auth = await requireMembership(req, orgId);
  if (auth.error) return { error: auth.error, status: auth.status };
  if (!canAccessFinance(auth.membership)) return { error: "You don't have finance access.", status: 403 };

  const { expenses } = await getOrgCollections();
  const expense = await expenses.findOne({ _id: toObjectId(expenseId), orgId: toObjectId(orgId), deletedAt: null });
  if (!expense) return { error: "Expense not found.", status: 404 };
  if (!canAccessDepartment(auth.membership, expense.departmentId)) return { error: "Expense not found.", status: 404 };

  return { auth, expense, expenses };
}

export async function GET(req, { params }) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    const result = await loadAuthorized(req, orgId, params.expenseId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(serializeExpense(result.expense));
  } catch (err) {
    console.error("orgs/finance/expenses/[expenseId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch the expense." }, { status: 500 });
  }
}

export async function PATCH(req, { params }) {
  try {
    const { orgId, vendor, category, amount, description } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    const result = await loadAuthorized(req, orgId, params.expenseId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    const { expenses, expense } = result;
    if (expense.status !== "DRAFT") return NextResponse.json({ error: "Only a DRAFT expense can be edited." }, { status: 409 });

    const updateFields = { updatedAt: new Date().toISOString() };
    if (vendor !== undefined) updateFields.vendor = String(vendor).trim();
    if (category !== undefined) updateFields.category = String(category).trim();
    if (description !== undefined) updateFields.description = description ? String(description).trim() : null;
    if (amount !== undefined) {
      if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: "amount must be a positive number." }, { status: 400 });
      updateFields.amount = amount;
    }

    await expenses.updateOne({ _id: expense._id }, { $set: updateFields });
    const updated = await expenses.findOne({ _id: expense._id });
    return NextResponse.json(serializeExpense(updated));
  } catch (err) {
    console.error("orgs/finance/expenses/[expenseId] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update the expense." }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    const result = await loadAuthorized(req, orgId, params.expenseId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    if (result.expense.status !== "DRAFT") return NextResponse.json({ error: "Only a DRAFT expense can be deleted — cancel it instead once submitted." }, { status: 409 });
    await result.expenses.updateOne({ _id: result.expense._id }, { $set: { deletedAt: new Date().toISOString() } });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    console.error("orgs/finance/expenses/[expenseId] DELETE failed:", err);
    return NextResponse.json({ error: "Could not delete the expense." }, { status: 500 });
  }
}
