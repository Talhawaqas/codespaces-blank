// app/api/orgs/digital-twin/simulate/route.js
//
// GET  /api/orgs/digital-twin/simulate?orgId=&limit=  -> scenario history
// POST /api/orgs/digital-twin/simulate
// Body: { orgId, scenarioType, entityId, params? }
//   scenarioType: SUPPLIER_UNAVAILABLE | EMPLOYEE_ACCESS_REMOVED | PROJECT_DELAYED | WAREHOUSE_UNAVAILABLE
//   entityId: the supplier/employee-email/project/warehouse id the scenario starts from
//   params: scenario-specific, e.g. { delayDays } for PROJECT_DELAYED
//
// Digital Twin SOW -- read-only by construction (digitalTwinSimulate.js
// has no import of any mutation function). "SIMULATION ONLY -- NO
// CHANGES WILL BE MADE" is asserted server-side (noChangesWereMade: true
// on every real result), not left to the client to display honestly.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { simulateDigitalTwinScenario, listDigitalTwinSimulations, SCENARIO_TYPES } from "../../../../../lib/digitalTwinSimulate.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const limit = Math.min(Number(searchParams.get("limit")) || 50, 200);
    const history = await listDigitalTwinSimulations({ orgId, limit });
    return NextResponse.json({ history });
  } catch (err) {
    console.error("orgs/digital-twin/simulate GET failed:", err);
    return NextResponse.json({ error: "Could not fetch simulation history." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { orgId, scenarioType, entityId, params } = await req.json();
    if (!orgId || !scenarioType || !entityId) return NextResponse.json({ error: "orgId, scenarioType and entityId are required." }, { status: 400 });
    if (!SCENARIO_TYPES.includes(scenarioType)) return NextResponse.json({ error: `Unknown scenarioType. Must be one of ${SCENARIO_TYPES.join(", ")}.` }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await simulateDigitalTwinScenario({ orgId, scenarioType, entityId, membership: auth.membership, actorEmail: auth.session.email, params: params || {} });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/digital-twin/simulate POST failed:", err);
    return NextResponse.json({ error: "Could not run this simulation." }, { status: 500 });
  }
}
