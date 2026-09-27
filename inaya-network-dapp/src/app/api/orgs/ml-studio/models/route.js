// GET  /api/orgs/ml-studio/models?orgId=&modelName=&status=
// POST /api/orgs/ml-studio/models?orgId=  (multipart/form-data: file, modelName, version, framework?, description?, datasetCatalogIds? JSON array)
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { listModels, registerModel } from "../../../../../lib/mlStudio/models.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const MAX = 200 * 1024 * 1024 + 4096;

export async function GET(req) {
  try {
    const url = new URL(req.url); const orgId = url.searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const r = await listModels({ orgId, modelName: url.searchParams.get("modelName") || null, status: url.searchParams.get("status") || null });
    return NextResponse.json(r);
  } catch (err) { console.error("ml-studio models list failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}

export async function POST(req) {
  try {
    const url = new URL(req.url); const orgId = url.searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    if (Number(req.headers.get("content-length") || 0) > MAX) return NextResponse.json({ error: "The artifact is too large." }, { status: 413 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true }); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const form = await req.formData();
    const f = form.get("file");
    if (!f || typeof f === "string" || typeof f.arrayBuffer !== "function") return NextResponse.json({ error: "An artifact file is required." }, { status: 400 });
    let datasetCatalogIds = [];
    try { const raw = form.get("datasetCatalogIds"); if (raw) datasetCatalogIds = JSON.parse(raw); } catch { /* ignore malformed, treated as none */ }
    const r = await registerModel({ orgId, membership: auth.membership, actorEmail: auth.session.email, modelName: form.get("modelName"), version: form.get("version"), framework: form.get("framework") || null, description: form.get("description") || "", datasetCatalogIds, artifactBuffer: Buffer.from(await f.arrayBuffer()), artifactFilename: f.name, artifactContentType: f.type || "application/octet-stream" });
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.status || 400 });
    return NextResponse.json(r);
  } catch (err) { console.error("ml-studio model register failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}
