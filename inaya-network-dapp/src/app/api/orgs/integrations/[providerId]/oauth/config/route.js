// app/api/orgs/integrations/[providerId]/oauth/config/route.js
// POST { orgId, issuer, clientId, clientSecret } -> saves an org's own
// OIDC app registration (Okta / Generic SAML-OIDC only -- these are
// bring-your-own-IdP, unlike Slack/Microsoft/Google's single Inaya-owned
// app). Must be called before oauth/start will work for these providers.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { saveOrgOidcConfig } from "../../../../../../../lib/integrationOauth.js";

export async function POST(req, { params }) {
  try {
    const { providerId } = await params;
    const { orgId, issuer, clientId, clientSecret } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await saveOrgOidcConfig({
      orgId, providerId, issuer, clientId, clientSecret,
      actorEmail: auth.session.email, membership: auth.membership,
    });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status || 400 });

    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/integrations/[providerId]/oauth/config POST failed:", err);
    return NextResponse.json({ error: "Could not save the identity provider configuration." }, { status: 500 });
  }
}
