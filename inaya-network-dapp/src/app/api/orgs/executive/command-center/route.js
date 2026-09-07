// app/api/orgs/executive/command-center/route.js
// GET ?orgId= -> the executive command center aggregate (trust health, risk, compliance, board reporting, approvals)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { getExecutiveCommandCenter } from "../../../../../lib/executive-command-center.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await getExecutiveCommandCenter(orgId);
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/executive/command-center GET failed:", err);
    return NextResponse.json({ error: "Could not compute the executive command center." }, { status: 500 });
  }
}
