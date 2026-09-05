// app/api/orgs/export-requests/route.js
// GET   ?orgId=&status= -> list export requests
// POST  { orgId, reason, scope, format } -> request an export
// PATCH { orgId, requestId, approve } -> owner/admin decides (approve/reject)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { requestExport, decideExport, listExportRequests } from "../../../../lib/export-center.js";

function serialize(r) {
  return { id: r._id.toString(), reason: r.reason, format: r.format, status: r.status, packageUrl: r.packageUrl, expiresAt: r.expiresAt, createdAt: r.createdAt };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const status = searchParams.get("status");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const requests = await listExportRequests(orgId, { status });
    return NextResponse.json({ requests: requests.map(serialize) });
  } catch (err) {
    console.error("orgs/export-requests GET failed:", err);
    return NextResponse.json({ error: "Could not fetch export requests." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { orgId, reason, scope, format } = await req.json();
    if (!orgId || !reason || !format) return NextResponse.json({ error: "orgId, reason, and format are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await requestExport({ orgId, reason, scope, format, actorEmail: auth.session.email });
    return NextResponse.json({ request: serialize(result.request) });
  } catch (err) {
    console.error("orgs/export-requests POST failed:", err);
    return NextResponse.json({ error: "Could not submit export request." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, requestId, approve } = await req.json();
    if (!orgId || !requestId || approve === undefined) return NextResponse.json({ error: "orgId, requestId, and approve are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await decideExport({ orgId, requestId, approve, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ request: serialize(result.request) });
  } catch (err) {
    console.error("orgs/export-requests PATCH failed:", err);
    return NextResponse.json({ error: "Could not decide export request." }, { status: 500 });
  }
}
