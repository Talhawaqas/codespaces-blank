// POST /api/orgs/documents-automation/documents/[documentId]/retry   { orgId }
//   -> retries a document stuck in GENERATION_FAILED / STORAGE_FAILED /
//      EVIDENCE_PENDING, idempotently, from its stored snapshot (same number).
import { NextResponse } from "next/server";
import { authed, fail, respond, readJson, limited } from "../../../_lib.js";
import { retryDocument } from "../../../../../../../lib/documentAutomation/jobs.js";
import { serializeDocument } from "../../../../../../../lib/documentAutomation/pipeline.js";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req, { params }) {
  try {
    const { documentId } = await params;
    const j = await readJson(req);
    if (j.error) return respond(j);
    const a = await authed(req, j.body.orgId);
    if (a.response) return a.response;
    const rl = await limited(req, { action: "retry", max: 20, key: a.email });
    if (rl) return rl;
    const result = await retryDocument({ orgId: j.body.orgId, documentId, actorEmail: a.email, membership: a.membership });
    if (result.error) return respond(result);
    return NextResponse.json({ document: serializeDocument(result.document) });
  } catch (err) { return fail(err, "retry POST"); }
}
