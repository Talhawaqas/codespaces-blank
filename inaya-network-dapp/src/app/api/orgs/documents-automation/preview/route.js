// POST /api/orgs/documents-automation/preview
//   { orgId, documentType, sourceId, options?, templateId?, templateVersion?, locale?, pageSize? }
//   -> a watermarked PREVIEW PDF (base64) with calculations and validation
//      warnings. Allocates no number, stores nothing, writes no evidence.
import { authed, fail, respond, readJson, limited } from "../_lib.js";
import { previewDocument } from "../../../../../lib/documentAutomation/pipeline.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req) {
  try {
    const j = await readJson(req);
    if (j.error) return respond(j);
    const { orgId, documentType, sourceId, options, templateId, templateVersion, locale, pageSize } = j.body;
    const a = await authed(req, orgId);
    if (a.response) return a.response;
    const rl = await limited(req, { action: "preview", max: 60, key: a.email });
    if (rl) return rl;
    if (!documentType || !sourceId) return respond({ error: "documentType and sourceId are required.", status: 400 });
    return respond(await previewDocument({ orgId, documentType, sourceId: String(sourceId), options, templateId, templateVersion, locale, pageSize, membership: a.membership, email: a.email }));
  } catch (err) { return fail(err, "preview POST"); }
}
