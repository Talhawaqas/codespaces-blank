// GET  /api/orgs/ml-studio/catalog?orgId=&type=          -- list catalog entries
// POST /api/orgs/ml-studio/catalog  { orgId, name, description?, type, ref, tags? }  -- owner/admin only
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { listCatalog, registerCatalogEntry } from "../../../../../lib/mlStudio/catalog.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const url = new URL(req.url); const orgId = url.searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const r = await listCatalog({ orgId, type: url.searchParams.get("type") || null });
    return NextResponse.json(r);
  } catch (err) { console.error("ml-studio catalog list failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}

export async function POST(req) {
  try {
    const body = await req.json(); const { orgId, name, description, type, ref, tags } = body || {};
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true }); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const r = await registerCatalogEntry({ orgId, membership: auth.membership, actorEmail: auth.session.email, name, description, type, ref, tags });
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.status || 400 });
    return NextResponse.json(r);
  } catch (err) { console.error("ml-studio catalog register failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}
