// app/api/orgs/ai-security/policy/route.js
// GET ?orgId=[&view=history] -> active policy (readable by any member), or the version history (owner/admin only); PUT { orgId, policy } -> versioned update (manager-only)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessAiSecurity } from "../../../../../lib/orgs.js";
import { getOrgAiPolicy, setOrgAiPolicy, listOrgAiPolicyVersions, KNOWN_PROVIDERS, POLICY_LIMITS } from "../../../../../lib/aiSecurity/orgPolicy.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessAiSecurity(auth.membership)) return NextResponse.json({ error: "You don't have access to the AI security policy." }, { status: 403 });

    if (searchParams.get("view") === "history") {
      const r = await listOrgAiPolicyVersions({ orgId, membership: auth.membership });
      if (r.error) return NextResponse.json({ error: r.error }, { status: r.status });
      return NextResponse.json({ versions: r.versions.map((v) => ({ version: v.version, active: !!v.active, createdBy: v.createdByEmail, createdAt: v.createdAt, policy: v.policy })) });
    }
    const policy = await getOrgAiPolicy(orgId);
    return NextResponse.json({ policy, options: { providers: KNOWN_PROVIDERS, limits: POLICY_LIMITS } });
  } catch (err) {
    console.error("orgs/ai-security/policy GET failed:", err);
    return NextResponse.json({ error: "Could not fetch AI security policy." }, { status: 500 });
  }
}

export async function PUT(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const { orgId, policy } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    if (!policy || typeof policy !== "object") return NextResponse.json({ error: "policy object is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await setOrgAiPolicy({ orgId, policy, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/ai-security/policy PUT failed:", err);
    return NextResponse.json({ error: "Could not update AI security policy." }, { status: 500 });
  }
}
