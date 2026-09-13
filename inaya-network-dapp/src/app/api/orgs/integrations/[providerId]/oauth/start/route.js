// app/api/orgs/integrations/[providerId]/oauth/start/route.js
// GET ?orgId= -> generates real CSRF state, redirects the browser to the
// provider's REAL authorization URL (Slack/Microsoft/Google/Okta/OIDC only
// -- see integrationOauth.js's OAUTH_BACKED_PROVIDER_IDS).

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { startOauthFlow } from "../../../../../../../lib/integrationOauth.js";

export async function GET(req, { params }) {
  try {
    const { providerId } = await params;
    const { searchParams, origin } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const redirectUri = `${origin}/api/orgs/integrations/${providerId}/oauth/callback`;
    const result = await startOauthFlow({
      orgId, providerId, redirectUri,
      actorEmail: auth.session.email, membership: auth.membership,
    });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status || 400 });

    return NextResponse.redirect(result.url);
  } catch (err) {
    console.error("orgs/integrations/[providerId]/oauth/start GET failed:", err);
    return NextResponse.json({ error: "Could not start the connection." }, { status: 500 });
  }
}
