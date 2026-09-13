// app/api/orgs/integrations/[providerId]/oauth/disconnect/route.js
// POST { orgId } -> calls the real provider revoke() where one exists, then
// clears Inaya's own stored token and marks the connection DISABLED.
// Response may include `manualRevokeUrl` when the API-based revoke could
// not be confirmed -- the UI must surface that link, not treat a missing
// `revoked:true` as silently fine.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { disconnectOauthConnection } from "../../../../../../../lib/integrationOauth.js";

export async function POST(req, { params }) {
  try {
    const { providerId } = await params;
    const { orgId } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await disconnectOauthConnection({
      orgId, providerId, actorEmail: auth.session.email, membership: auth.membership,
    });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status || 400 });

    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/integrations/[providerId]/oauth/disconnect POST failed:", err);
    return NextResponse.json({ error: "Could not disconnect the integration." }, { status: 500 });
  }
}
