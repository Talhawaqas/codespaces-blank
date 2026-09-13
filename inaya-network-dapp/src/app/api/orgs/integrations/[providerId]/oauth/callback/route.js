// app/api/orgs/integrations/[providerId]/oauth/callback/route.js
// GET ?code=&state=  (or ?error=&state= on provider-side rejection)
// The provider redirects the browser here directly -- no session cookie is
// required on this route, since the CSRF `state` row (created in
// oauth/start, single-use, TTL-expired) is itself the proof of which
// org/actor started this flow. See integrationOauth.js's completeOauthFlow.

import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../../../lib/orgs.js";
import { completeOauthFlow } from "../../../../../../../lib/integrationOauth.js";

export async function GET(req, { params }) {
  const { providerId } = await params;
  const { searchParams, origin } = new URL(req.url);
  const state = searchParams.get("state");
  const code = searchParams.get("code");
  const providerError = searchParams.get("error") || searchParams.get("error_description");
  const redirectUri = `${origin}/api/orgs/integrations/${providerId}/oauth/callback`;

  if (!state) {
    return NextResponse.redirect(`${origin}/business?view=integrations&oauthError=${encodeURIComponent("Missing authorization state.")}`);
  }

  try {
    await ensureOrgIndexes();
    const result = await completeOauthFlow({ state, code, error: providerError, redirectUri });
    if (result.error) {
      return NextResponse.redirect(`${origin}/business?view=integrations&oauthError=${encodeURIComponent(result.error)}`);
    }
    if (!result.success) {
      return NextResponse.redirect(`${origin}/business?view=integrations&oauthError=${encodeURIComponent(result.error || "Connection failed.")}`);
    }
    return NextResponse.redirect(`${origin}/business?view=integrations&connected=${encodeURIComponent(result.providerId)}`);
  } catch (err) {
    console.error("orgs/integrations/[providerId]/oauth/callback GET failed:", err);
    return NextResponse.redirect(`${origin}/business?view=integrations&oauthError=${encodeURIComponent("Unexpected error completing the connection.")}`);
  }
}
