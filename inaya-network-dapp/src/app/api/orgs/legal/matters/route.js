// app/api/orgs/legal/matters/route.js
//
// GET  /api/orgs/legal/matters?orgId=...&search=...
//   -> the caller's assignment-scoped visible matters (getAccessibleScope).
// POST /api/orgs/legal/matters  { orgId, name, clientId, type, ... }
//   -> create (canAccessLegalMatters-gated, enforced inside createMatter()).

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { getAccessibleScope } from "../../../../../lib/document-permissions.js";
import { createMatter } from "../../../../../lib/legal-matter-workflow.js";

function serializeMatter(m) {
  return {
    id: m._id.toString(), name: m.name, type: m.type, status: m.status, priority: m.priority,
    jurisdiction: m.jurisdiction, court: m.court, responsiblePartnerEmail: m.responsiblePartnerEmail,
    confidentiality: m.confidentiality, openDate: m.openDate, closeDate: m.closeDate,
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const search = searchParams.get("search");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
    let list = scope.visibleMatters;
    if (search) {
      const needle = search.toLowerCase();
      list = list.filter((m) => (m.name || "").toLowerCase().includes(needle));
    }

    return NextResponse.json({ matters: list.map(serializeMatter) });
  } catch (err) {
    console.error("orgs/legal/matters GET failed:", err);
    return NextResponse.json({ error: "Could not fetch matters." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, name, type } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    if (!name || !type) return NextResponse.json({ error: "name and type are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await createMatter({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json({ matter: serializeMatter(result.matter) });
  } catch (err) {
    console.error("orgs/legal/matters POST failed:", err);
    return NextResponse.json({ error: "Could not create the matter." }, { status: 500 });
  }
}
