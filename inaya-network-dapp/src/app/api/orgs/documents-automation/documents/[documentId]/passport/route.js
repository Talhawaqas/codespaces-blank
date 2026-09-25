// GET /api/orgs/documents-automation/documents/[documentId]/passport?orgId=&scope=internal|external&format=json|pdf
//   -> the portable Document Passport (hash-sealed). "external" redacts
//      source records, amounts and customers.
import { NextResponse } from "next/server";
import { authed, fail, respond, limited, pdfResponse } from "../../../_lib.js";
import { buildDocumentPassport, renderDocumentPassportPdf } from "../../../../../../../lib/documentAutomation/verify.js";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req, { params }) {
  try {
    const { documentId } = await params;
    const sp = new URL(req.url).searchParams;
    const a = await authed(req, sp.get("orgId"));
    if (a.response) return a.response;
    const rl = await limited(req, { action: "passport", max: 30, key: a.email });
    if (rl) return rl;
    const built = await buildDocumentPassport({ orgId: sp.get("orgId"), documentId, scope: sp.get("scope") === "external" ? "external" : "internal", membership: a.membership, email: a.email });
    if (built.error) return respond(built);
    if (sp.get("format") === "pdf") return pdfResponse(await renderDocumentPassportPdf(built.passport), `passport-${built.passport.document.documentNumber}.pdf`, { hash: built.passport.manifestHash });
    return NextResponse.json({ passport: built.passport });
  } catch (err) { return fail(err, "passport GET"); }
}
