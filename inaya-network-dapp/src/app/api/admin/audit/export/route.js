// app/api/admin/audit/export/route.js
//
// GET /api/admin/audit/export?orgId=&format=json|csv — admin-only. Exports
// the FULL chain (every field needed to independently recompute and
// verify it: seq, prevHash, entryHash, and every field that goes into the
// hash) so a third party doesn't have to trust Inaya's own "Verified"
// banner — they can walk the export and recompute sha256(prevHash +
// canonicalFields) themselves. This is the literal "export verifiable
// cryptographic records for compliance" SOW deliverable.

import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../../lib/admin-auth.js";
import { ensureOrgIndexes, getOrgCollections, toObjectId } from "../../../../../lib/orgs.js";

export const dynamic = "force-dynamic";

function toCsvValue(v) {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

export async function GET(req) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const orgId = req.nextUrl.searchParams.get("orgId");
  const format = req.nextUrl.searchParams.get("format") === "csv" ? "csv" : "json";
  if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

  try {
    await ensureOrgIndexes();
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
    console.error("admin/audit/export GET failed:", err);
    return NextResponse.json({ error: "Could not export audit chain." }, { status: 500 });
  }
}
