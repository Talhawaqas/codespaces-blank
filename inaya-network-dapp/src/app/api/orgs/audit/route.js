// app/api/orgs/audit/route.js
//
// GET /api/orgs/audit?orgId= — org-scoped self-service equivalent of
// /api/admin/audit: owner/admin only (canManageOrg), not every member —
// the chain spans every record type across every department (documents,
// deals, invoices, employees, ...), compliance-sensitive breadth beyond
// what a single department member should see by default, same reasoning
// document-permissions.js already applies to cross-department data.
// Reuses the exact same verified chain logic as the admin route — no
// separate implementation to keep in sync.

import { NextResponse } from "next/server";
import { requireMembership, canManageOrg, ensureOrgIndexes } from "../../../../lib/orgs.js";
import { listAuditChain, verifyChainIntegrity } from "../../../../lib/auditChain.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canManageOrg(auth.membership)) {
      return NextResponse.json({ error: "Only the owner or an admin can view the audit trail." }, { status: 403 });
    }

    const [entries, integrity] = await Promise.all([
      listAuditChain(orgId, { limit: 200 }),
      verifyChainIntegrity(orgId),
    ]);
    return NextResponse.json({
      integrity,
      entries: entries.map((e) => ({
        seq: e.seq, eventId: e.eventId, entryHash: e.entryHash, prevHash: e.prevHash,
        recordType: e.recordType, recordId: e.recordId, actorEmail: e.actorEmail,
        action: e.action, previousState: e.previousState, newState: e.newState, timestamp: e.timestamp,
      })),
    });
  } catch (err) {
    console.error("orgs/audit GET failed:", err);
    return NextResponse.json({ error: "Could not load the audit trail." }, { status: 500 });
  }
}
