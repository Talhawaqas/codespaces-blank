// app/api/orgs/documents-automation/[documentId]/route.js
// GET ?orgId= -> the canonical manifest, hash, and status for a generated document (Document Passport surface -- SOW §14/§20)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { getGeneratedDocument } from "../../../../../lib/documentAutomation/generate.js";

export async function GET(req, { params }) {
  try {
    const { documentId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await getGeneratedDocument({ orgId, documentId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/documents-automation/[documentId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch the document." }, { status: 500 });
  }
}
