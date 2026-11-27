// app/api/orgs/powerbi/route.js -- Admin > Integrations > Power BI (Enterprise; src/lib/analytics/oauth.js).
//   GET   ?orgId                                     -> entitlement, settings and connections (owner/admin: all; others: their own)
//   PATCH { orgId, membersMayConnect }               -> owner/admin
//   POST  { orgId, action: "revoke", connectionId }  -> owner/admin any connection; a member their own
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { powerBiAdmin, setPowerBiSettings, adminRevoke, OAuthError } from "../../../../lib/analytics/oauth.js";

export const dynamic = "force-dynamic";
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });

async function run(req, fn) {
  try {
    let body = {}; if (req.method !== "GET") { try { body = await req.json(); } catch { body = {}; } }
    const orgId = new URL(req.url).searchParams.get("orgId") || body.orgId;
    if (!orgId) return json({ error: "orgId is required." }, 400);
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return json({ error: auth.error }, auth.status);
    return json(await fn({ orgId, membership: { ...auth.membership, email: auth.session.email }, actorEmail: auth.session.email, body }));
  } catch (err) {
    if (err instanceof OAuthError) return json({ error: err.message }, err.status);
    console.error("orgs/powerbi failed:", err?.name);
    return json({ error: "Something went wrong." }, 500);
  }
}

export const GET = (req) => run(req, ({ orgId, membership }) => powerBiAdmin({ orgId, membership }));
export const PATCH = (req) => run(req, ({ orgId, membership, actorEmail, body }) => setPowerBiSettings({ orgId, membership, actorEmail, membersMayConnect: body.membersMayConnect }));
export const POST = (req) => run(req, ({ orgId, membership, actorEmail, body }) => adminRevoke({ orgId, membership, actorEmail, grantId: body.connectionId }));
