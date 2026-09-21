// app/api/orgs/storage/resources/route.js
// GET ?orgId=&type=&tag.<key>=<value> -> list; POST -> create

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { createStorageResource, listStorageResources } from "../../../../../lib/storageResources.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const type = searchParams.get("type") || undefined;
    const tagSelector = {};
    for (const [key, value] of searchParams.entries()) {
      if (key.startsWith("tag.")) tagSelector[key.slice(4)] = value;
    }

    const result = await listStorageResources({ orgId, type, tagSelector: Object.keys(tagSelector).length ? tagSelector : undefined, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/storage/resources GET failed:", err);
    return NextResponse.json({ error: "Could not list storage resources." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const { orgId, type, name, region, capacity, performanceProfile, tags } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await createStorageResource({ orgId, type, name, region, capacity, performanceProfile, tags, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ resource: { ...result.resource, _id: result.resource._id.toString() } });
  } catch (err) {
    console.error("orgs/storage/resources POST failed:", err);
    return NextResponse.json({ error: "Could not create storage resource." }, { status: 500 });
  }
}
