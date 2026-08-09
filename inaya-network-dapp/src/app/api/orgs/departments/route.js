// app/api/orgs/departments/route.js
//
// GET  /api/orgs/departments?orgId=...            -> departments the caller can see
// POST /api/orgs/departments  { orgId, name }      -> create (owner/admin only)
//
// Any active member can list departments (they need to see the org's
// structure to navigate it — visibility of the department itself isn't
// sensitive, only the documents inside it are, which is enforced
// separately per-document). Only owner/admin can create one.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, toObjectId } from "../../../../lib/orgs.js";

export async function GET(req) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { departments } = await getOrgCollections();
    const list = await departments.find({ orgId: toObjectId(orgId) }).sort({ name: 1 }).toArray();

    return NextResponse.json({
      departments: list.map((d) => ({ id: d._id.toString(), name: d.name, createdAt: d.createdAt })),
    });
  } catch (err) {
    console.error("orgs/departments GET failed:", err);
    return NextResponse.json({ error: "Could not fetch departments." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { orgId, name: rawName } = await req.json();
    const name = String(rawName || "").trim();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    if (!name) return NextResponse.json({ error: "Department name is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { departments } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);

    const existing = await departments.findOne({ orgId: orgObjectId, name });
    if (existing) return NextResponse.json({ error: "A department with that name already exists." }, { status: 409 });

    const now = new Date().toISOString();
    const result = await departments.insertOne({ orgId: orgObjectId, name, createdAt: now, createdByEmail: auth.session.email });

    return NextResponse.json({ id: result.insertedId.toString(), name, createdAt: now });
  } catch (err) {
    console.error("orgs/departments POST failed:", err);
    return NextResponse.json({ error: "Could not create the department." }, { status: 500 });
  }
}
