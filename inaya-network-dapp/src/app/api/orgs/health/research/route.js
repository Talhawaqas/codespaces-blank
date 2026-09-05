// app/api/orgs/health/research/route.js
// GET  ?orgId=&name= -> list dataset versions
// POST { orgId, name, sourcePatientIds, methodologyNotes, ... } -> create dataset (v1)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { createResearchDataset, listDatasetVersions } from "../../../../../lib/health-research.js";

function serialize(d) {
  return { id: d._id.toString(), name: d.name, version: d.version, deidentificationMethodology: d.deidentificationMethodology, sourceRecordCount: d.sourceRecordCount, createdAt: d.createdAt };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const name = searchParams.get("name");
    if (!orgId || !name) return NextResponse.json({ error: "orgId and name are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "healthcare");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const versions = await listDatasetVersions(orgId, name);
    return NextResponse.json({ versions: versions.map(serialize) });
  } catch (err) {
    console.error("orgs/health/research GET failed:", err);
    return NextResponse.json({ error: "Could not fetch dataset versions." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    if (!body.orgId || !body.name || !body.methodologyNotes) return NextResponse.json({ error: "orgId, name, and methodologyNotes are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, body.orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(body.orgId, "healthcare");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createResearchDataset({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ dataset: serialize(result.dataset) });
  } catch (err) {
    console.error("orgs/health/research POST failed:", err);
    return NextResponse.json({ error: "Could not create research dataset." }, { status: 500 });
  }
}
