// app/api/orgs/exports/[exportId]/download/route.js
// GET ?orgId=  -> the ready export ZIP, for the same company's Owner/Admin only. No public or permanent URL exists:
// the ZIP is decrypted from storage on each authenticated request and the download is recorded (SOW 12.4).
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { ExportError, readExportForDownload } from "../../../../../../lib/licensing/exports.js";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req, { params }) {
  try {
    const { exportId } = await params;
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { buffer, filename } = await readExportForDownload({ orgId, exportId, email: auth.session.email });
    const CHUNK = 256 * 1024; let offset = 0;
    const stream = new ReadableStream({ pull(c) { if (offset >= buffer.length) { c.close(); return; } c.enqueue(new Uint8Array(buffer.subarray(offset, offset + CHUNK))); offset += CHUNK; } });
    return new Response(stream, { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`, "Content-Length": String(buffer.length), "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof ExportError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    console.error("orgs/exports download failed:", err?.message);
    return NextResponse.json({ error: "Could not download the export. Please try again." }, { status: 500 });
  }
}
