// app/api/orgs/legal/clients/route.js
//
// GET  /api/orgs/legal/clients?orgId=...&search=...
// POST /api/orgs/legal/clients  { orgId, name, personOrCompany, ... }

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { getAccessibleScope } from "../../../../../lib/document-permissions.js";
import { createClient } from "../../../../../lib/legal-clients.js";

function serializeClient(c) {
  return { id: c._id.toString(), name: c.name, personOrCompany: c.personOrCompany, status: c.status, createdAt: c.createdAt };
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

    // Clients are visible to any legal-role member org-wide (canAccessLegalMatters
    // gates matters/assignment, but clients themselves aren't assignment-scoped
    // the way matters are per the SOW -- getAccessibleScope's visibleClients
    // already reflects that (canSeeAllMatters-gated only, no assignment fallback).
    const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
    let list = scope.visibleClients;
    if (search) {
      const needle = search.toLowerCase();
      list = list.filter((c) => (c.name || "").toLowerCase().includes(needle));
    }

    return NextResponse.json({ clients: list.map(serializeClient) });
  } catch (err) {
    console.error("orgs/legal/clients GET failed:", err);
    return NextResponse.json({ error: "Could not fetch clients." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, name } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    if (!name) return NextResponse.json({ error: "name is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await createClient({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json({ client: serializeClient(result.client) });
  } catch (err) {
    console.error("orgs/legal/clients POST failed:", err);
    return NextResponse.json({ error: "Could not create the client." }, { status: 500 });
  }
}
