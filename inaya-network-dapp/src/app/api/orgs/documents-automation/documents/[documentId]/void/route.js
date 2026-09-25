// POST /api/orgs/documents-automation/documents/[documentId]/void   { orgId, reason, cancel? }
//   -> voids a finalized document (reason required; its number is kept and
//      marked VOIDED, all links revoked). With cancel:true, cancels a document
//      that was never finalized instead.
import { authed, fail, respond, readJson, limited } from "../../../_lib.js";
import { voidDocument, cancelDocument } from "../../../../../../../lib/documentAutomation/lifecycle.js";

export const dynamic = "force-dynamic";

export async function POST(req, { params }) {
  try {
    const { documentId } = await params;
    const j = await readJson(req);
    if (j.error) return respond(j);
    const a = await authed(req, j.body.orgId);
    if (a.response) return a.response;
    const rl = await limited(req, { action: "void", max: 30, key: a.email });
    if (rl) return rl;
    const args = { orgId: j.body.orgId, documentId, reason: j.body.reason, membership: a.membership, email: a.email };
    return respond(j.body.cancel === true ? await cancelDocument(args) : await voidDocument(args));
  } catch (err) { return fail(err, "void POST"); }
}
