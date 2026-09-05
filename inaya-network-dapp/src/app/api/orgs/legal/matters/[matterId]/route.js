// app/api/orgs/legal/matters/[matterId]/route.js
//
// GET /api/orgs/legal/matters/:matterId?orgId=...
//   -> the matter workspace: the matter record plus its team, deadlines,
//      and evidence -- SOW section 11.5's workspace sections. Same
//      "not in caller's visible scope -> 404" pattern as the patient
//      route, for the same reason (never confirm a matter exists to
//      someone not on its team).

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { getAccessibleScope } from "../../../../../../lib/document-permissions.js";
import { getMatterWorkspace } from "../../../../../../lib/legal-matter-workflow.js";
import { listDeadlinesForMatter } from "../../../../../../lib/legal-calendar.js";
import { listEvidenceForMatter } from "../../../../../../lib/legal-evidence.js";

export async function GET(req, { params }) {
  try {
    const { matterId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
    const matter = scope.visibleMatters.find((m) => m._id.toString() === matterId);
    if (!matter) return NextResponse.json({ error: "Matter not found." }, { status: 404 });

    const [workspace, deadlines, evidence] = await Promise.all([
      getMatterWorkspace(orgId, matterId),
      listDeadlinesForMatter(orgId, matterId),
      listEvidenceForMatter(orgId, matterId),
    ]);

    return NextResponse.json({
      matter: {
        id: matter._id.toString(), name: matter.name, type: matter.type, status: matter.status,
        jurisdiction: matter.jurisdiction, court: matter.court, opposingParties: matter.opposingParties,
        responsiblePartnerEmail: matter.responsiblePartnerEmail, priority: matter.priority,
      },
      team: (workspace?.team || []).map((t) => ({ email: t.email, role: t.role })),
      deadlines: deadlines.map((d) => ({ id: d._id.toString(), description: d.description, dueAt: d.dueAt, manualConfirmation: d.manualConfirmation, confidence: d.confidence })),
      evidence: evidence.map((e) => ({ id: e._id.toString(), source: e.source, custodian: e.custodian, description: e.description })),
    });
  } catch (err) {
    console.error("orgs/legal/matters/[matterId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch matter workspace." }, { status: 500 });
  }
}
