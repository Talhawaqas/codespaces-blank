// POST /api/orgs/documents-automation/documents/[documentId]/finalize   { orgId }
//   -> finalizes an APPROVED (or approval-free GENERATED) document: verifies
//      the stored bytes, re-renders with the approval stamp when required,
//      builds the manifest, stores, locks retention and supersedes any older
//      finalized version.
import { authed, fail, respond, readJson, limited } from "../../../_lib.js";
import { finalizeDocument } from "../../../../../../../lib/documentAutomation/lifecycle.js";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req, { params }) {
  try {
    const { documentId } = await params;
    const j = await readJson(req);
    if (j.error) return respond(j);
    const a = await authed(req, j.body.orgId);
    if (a.response) return a.response;
    const rl = await limited(req, { action: "finalize", max: 30, key: a.email });
    if (rl) return rl;
    return respond(await finalizeDocument({ orgId: j.body.orgId, documentId, membership: a.membership, email: a.email, actorType: "human" }));
  } catch (err) { return fail(err, "finalize POST"); }
}
