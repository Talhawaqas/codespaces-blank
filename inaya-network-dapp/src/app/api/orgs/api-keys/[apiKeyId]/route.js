// app/api/orgs/api-keys/[apiKeyId]/route.js
//
// DELETE /api/orgs/api-keys/:apiKeyId?orgId= — revoke a key.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canManageOrg } from "../../../../../lib/orgs.js";
import { revokeApiKey } from "../../../../../lib/api-keys.js";

export async function DELETE(req, { params }) {
  try {
    const { apiKeyId } = params;
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canManageOrg(auth.membership)) return NextResponse.json({ error: "Only the owner or an admin can revoke an API key." }, { status: 403 });

    const result = await revokeApiKey({ orgId, apiKeyId });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/api-keys/[apiKeyId] DELETE failed:", err);
    return NextResponse.json({ error: "Could not revoke the API key." }, { status: 500 });
  }
}
