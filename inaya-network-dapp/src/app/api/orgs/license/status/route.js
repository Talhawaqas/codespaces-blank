// app/api/orgs/license/status/route.js
//
// GET /api/orgs/license/status?orgId=  -> the company's license state for the sign-in banner (any member).
// Owners/Admins get the deadline and remaining time; other members get only a neutral notice (SOW 7.2): no amounts,
// payment details or internal notes. Open even when the license is restricted (see licensing/gate.js).
import { NextResponse } from "next/server";
import { canManageOrg, ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { getLicense, publicLicenseView } from "../../../../../lib/licensing/service.js";
import { STATE_LABELS } from "../../../../../lib/licensing/state.js";
import { formatDeadline, remaining } from "../../../../../lib/licensing/dates.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const now = new Date();
    const v = publicLicenseView(await getLicense(orgId), now);
    if (!v) return NextResponse.json({ license: null });
    const manager = canManageOrg(auth.membership);
    const base = { state: v.state, label: STATE_LABELS[v.state] || v.state, access: v.access, isManager: manager };
    if (!manager) return NextResponse.json({ license: base });
    const deadline = v.state === "grace_period" ? v.graceEndsAt : v.state === "active" ? v.paymentDueAt : v.deadline;
    return NextResponse.json({ license: { ...base, deadline, deadlineText: deadline ? formatDeadline(deadline) : null, remaining: deadline ? remaining(deadline, now).label : null, remainingMs: deadline ? remaining(deadline, now).ms : null, cancelling: v.cancelling } });
  } catch (err) {
    console.error("orgs/license/status failed:", err?.message);
    return NextResponse.json({ error: "Could not read the license." }, { status: 500 });
  }
}
