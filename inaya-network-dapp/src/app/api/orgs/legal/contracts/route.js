// app/api/orgs/legal/contracts/route.js
// GET   ?orgId=&matterId= -> list contracts for a matter
// POST  { orgId, matterId, name, ... } -> create a contract
// PATCH { orgId, contractId, action } -> transition (startDrafting/submitForReview/approve/sendForNegotiation/sign)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { createContract, transitionContract, listContractsForMatter } from "../../../../../lib/contract-lifecycle-workflow.js";

function serialize(c) {
  return { id: c._id.toString(), name: c.name, counterparty: c.counterparty, status: c.status, expirationDate: c.expirationDate };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const matterId = searchParams.get("matterId");
    if (!orgId || !matterId) return NextResponse.json({ error: "orgId and matterId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "legal");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const contracts = await listContractsForMatter(orgId, matterId);
    return NextResponse.json({ contracts: contracts.map(serialize) });
  } catch (err) {
    console.error("orgs/legal/contracts GET failed:", err);
    return NextResponse.json({ error: "Could not fetch contracts." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    if (!body.orgId || !body.name) return NextResponse.json({ error: "orgId and name are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, body.orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(body.orgId, "legal");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createContract({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ contract: serialize(result.contract) });
  } catch (err) {
    console.error("orgs/legal/contracts POST failed:", err);
    return NextResponse.json({ error: "Could not create contract." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, contractId, action } = await req.json();
    if (!orgId || !contractId || !action) return NextResponse.json({ error: "orgId, contractId, and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "legal");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await transitionContract({ orgId, contractId, action, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ contract: serialize(result.contract) });
  } catch (err) {
    console.error("orgs/legal/contracts PATCH failed:", err);
    return NextResponse.json({ error: "Could not update contract." }, { status: 500 });
  }
}
