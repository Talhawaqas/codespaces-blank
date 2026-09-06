// app/api/orgs/regulated/findings/route.js
// GET  ?orgId=&status=&controlId=&source= -> list findings

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessCompliance, canAccessAudit } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { listFindings } from "../../../../../lib/control-testing.js";

function serialize(f) {
  return {
    id: f._id.toString(), controlId: f.controlId?.toString() || null, severity: f.severity,
    description: f.description, source: f.source, status: f.status, ownerEmail: f.ownerEmail,
    compensatingControl: f.compensatingControl, createdAt: f.createdAt, closedAt: f.closedAt,
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "regulated");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });
    if (!canAccessCompliance(auth.membership) && !canAccessAudit(auth.membership)) {
      return NextResponse.json({ error: "You don't have compliance or audit access." }, { status: 403 });
    }

    const findings = await listFindings(orgId, {
      status: searchParams.get("status") || undefined,
      controlId: searchParams.get("controlId") || undefined,
      source: searchParams.get("source") || undefined,
    });
    return NextResponse.json({ findings: findings.map(serialize) });
  } catch (err) {
    console.error("orgs/regulated/findings GET failed:", err);
    return NextResponse.json({ error: "Could not fetch findings." }, { status: 500 });
  }
}
