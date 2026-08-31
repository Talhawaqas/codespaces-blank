// app/api/admin/audit/route.js
//
// GET /api/admin/audit?orgId= — admin-only. Returns the latest chain
// entries for one org's audit chain plus a fresh verifyChainIntegrity()
// result, backing the /admin/audit chain browser + integrity banner.

import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../lib/admin-auth.js";
import { ensureOrgIndexes } from "../../../../lib/orgs.js";
import { listAuditChain, verifyChainIntegrity } from "../../../../lib/auditChain.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const orgId = req.nextUrl.searchParams.get("orgId");
  if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

  try {
    await ensureOrgIndexes();
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
    console.error("admin/audit GET failed:", err);
    return NextResponse.json({ error: "Could not load audit chain." }, { status: 500 });
  }
}
