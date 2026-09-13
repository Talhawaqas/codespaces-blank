// app/api/orgs/sign/requests/route.js
//
// POST /api/orgs/sign/requests  { orgId, documentId, signers, deadline?, message? }
// GET  /api/orgs/sign/requests?orgId=&documentId=

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { createSigningRequest, listSigningRequests } from "../../../../../lib/signing-workflow.js";

function serialize(r) {
  return {
    id: r._id.toString(), orgId: r.orgId.toString(), documentId: r.documentId.toString(),
    documentGroupId: r.documentGroupId?.toString() || null, documentVersion: r.documentVersion,
    documentHash: r.documentHash, status: r.status,
    signers: r.signers.map((s) => ({ email: s.email, wallet: s.wallet, role: s.role, order: s.order, status: s.status, signedAt: s.signedAt, method: s.method })),
    deadline: r.deadline, message: r.message, createdByEmail: r.createdByEmail, createdAt: r.createdAt,
    sentAt: r.sentAt || null, completedAt: r.completedAt, anchorTxHash: r.anchorTxHash || null,
  };
}

export async function POST(req) {
  try {
    const { orgId, documentId, signers, deadline, message } = await req.json();
    if (!orgId || !documentId) return NextResponse.json({ error: "orgId and documentId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await createSigningRequest({ orgId, documentId, signers, deadline, message, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ requestId: result.requestId.toString() });
  } catch (err) {
    console.error("orgs/sign/requests POST failed:", err);
    return NextResponse.json({ error: "Could not create the signing request." }, { status: 500 });
  }
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const documentId = searchParams.get("documentId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const list = await listSigningRequests({ orgId, documentId });
    return NextResponse.json({ requests: list.map(serialize) });
  } catch (err) {
    console.error("orgs/sign/requests GET failed:", err);
    return NextResponse.json({ error: "Could not fetch signing requests." }, { status: 500 });
  }
}
