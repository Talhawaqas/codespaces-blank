// GET  /api/orgs/documents-automation/templates/[templateId]/versions?orgId=   -> every version, newest first
// POST /api/orgs/documents-automation/templates/[templateId]/versions   { orgId, spec, changeNote? }   -> a new DRAFT version
import { authed, fail, respond, readJson, limited } from "../../../_lib.js";
import { listTemplateVersions, createTemplateVersion } from "../../../../../../../lib/documentAutomation/templateStore.js";

export const dynamic = "force-dynamic";

export async function GET(req, { params }) {
  try {
    const templateId = decodeURIComponent((await params).templateId);
    const orgId = new URL(req.url).searchParams.get("orgId");
    const a = await authed(req, orgId);
    if (a.response) return a.response;
    return respond(await listTemplateVersions({ orgId, templateId }));
  } catch (err) { return fail(err, "template versions GET"); }
}

export async function POST(req, { params }) {
  try {
    const templateId = decodeURIComponent((await params).templateId);
    const j = await readJson(req);
    if (j.error) return respond(j);
    const a = await authed(req, j.body.orgId);
    if (a.response) return a.response;
    const rl = await limited(req, { action: "template-write", max: 60, key: a.email });
    if (rl) return rl;
    return respond(await createTemplateVersion({ orgId: j.body.orgId, templateId, spec: j.body.spec, changeNote: j.body.changeNote, membership: a.membership, actorEmail: a.email }), 201);
  } catch (err) { return fail(err, "template versions POST"); }
}
