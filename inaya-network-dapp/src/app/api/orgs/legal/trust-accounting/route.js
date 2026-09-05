// app/api/orgs/legal/trust-accounting/route.js
// GET  ?orgId=&matterId= -> transaction history + current balance
// POST { orgId, matterId, type:"deposit"|"withdrawal", amount, ... } -> record a transaction

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { recordDeposit, recordWithdrawal, getMatterTrustBalance, listTransactionHistory } from "../../../../../lib/trust-accounting.js";

function serialize(e) {
  return { id: e._id.toString(), type: e.type, amount: e.amount, source: e.source, reconciled: e.reconciled, createdAt: e.createdAt };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const matterId = searchParams.get("matterId");
    if (!orgId || !matterId) return NextResponse.json({ error: "orgId and matterId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "legal");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const [history, balance] = await Promise.all([listTransactionHistory(orgId, matterId), getMatterTrustBalance(orgId, matterId)]);
    return NextResponse.json({ transactions: history.map(serialize), balance });
  } catch (err) {
    console.error("orgs/legal/trust-accounting GET failed:", err);
    return NextResponse.json({ error: "Could not fetch trust accounting history." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, matterId, type, amount } = body;
    if (!orgId || !matterId || !type || !amount) return NextResponse.json({ error: "orgId, matterId, type, and amount are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "legal");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = type === "deposit"
      ? await recordDeposit({ orgId, matterId, amount, source: body.source, actorEmail: auth.session.email, membership: auth.membership })
      : await recordWithdrawal({ orgId, matterId, amount, purpose: body.purpose, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ entry: serialize(result.entry) });
  } catch (err) {
    console.error("orgs/legal/trust-accounting POST failed:", err);
    return NextResponse.json({ error: "Could not record trust transaction." }, { status: 500 });
  }
}
