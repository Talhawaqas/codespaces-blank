// POST /api/orgs/doc-intelligence/analyze?orgId=&analyzerId=&departmentId=  (multipart/form-data, field "file")
// Runs an analyzer against one uploaded document. Any active member may submit a document for analysis
// (unlike analyzer registry management, which is owner/admin only) -- same split bookkeeper uses between
// "who can submit a document" and "who can manage the pipeline that processes it".
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { checkRateLimit } from "../../../../../lib/rateLimit.js";
import { analyzeDocument } from "../../../../../lib/docIntelligence/analyze.js";
import { MAX_DOC_BYTES } from "../../../../../lib/docIntelligence/common.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req) {
  try {
    const url = new URL(req.url);
    const orgId = url.searchParams.get("orgId"); const analyzerId = url.searchParams.get("analyzerId"); const departmentId = url.searchParams.get("departmentId") || null;
    if (!orgId || !analyzerId) return NextResponse.json({ error: "orgId and analyzerId are required." }, { status: 400 });
    if (Number(req.headers.get("content-length") || 0) > MAX_DOC_BYTES + 4096) return NextResponse.json({ error: "The file is too large." }, { status: 413 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    try { await checkRateLimit({ action: "doc-intelligence:analyze", key: auth.session.email, max: 30, windowMs: 15 * 60 * 1000 }); } catch { return NextResponse.json({ error: "Too many submissions. Please wait a moment." }, { status: 429 }); }
    const form = await req.formData();
    const f = form.get("file");
    if (!f || typeof f === "string" || typeof f.arrayBuffer !== "function") return NextResponse.json({ error: "A file is required." }, { status: 400 });
    if (f.size > MAX_DOC_BYTES) return NextResponse.json({ error: `Files can be at most ${MAX_DOC_BYTES / 1024 / 1024} MB.` }, { status: 413 });
    const r = await analyzeDocument({ orgId, departmentId, analyzerId, filename: f.name, contentType: f.type || "application/octet-stream", buffer: Buffer.from(await f.arrayBuffer()), actor: auth.session.email });
    if (r.error) return NextResponse.json({ error: r.error, reasonCode: r.reasonCode }, { status: r.status || 400 });
    return NextResponse.json(r);
  } catch (err) { console.error("doc-intelligence analyze failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}
