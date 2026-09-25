// app/api/documents-automation/verify/route.js -- PUBLIC document verification (SOW §20)
//
// GET  /api/documents-automation/verify?id=<documentId>&hash=<sha256>
// POST /api/documents-automation/verify?id=<documentId>     body: the PDF bytes
//
// Anyone holding a document (a recipient, an auditor) can check that a file
// is byte-identical to the finalized document Inaya recorded. The answer is
// limited to what §20 allows -- id, type, version, status, finalized time,
// hash, approval and evidence status -- never source records, amounts,
// customers or internal identifiers. An unknown id answers found:false (not
// an error) so ids cannot be probed. Rate limited per IP.
import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../lib/orgs.js";
import { verifyPublic } from "../../../../lib/documentAutomation/verify.js";
import { limited, readPdf } from "../../orgs/documents-automation/_lib.js";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req) {
  try {
    const rl = await limited(req, { action: "verify-public", max: 40 });
    if (rl) return rl;
    await ensureOrgIndexes();
    const sp = new URL(req.url).searchParams;
    const id = (sp.get("id") || "").slice(0, 40) || undefined;
    const hash = (sp.get("hash") || "").slice(0, 80) || undefined;
    if (!id && !hash) return NextResponse.json({ error: "Provide an id or a hash." }, { status: 400 });
    return NextResponse.json(await verifyPublic({ documentId: id, hash }), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("documents-automation/verify GET failed:", err);
    return NextResponse.json({ error: "Could not verify." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const rl = await limited(req, { action: "verify-public", max: 40 });
    if (rl) return rl;
    await ensureOrgIndexes();
    const id = (new URL(req.url).searchParams.get("id") || "").slice(0, 40) || undefined;
    const p = await readPdf(req);
    if (p.error) return NextResponse.json({ error: p.error }, { status: p.status });
    return NextResponse.json(await verifyPublic({ documentId: id, bytes: p.bytes }), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("documents-automation/verify POST failed:", err);
    return NextResponse.json({ error: "Could not verify." }, { status: 500 });
  }
}
