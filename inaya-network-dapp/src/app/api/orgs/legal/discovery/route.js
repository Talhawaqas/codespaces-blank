// app/api/orgs/legal/discovery/route.js
// POST  { orgId, matterId, requestingParty, respondingParty, scope } -> create discovery request
// PATCH { orgId, discoveryId, action:"addDocuments"|"tag"|"produce", ... } -> advance

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { createDiscoveryRequest, addCollectedDocuments, tagDocument, produceDiscovery } from "../../../../../lib/legal-discovery-workflow.js";

function serialize(d) {
  return { id: d._id.toString(), status: d.status, requestingParty: d.requestingParty, respondingParty: d.respondingParty, documentCount: d.documentIds?.length || 0, productionCount: d.productionSet?.length || 0 };
}

export async function POST(req) {
  try {
    const body = await req.json();
    if (!body.orgId || !body.matterId) return NextResponse.json({ error: "orgId and matterId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, body.orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await createDiscoveryRequest({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ discovery: serialize(result.discovery) });
  } catch (err) {
    console.error("orgs/legal/discovery POST failed:", err);
    return NextResponse.json({ error: "Could not create discovery request." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const body = await req.json();
    const { orgId, discoveryId, action } = body;
    if (!orgId || !discoveryId || !action) return NextResponse.json({ error: "orgId, discoveryId, and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    let result;
    if (action === "addDocuments") {
      result = await addCollectedDocuments({ orgId, discoveryId, documentIds: body.documentIds, custodianEmail: body.custodianEmail, actorEmail: auth.session.email, membership: auth.membership });
      if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
      return NextResponse.json({ added: result.added });
    }
    if (action === "tag") {
      result = await tagDocument({ orgId, discoveryId, documentId: body.documentId, responsive: body.responsive, privileged: body.privileged, confidential: body.confidential, actorEmail: auth.session.email, membership: auth.membership });
    } else if (action === "produce") {
      result = await produceDiscovery({ orgId, discoveryId, actorEmail: auth.session.email, membership: auth.membership });
    } else {
      return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
    }
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ discovery: serialize(result.discovery) });
  } catch (err) {
    console.error("orgs/legal/discovery PATCH failed:", err);
    return NextResponse.json({ error: "Could not update discovery request." }, { status: 500 });
  }
}
