// app/api/orgs/license/documents/route.js
// GET ?orgId=  -> Owner/Admin: every Documents-module file of the company (name, place, size), so it can be
// downloaded read-only while the license is restricted (founder decision 11). The files themselves come from the
// existing /api/orgs/documents/[id]/retrieve route (also open while restricted) and are decrypted in the browser
// with the company passkey -- the server never sees the readable file.
import { NextResponse } from "next/server";
import { ensureOrgIndexes, getOrgCollections, requireMembership, toObjectId } from "../../../../../lib/orgs.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const { orgDocuments, departments, projects } = await getOrgCollections();
    const oid = toObjectId(orgId);
    const [docs, depts, projs] = await Promise.all([
      orgDocuments.find({ orgId: oid, deletedAt: null, encryptionMode: { $ne: "server-managed" }, cidAlpha: { $exists: true } }, { projection: { filename: 1, sizeBytes: 1, departmentId: 1, projectId: 1, createdAt: 1 } }).sort({ createdAt: -1 }).limit(5000).toArray(),
      departments.find({ orgId: oid }, { projection: { name: 1 } }).toArray(),
      projects.find({ orgId: oid }, { projection: { name: 1 } }).toArray(),
    ]);
    const dn = new Map(depts.map((d) => [String(d._id), d.name])); const pn = new Map(projs.map((p) => [String(p._id), p.name]));
    return NextResponse.json({ documents: docs.map((d) => ({ id: String(d._id), filename: d.filename, sizeBytes: d.sizeBytes || null, department: dn.get(String(d.departmentId)) || null, project: pn.get(String(d.projectId)) || null, createdAt: d.createdAt || null })) });
  } catch (err) {
    console.error("orgs/license/documents failed:", err?.message);
    return NextResponse.json({ error: "Could not list documents." }, { status: 500 });
  }
}
