// app/api/orgs/sso/route.js -- staff single sign-on settings (Enterprise; src/lib/workforceSso.js). Owner/admin only.
//   GET  ?orgId                                   -> settings (the client secret is never returned)
//   PUT  { orgId, issuer, clientId, clientSecret?, domains, enabled, enforce, requireVerifiedEmail }
//   POST { orgId, action: "test" }                -> does the provider answer? + the redirect URI to register
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import * as W from "../../../../lib/workforceSso.js";

export const dynamic = "force-dynamic";
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });

async function run(req, fn) {
  try {
    let body = {}; if (req.method !== "GET") { try { body = await req.json(); } catch { body = {}; } }
    const orgId = new URL(req.url).searchParams.get("orgId") || body.orgId; if (!orgId) return json({ error: "orgId is required." }, 400);
    await ensureOrgIndexes(); const auth = await requireMembership(req, orgId); if (auth.error) return json({ error: auth.error }, auth.status);
    return json(await fn({ orgId, membership: auth.membership, actorEmail: auth.session.email, body }));
  } catch (err) {
    if (err instanceof W.SsoError) return json({ error: err.message }, err.status);
    console.error("orgs/sso failed:", err?.name); return json({ error: "Something went wrong." }, 500);
  }
}
export const GET = (req) => run(req, ({ orgId, membership }) => W.getWorkforceSso({ orgId, membership }));
export const PUT = (req) => run(req, ({ orgId, membership, actorEmail, body }) => { const { orgId: _o, ...input } = body; return W.setWorkforceSso({ orgId, membership, actorEmail, input }); });
export const POST = (req) => run(req, ({ orgId, membership, body }) => (body.action === "test" ? W.testWorkforceSso({ orgId, membership }) : Promise.reject(new W.SsoError(400, "Unknown action."))));
