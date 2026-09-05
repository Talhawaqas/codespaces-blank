// app/api/orgs/legal/redaction/route.js
// GET   ?orgId=&matterId= -> list redaction requests for a matter
// POST  { orgId, matterId, originalDocumentId, suggestions } -> request redaction
// PATCH { orgId, requestId, redactedDocumentId } -> complete redaction

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { createRedactionRequest, completeRedaction, listRedactionRequestsForMatter } from "../../../../../lib/redaction.js";

function serialize(r) {
  return { id: r._id.toString(), status: r.status, originalDocumentId: r.originalDocumentId.toString(), redactedDocumentId: r.redactedDocumentId?.toString() || null };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const matterId = searchParams.get("matterId");
    if (!orgId || !matterId) return NextResponse.json({ error: "orgId and matterId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const requests = await listRedactionRequestsForMatter(orgId, matterId);
    return NextResponse.json({ requests: requests.map(serialize) });
  } catch (err) {
    console.error("orgs/legal/redaction GET failed:", err);
    return NextResponse.json({ error: "Could not fetch redaction requests." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    if (!body.orgId || !body.matterId || !body.originalDocumentId) return NextResponse.json({ error: "orgId, matterId, and originalDocumentId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, body.orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await createRedactionRequest({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ request: serialize(result.request) });
  } catch (err) {
    console.error("orgs/legal/redaction POST failed:", err);
    return NextResponse.json({ error: "Could not create redaction request." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, requestId, redactedDocumentId } = await req.json();
    if (!orgId || !requestId || !redactedDocumentId) return NextResponse.json({ error: "orgId, requestId, and redactedDocumentId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await completeRedaction({ orgId, requestId, redactedDocumentId, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ request: serialize(result.request) });
  } catch (err) {
    console.error("orgs/legal/redaction PATCH failed:", err);
    return NextResponse.json({ error: "Could not complete redaction." }, { status: 500 });
  }
}
