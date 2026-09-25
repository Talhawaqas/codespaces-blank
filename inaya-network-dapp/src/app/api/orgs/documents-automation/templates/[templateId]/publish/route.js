// POST /api/orgs/documents-automation/templates/[templateId]/publish   { orgId, version }
//   -> DRAFT -> PUBLISHED (atomic; immutable afterwards). Concurrent publishes: exactly one wins.
import { authed, fail, respond, readJson, limited } from "../../../_lib.js";
import { publishTemplate } from "../../../../../../../lib/documentAutomation/templateStore.js";

export const dynamic = "force-dynamic";

export async function POST(req, { params }) {
  try {
    const templateId = decodeURIComponent((await params).templateId);
    const j = await readJson(req);
    if (j.error) return respond(j);
    const a = await authed(req, j.body.orgId);
    if (a.response) return a.response;
    const rl = await limited(req, { action: "template-write", max: 60, key: a.email });
    if (rl) return rl;
    return respond(await publishTemplate({ orgId: j.body.orgId, templateId, version: j.body.version, membership: a.membership, actorEmail: a.email }));
  } catch (err) { return fail(err, "template publish POST"); }
}
