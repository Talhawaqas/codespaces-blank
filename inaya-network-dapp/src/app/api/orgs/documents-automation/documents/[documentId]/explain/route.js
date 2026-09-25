// GET  /api/orgs/documents-automation/documents/[documentId]/explain?orgId=
//        -> auditable inputs, checks, rules, outputs and evidence (no chain-of-thought).
// POST /api/orgs/documents-automation/documents/[documentId]/explain   { orgId }
//        -> an ADVISORY summary (AI when available and safe, otherwise
//           deterministic). It never changes a total, an approval or evidence.
import { authed, fail, respond, readJson, limited } from "../../../_lib.js";
import { explainDocument, generateAiSummary } from "../../../../../../../lib/documentAutomation/aiAssist.js";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req, { params }) {
  try {
    const { documentId } = await params;
    const orgId = new URL(req.url).searchParams.get("orgId");
    const a = await authed(req, orgId);
    if (a.response) return a.response;
    return respond(await explainDocument({ orgId, documentId, membership: a.membership, email: a.email }));
  } catch (err) { return fail(err, "explain GET"); }
}

export async function POST(req, { params }) {
  try {
    const { documentId } = await params;
    const j = await readJson(req);
    if (j.error) return respond(j);
    const a = await authed(req, j.body.orgId);
    if (a.response) return a.response;
    const rl = await limited(req, { action: "ai-summary", max: 20, key: a.email });
    if (rl) return rl;
    return respond(await generateAiSummary({ orgId: j.body.orgId, documentId, membership: a.membership, email: a.email }));
  } catch (err) { return fail(err, "explain POST"); }
}
