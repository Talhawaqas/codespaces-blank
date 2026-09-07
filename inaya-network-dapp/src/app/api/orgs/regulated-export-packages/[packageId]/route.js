// app/api/orgs/regulated-export-packages/[packageId]/route.js
// GET ?orgId=&verify=1 -> package detail, or {valid} if verify=1 (recomputes the hash, never trusts the stored one alone)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { getRegulatedExportPackage, verifyRegulatedExportPackage } from "../../../../../lib/regulated-export-package.js";

export async function GET(req, { params }) {
  try {
    const { packageId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    if (searchParams.get("verify")) {
      const result = await verifyRegulatedExportPackage(orgId, packageId);
      if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
      return NextResponse.json({ valid: result.valid, storedHash: result.storedHash, recomputedHash: result.recomputedHash });
    }

    const pkg = await getRegulatedExportPackage(orgId, packageId);
    if (!pkg) return NextResponse.json({ error: "Package not found." }, { status: 404 });
    return NextResponse.json({ package: { id: pkg._id.toString(), manifest: pkg.manifest, hash: pkg.hash, chainVerificationResult: pkg.chainVerificationResult, authorization: pkg.authorization, records: pkg.records, createdAt: pkg.createdAt } });
  } catch (err) {
    console.error("orgs/regulated-export-packages/[packageId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch the export package." }, { status: 500 });
  }
}
