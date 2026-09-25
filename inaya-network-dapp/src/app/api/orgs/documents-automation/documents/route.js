// GET  /api/orgs/documents-automation/documents?orgId=&documentType=&status=&q=&sourceRecordId=&limit=&skip=
//        -> permission-aware list / search of generated documents.
// POST /api/orgs/documents-automation/documents
//        { orgId, documentType, sourceId, options?, templateId?, templateVersion?, locale?, pageSize?, idempotencyKey?, forceNewVersion? }
//        -> generates (idempotently) a document; returns the document and its validation report.
import { NextResponse } from "next/server";
import { authed, fail, respond, readJson, limited } from "../_lib.js";
import { createDocument, listDocuments } from "../../../../../lib/documentAutomation/pipeline.js";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req) {
  try {
    const sp = new URL(req.url).searchParams;
    const orgId = sp.get("orgId");
    const a = await authed(req, orgId);
    if (a.response) return a.response;
    const limit = Number(sp.get("limit") || 50);
    const skip = Number(sp.get("skip") || 0);
    const result = await listDocuments({
      orgId, membership: a.membership, email: a.email, documentType: sp.get("documentType") || undefined, status: sp.get("status") || undefined,
      sourceRecordType: sp.get("sourceRecordType") || undefined, sourceRecordId: sp.get("sourceRecordId") || undefined, q: sp.get("q") || undefined,
      limit: Number.isFinite(limit) ? limit : 50, skip: Number.isFinite(skip) ? skip : 0,
    });
    return NextResponse.json(result);
  } catch (err) { return fail(err, "documents GET"); }
}

export async function POST(req) {
  try {
    const j = await readJson(req);
    if (j.error) return respond(j);
    const { orgId, documentType, sourceId, options, templateId, templateVersion, locale, pageSize, idempotencyKey, forceNewVersion } = j.body;
    const a = await authed(req, orgId);
    if (a.response) return a.response;
    const rl = await limited(req, { action: "generate", max: 30, key: a.email });
    if (rl) return rl;
    if (!documentType || !sourceId) return respond({ error: "documentType and sourceId are required.", status: 400 });
    const result = await createDocument({ orgId, documentType, sourceId: String(sourceId), options, templateId, templateVersion, locale, pageSize, membership: a.membership, email: a.email, idempotencyKey, forceNewVersion: forceNewVersion === true });
    return respond(result, result.idempotentReplay ? 200 : 201);
  } catch (err) { return fail(err, "documents POST"); }
}
