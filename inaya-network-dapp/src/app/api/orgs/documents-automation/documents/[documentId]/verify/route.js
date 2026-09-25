// POST /api/orgs/documents-automation/documents/[documentId]/verify?orgId=&deep=1
//   body: the PDF bytes (application/pdf) or JSON { pdfBase64 }; the body is optional.
//   -> real recomputation: file hash vs recorded hash, manifest hash, the
//      document's evidence chain, the org audit chain and (deep) the stored
//      ciphertext. Send no body to verify the stored document itself.
import { authed, fail, respond, readPdf, limited } from "../../../_lib.js";
import { verifyDocument } from "../../../../../../../lib/documentAutomation/verify.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req, { params }) {
  try {
    const { documentId } = await params;
    const sp = new URL(req.url).searchParams;
    const a = await authed(req, sp.get("orgId"));
    if (a.response) return a.response;
    const rl = await limited(req, { action: "verify", max: 40, key: a.email });
    if (rl) return rl;
    let bytes = null;
    if (Number(req.headers.get("content-length") || 0) > 0) {
      const p = await readPdf(req);
      if (p.error) return respond(p);
      bytes = p.bytes;
    }
    return respond(await verifyDocument({ orgId: sp.get("orgId"), documentId, bytes, deep: sp.get("deep") !== "0", membership: a.membership, email: a.email }));
  } catch (err) { return fail(err, "verify POST"); }
}
