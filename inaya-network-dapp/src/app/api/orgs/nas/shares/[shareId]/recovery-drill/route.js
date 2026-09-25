// app/api/orgs/nas/shares/[shareId]/recovery-drill/route.js
// POST { orgId, relativePath } -> real restore-and-verify drill (SOW Workstream X)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { runRecoveryDrill } from "../../../../../../../lib/nas/backup.js";

export async function POST(req, { params }) {
  try {
    const { shareId } = await params;
    const body = await req.json().catch(() => ({}));
    const { orgId, relativePath } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    if (!relativePath) return NextResponse.json({ error: "relativePath is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await runRecoveryDrill({ orgId, shareId, relativePath, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/nas/shares/[shareId]/recovery-drill POST failed:", err);
    return NextResponse.json({ error: "Recovery drill failed." }, { status: 500 });
  }
}
