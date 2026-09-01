// app/api/orgs/audit/export/route.js
//
// GET /api/orgs/audit/export?orgId=&format=json|csv — org-scoped
// self-service equivalent of /api/admin/audit/export: owner/admin only
// (canManageOrg). Exports the FULL chain (every field needed to
// independently recompute and verify it: seq, prevHash, entryHash, and
// every field that goes into the hash) so a business customer doesn't
// have to trust Inaya's own "Verified" banner — they can walk the export
// and recompute sha256(prevHash + canonicalFields) themselves. Same
// export shape as the admin route, just gated by org membership instead
// of internal admin auth.

import { NextResponse } from "next/server";
import { requireMembership, canManageOrg, ensureOrgIndexes, getOrgCollections, toObjectId } from "../../../../../lib/orgs.js";

export const dynamic = "force-dynamic";

function toCsvValue(v) {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const format = searchParams.get("format") === "csv" ? "csv" : "json";
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canManageOrg(auth.membership)) {
      return NextResponse.json({ error: "Only the owner or an admin can export the audit trail." }, { status: 403 });
    }

    const { auditChainEntries } = await getOrgCollections();
    const entries = await auditChainEntries.find({ orgId: toObjectId(orgId) }).sort({ seq: 1 }).toArray();

    const rows = entries.map((e) => ({
      seq: e.seq, prevHash: e.prevHash, entryHash: e.entryHash,
      recordType: e.recordType, recordId: e.recordId?.toString() || "", actorEmail: e.actorEmail || "",
      action: e.action, previousState: e.previousState, newState: e.newState,
      timestamp: e.timestamp, metadata: e.metadata,
    }));

    if (format === "csv") {
      const headers = ["seq", "prevHash", "entryHash", "recordType", "recordId", "actorEmail", "action", "previousState", "newState", "timestamp", "metadata"];
      const lines = [headers.join(",")];
      for (const row of rows) lines.push(headers.map((h) => toCsvValue(row[h])).join(","));
      return new NextResponse(lines.join("\n"), {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="audit-chain-${orgId}.csv"`,
        },
      });
    }

    return NextResponse.json({ orgId, count: rows.length, entries: rows });
  } catch (err) {
    console.error("orgs/audit/export GET failed:", err);
    return NextResponse.json({ error: "Could not export the audit trail." }, { status: 500 });
  }
}
