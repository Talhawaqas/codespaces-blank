// app/api/orgs/export-zip/route.js
//
// GET /api/orgs/export-zip?orgId=...  -> a ZIP of all the company's records (src/lib/orgDataExport.js).
// Owner/admin only. Streamed so large companies are not cut off by the response size limit.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { buildOrgDataExport } from "../../../../lib/orgDataExport.js";
import { logOrgActivity } from "../../../../lib/org-activity-log.js";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { buffer, filename, collections, records } = await buildOrgDataExport(orgId);
    await logOrgActivity({ orgId, recordType: "ORGANIZATION", recordId: orgId, actorEmail: auth.session.email, action: "DATA_EXPORTED", previousState: null, newState: null, metadata: { collections, records, bytes: buffer.length } }).catch(() => {});

    const CHUNK = 256 * 1024;
    let offset = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (offset >= buffer.length) { controller.close(); return; }
        controller.enqueue(new Uint8Array(buffer.subarray(offset, offset + CHUNK)));
        offset += CHUNK;
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("orgs/export-zip failed:", err);
    return NextResponse.json({ error: "Could not prepare the export. Please try again." }, { status: 500 });
  }
}
