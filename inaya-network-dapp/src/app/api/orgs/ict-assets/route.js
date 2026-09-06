// app/api/orgs/ict-assets/route.js
// GET   ?orgId=&type=&criticality=&environment= -> list ICT assets
// POST  { orgId, name, type, ... } -> register an asset
// PATCH { orgId, assetId, updates } -> update criticality/environment/location/classification/dependencies

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { createIctAsset, updateIctAsset, listIctAssets } from "../../../../lib/ict-asset-inventory.js";

function serialize(a) {
  return { id: a._id.toString(), name: a.name, type: a.type, criticality: a.criticality, environment: a.environment, location: a.location, dataClassification: a.dataClassification, ownerEmail: a.ownerEmail, dependencies: a.dependencies.map((id) => id.toString()) };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const assets = await listIctAssets(orgId, { type: searchParams.get("type") || undefined, criticality: searchParams.get("criticality") || undefined, environment: searchParams.get("environment") || undefined });
    return NextResponse.json({ assets: assets.map(serialize) });
  } catch (err) {
    console.error("orgs/ict-assets GET failed:", err);
    return NextResponse.json({ error: "Could not fetch ICT assets." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, name, type } = body;
    if (!orgId || !name || !type) return NextResponse.json({ error: "orgId, name, and type are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await createIctAsset({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ asset: serialize(result.asset) });
  } catch (err) {
    console.error("orgs/ict-assets POST failed:", err);
    return NextResponse.json({ error: "Could not register ICT asset." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, assetId, updates } = await req.json();
    if (!orgId || !assetId) return NextResponse.json({ error: "orgId and assetId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await updateIctAsset({ orgId, assetId, updates: updates || {}, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ asset: serialize(result.asset) });
  } catch (err) {
    console.error("orgs/ict-assets PATCH failed:", err);
    return NextResponse.json({ error: "Could not update ICT asset." }, { status: 500 });
  }
}
