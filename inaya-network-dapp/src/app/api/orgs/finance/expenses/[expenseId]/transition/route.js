// app/api/orgs/finance/expenses/[expenseId]/transition/route.js
//
// POST /api/orgs/finance/expenses/:expenseId/transition
// Body: { orgId, action, note? } — action is one of: submit, approve, reject, cancel

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { transitionExpense } from "../../../../../../../lib/expense-workflow.js";

export async function POST(req, { params }) {
  try {
    const { expenseId } = params;
    const { orgId, action, note } = await req.json();
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await transitionExpense({ orgId, expenseId, action, membership: auth.membership, actorEmail: auth.session.email, note });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json({ status: result.expense.status, updatedAt: result.expense.updatedAt });
  } catch (err) {
    console.error("orgs/finance/expenses/[expenseId]/transition failed:", err);
    return NextResponse.json({ error: "Could not update the expense's status." }, { status: 500 });
  }
}
