// GET /api/orgs/documents-automation/documents/[documentId]/download?orgId=&stage=final|draft
//   -> the decrypted PDF for an authorized viewer. The stored bytes are
//      re-hashed before release; a mismatch is refused and recorded.
import { authed, fail, respond, limited, pdfResponse } from "../../../_lib.js";
import { downloadDocumentBytes } from "../../../../../../../lib/documentAutomation/verify.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req, { params }) {
  try {
    const { documentId } = await params;
    const sp = new URL(req.url).searchParams;
    const a = await authed(req, sp.get("orgId"));
    if (a.response) return a.response;
    const rl = await limited(req, { action: "download", max: 60, key: a.email });
    if (rl) return rl;
    const stage = sp.get("stage") === "draft" ? "draft" : "final";
    const got = await downloadDocumentBytes({ orgId: sp.get("orgId"), documentId, stage, membership: a.membership, email: a.email });
    if (got.error) return respond(got);
    return pdfResponse(got.buffer, got.filename, { hash: got.hash, inline: sp.get("disposition") !== "attachment" });
  } catch (err) { return fail(err, "download GET"); }
}
