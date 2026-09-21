// app/api/public/v1/storage/resources/route.js
//
// Authorization: Bearer <apiKey>. GET ?type=&tag.<key>=<value> -> list;
// POST { type, name, region, capacity, performanceProfile, tags } -> create.
//
// The API-key equivalent of orgs/storage/resources/route.js, built for the
// Terraform provider (terraform-provider-inaya) -- Terraform runs headless
// and has no browser session cookie, so it needs requireApiKey()'s
// bearer-token resolution instead of requireMembership()'s cookie-based
// one. orgId always comes from the key, exactly like every other
// public/v1 route -- a Terraform config can never override which org it
// acts against.

import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../../lib/orgs.js";
import { requireApiKey } from "../../../../../../lib/api-keys.js";
import { createStorageResource, listStorageResources } from "../../../../../../lib/storageResources.js";

export async function GET(req) {
  try {
    await ensureOrgIndexes();
    const auth = await requireApiKey(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { searchParams } = new URL(req.url);
    const type = searchParams.get("type") || undefined;
    const tagSelector = {};
    for (const [key, value] of searchParams.entries()) {
      if (key.startsWith("tag.")) tagSelector[key.slice(4)] = value;
    }

    const result = await listStorageResources({ orgId: auth.orgId, type, tagSelector: Object.keys(tagSelector).length ? tagSelector : undefined, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("public/v1/storage/resources GET failed:", err);
    return NextResponse.json({ error: "Could not list storage resources." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    await ensureOrgIndexes();
    const auth = await requireApiKey(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const body = await req.json().catch(() => ({}));
    const { type, name, region, capacity, performanceProfile, tags } = body;

    const result = await createStorageResource({ orgId: auth.orgId, type, name, region, capacity, performanceProfile, tags, membership: auth.membership, actorEmail: "terraform-provider-inaya" });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ resource: { ...result.resource, _id: result.resource._id.toString() } });
  } catch (err) {
    console.error("public/v1/storage/resources POST failed:", err);
    return NextResponse.json({ error: "Could not create storage resource." }, { status: 500 });
  }
}
