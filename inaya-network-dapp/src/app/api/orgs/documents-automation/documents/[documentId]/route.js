// GET /api/orgs/documents-automation/documents/[documentId]?orgId=
//   -> document status, calculation, validation checks and (once finalized) the manifest.
import { NextResponse } from "next/server";
import { authed, fail, respond } from "../../_lib.js";
import { getDocument } from "../../../../../../lib/documentAutomation/pipeline.js";

export const dynamic = "force-dynamic";

export async function GET(req, { params }) {
  try {
    const { documentId } = await params;
    const orgId = new URL(req.url).searchParams.get("orgId");
    const a = await authed(req, orgId);
    if (a.response) return a.response;
    const got = await getDocument({ orgId, documentId, membership: a.membership, email: a.email });
    if (got.error) return respond(got);
    return NextResponse.json({ document: got.document });
  } catch (err) { return fail(err, "document GET"); }
}
