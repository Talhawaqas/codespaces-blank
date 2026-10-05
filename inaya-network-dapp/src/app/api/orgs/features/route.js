// app/api/orgs/features/route.js
//
//   GET   ?orgId             -> which new-capability flags are on for this organization and where each one comes from
//                               ("platform" = switched on for everyone, "organization" = opted in here, "off"). Any member.
//   PATCH { orgId, name, enabled } -> opt this organization in or out of one flag (owner/admin only). Refused (409) while the
//                               platform kill switch (FEATURE_X=off) is set.
// This is the staged-rollout control from the Competitive Expansion SOW (section 55): nothing new appears until someone turns it on.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { FEATURES, listOrgFeatures, setOrgFeature } from "../../../../lib/featureFlags.js";
import { logOrgActivity } from "../../../../lib/org-activity-log.js";

export const dynamic = "force-dynamic";
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });

export async function GET(req) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return json({ error: "orgId is required." }, 400);
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return json({ error: auth.error }, auth.status);
    return json({ features: await listOrgFeatures(orgId) });
  } catch (err) { console.error("orgs/features GET failed:", err?.name); return json({ error: "Could not load features." }, 500); }
}

export async function PATCH(req) {
  try {
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    if (!body.orgId) return json({ error: "orgId is required." }, 400);
    await ensureOrgIndexes();
    const auth = await requireMembership(req, body.orgId, { requireManage: true });
    if (auth.error) return json({ error: auth.error }, auth.status);
    if (!FEATURES.includes(body.name)) return json({ error: "Unknown feature." }, 400);
    const r = await setOrgFeature({ orgId: body.orgId, name: body.name, enabled: body.enabled === true });
    if (r.error) return json({ error: r.error }, r.status);
    try { await logOrgActivity({ orgId: body.orgId, recordType: "ORG_FEATURE", recordId: body.orgId, actorEmail: auth.session.email, action: body.enabled ? "ENABLED" : "DISABLED", previousState: null, newState: null, metadata: { feature: body.name } }); } catch { /* best effort */ }
    return json({ ...r, features: await listOrgFeatures(body.orgId) });
  } catch (err) { console.error("orgs/features PATCH failed:", err?.name); return json({ error: "Could not change the feature." }, 500); }
}
