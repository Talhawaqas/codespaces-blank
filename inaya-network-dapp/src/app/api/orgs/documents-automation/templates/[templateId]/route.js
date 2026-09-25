// GET    /api/orgs/documents-automation/templates/[templateId]?orgId=&version=
// PATCH  /api/orgs/documents-automation/templates/[templateId]   { orgId, version, spec, changeNote? }   (DRAFT only)
// DELETE /api/orgs/documents-automation/templates/[templateId]?orgId=&version=   (archives; history is kept)
// templateId is "system:<key>" or "org:<key>" (URL-encode the colon).
import { NextResponse } from "next/server";
import { authed, fail, respond, readJson, limited } from "../../_lib.js";
import { getTemplate, updateTemplateDraft, archiveTemplate } from "../../../../../../lib/documentAutomation/templateStore.js";

export const dynamic = "force-dynamic";

export async function GET(req, { params }) {
  try {
    const templateId = decodeURIComponent((await params).templateId);
    const sp = new URL(req.url).searchParams;
    const a = await authed(req, sp.get("orgId"));
    if (a.response) return a.response;
    const got = await getTemplate({ orgId: sp.get("orgId"), templateId, version: sp.get("version") ?? undefined, allowDraft: true });
    if (got.error) return respond(got);
    return NextResponse.json({ template: got.template });
  } catch (err) { return fail(err, "template GET"); }
}

export async function PATCH(req, { params }) {
  try {
    const templateId = decodeURIComponent((await params).templateId);
    const j = await readJson(req);
    if (j.error) return respond(j);
    const a = await authed(req, j.body.orgId);
    if (a.response) return a.response;
    const rl = await limited(req, { action: "template-write", max: 60, key: a.email });
    if (rl) return rl;
    return respond(await updateTemplateDraft({ orgId: j.body.orgId, templateId, version: j.body.version, spec: j.body.spec, changeNote: j.body.changeNote, membership: a.membership, actorEmail: a.email }));
  } catch (err) { return fail(err, "template PATCH"); }
}

export async function DELETE(req, { params }) {
  try {
    const templateId = decodeURIComponent((await params).templateId);
    const sp = new URL(req.url).searchParams;
    const a = await authed(req, sp.get("orgId"));
    if (a.response) return a.response;
    return respond(await archiveTemplate({ orgId: sp.get("orgId"), templateId, version: sp.get("version") ?? undefined, membership: a.membership, actorEmail: a.email }));
  } catch (err) { return fail(err, "template DELETE"); }
}
