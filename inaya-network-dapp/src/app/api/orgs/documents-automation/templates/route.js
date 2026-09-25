// GET  /api/orgs/documents-automation/templates?orgId=&documentType=&includeArchived=1
//        -> system + organization templates (with specs).
// POST /api/orgs/documents-automation/templates
//        { orgId, spec } or { orgId, cloneFrom: "system:standard-invoice", name? }
//        -> a new DRAFT template (owner/admin only). The spec is validated by
//           the safe template language before it is ever stored.
import { NextResponse } from "next/server";
import { authed, fail, respond, readJson, limited } from "../_lib.js";
import { listTemplates, createTemplate } from "../../../../../lib/documentAutomation/templateStore.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const sp = new URL(req.url).searchParams;
    const orgId = sp.get("orgId");
    const a = await authed(req, orgId);
    if (a.response) return a.response;
    return NextResponse.json({ templates: await listTemplates({ orgId, documentType: sp.get("documentType") || undefined, includeArchived: sp.get("includeArchived") === "1" }) });
  } catch (err) { return fail(err, "templates GET"); }
}

export async function POST(req) {
  try {
    const j = await readJson(req);
    if (j.error) return respond(j);
    const { orgId, spec, cloneFrom, name } = j.body;
    const a = await authed(req, orgId);
    if (a.response) return a.response;
    const rl = await limited(req, { action: "template-write", max: 60, key: a.email });
    if (rl) return rl;
    return respond(await createTemplate({ orgId, spec, cloneFromTemplateId: cloneFrom, name, membership: a.membership, actorEmail: a.email }), 201);
  } catch (err) { return fail(err, "templates POST"); }
}
