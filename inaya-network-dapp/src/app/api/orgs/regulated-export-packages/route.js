// app/api/orgs/regulated-export-packages/route.js
// GET  ?orgId=&requestId= -> list packages
// POST { orgId, requestId, recordType, records } -> generate a package for an APPROVED export request

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { generateRegulatedExportPackage, listRegulatedExportPackages } from "../../../../lib/regulated-export-package.js";

function serialize(p) {
  return { id: p._id.toString(), requestId: p.requestId.toString(), manifest: p.manifest, hash: p.hash, chainVerificationResult: p.chainVerificationResult, authorization: p.authorization, createdAt: p.createdAt };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const packages = await listRegulatedExportPackages(orgId, { requestId: searchParams.get("requestId") || undefined });
    return NextResponse.json({ packages: packages.map(serialize) });
  } catch (err) {
    console.error("orgs/regulated-export-packages GET failed:", err);
    return NextResponse.json({ error: "Could not fetch export packages." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, requestId, recordType, records } = body;
    if (!orgId || !requestId || !recordType || !records) return NextResponse.json({ error: "orgId, requestId, recordType, and records are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await generateRegulatedExportPackage({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ package: serialize(result.package) });
  } catch (err) {
    console.error("orgs/regulated-export-packages POST failed:", err);
    return NextResponse.json({ error: "Could not generate the export package." }, { status: 500 });
  }
}
