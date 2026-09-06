// app/api/orgs/sod-rules/route.js
// GET   ?orgId= -> list every SoD rule type, defaulted to enabled if never configured
// PATCH { orgId, ruleType, enabled } -> configure one rule

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { listSodRules, configureSodRule } from "../../../../lib/segregation-of-duties.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const rules = await listSodRules(orgId);
    return NextResponse.json({ rules: rules.map((r) => ({ ruleType: r.ruleType, enabled: r.enabled, configuredAt: r.configuredAt || null })) });
  } catch (err) {
    console.error("orgs/sod-rules GET failed:", err);
    return NextResponse.json({ error: "Could not fetch SoD rules." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, ruleType, enabled } = await req.json();
    if (!orgId || !ruleType || typeof enabled !== "boolean") return NextResponse.json({ error: "orgId, ruleType, and a boolean enabled are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await configureSodRule({ orgId, ruleType, enabled, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/sod-rules PATCH failed:", err);
    return NextResponse.json({ error: "Could not configure SoD rule." }, { status: 500 });
  }
}
