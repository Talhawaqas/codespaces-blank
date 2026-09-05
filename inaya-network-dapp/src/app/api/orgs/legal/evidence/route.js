// app/api/orgs/legal/evidence/route.js
// GET  ?orgId=&matterId= -> list evidence for a matter
// POST { orgId, matterId, source, ... } -> acquire evidence
// PATCH { orgId, evidenceId, destination, reason } -> transfer custody

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { getAccessibleScope } from "../../../../../lib/document-permissions.js";
import { acquireEvidence, transferEvidence, listEvidenceForMatter } from "../../../../../lib/legal-evidence.js";
import { listCustodyEvents } from "../../../../../lib/legal-custody.js";

function serialize(e) {
  return { id: e._id.toString(), source: e.source, custodian: e.custodian, description: e.description, createdAt: e.createdAt };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const matterId = searchParams.get("matterId");
    const evidenceId = searchParams.get("evidenceId");
    if (!orgId || !matterId) return NextResponse.json({ error: "orgId and matterId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "legal");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
    if (!scope.visibleMatters.some((m) => m._id.toString() === matterId)) {
      return NextResponse.json({ error: "Matter not found." }, { status: 404 });
    }

    if (evidenceId) {
      const events = await listCustodyEvents(orgId, evidenceId);
      return NextResponse.json({ custodyEvents: events.map((e) => ({ action: e.action, actorEmail: e.actorEmail, source: e.source, destination: e.destination, timestamp: e.timestamp })) });
    }
    const evidence = await listEvidenceForMatter(orgId, matterId);
    return NextResponse.json({ evidence: evidence.map(serialize) });
  } catch (err) {
    console.error("orgs/legal/evidence GET failed:", err);
    return NextResponse.json({ error: "Could not fetch evidence." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    if (!body.orgId || !body.matterId || !body.source) return NextResponse.json({ error: "orgId, matterId, and source are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, body.orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(body.orgId, "legal");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await acquireEvidence({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ evidence: serialize(result.evidence) });
  } catch (err) {
    console.error("orgs/legal/evidence POST failed:", err);
    return NextResponse.json({ error: "Could not acquire evidence." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, evidenceId, destination, reason } = await req.json();
    if (!orgId || !evidenceId || !destination) return NextResponse.json({ error: "orgId, evidenceId, and destination are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "legal");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await transferEvidence({ orgId, evidenceId, destination, reason, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ transferred: true });
  } catch (err) {
    console.error("orgs/legal/evidence PATCH failed:", err);
    return NextResponse.json({ error: "Could not transfer evidence." }, { status: 500 });
  }
}
