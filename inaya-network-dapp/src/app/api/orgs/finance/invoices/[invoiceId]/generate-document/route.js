// app/api/orgs/finance/invoices/[invoiceId]/generate-document/route.js
//
// POST /api/orgs/finance/invoices/[invoiceId]/generate-document  { orgId, idempotencyKey?, forceNewVersion?, templateId?, locale? }
// GET  /api/orgs/finance/invoices/[invoiceId]/generate-document?orgId=
//
// The invoice-centric entry point kept for the Finance invoice screen. It is a
// thin wrapper over the same engine every document type uses
// (documentAutomation/pipeline.js) -- generation is idempotent, numbered,
// evidence-recorded and stored encrypted; approval/finalization/delivery live
// in the Documents view and the /api/orgs/documents-automation endpoints.
import { NextResponse } from "next/server";
import { authed, fail, respond, readJson, limited } from "../../../../documents-automation/_lib.js";
import { createDocument, listDocuments } from "../../../../../../../lib/documentAutomation/pipeline.js";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req, { params }) {
  try {
    const { invoiceId } = await params;
    const j = await readJson(req);
    if (j.error) return respond(j);
    const { orgId, idempotencyKey, forceNewVersion, templateId, locale } = j.body;
    const a = await authed(req, orgId);
    if (a.response) return a.response;
    const rl = await limited(req, { action: "generate", max: 30, key: a.email });
    if (rl) return rl;
    const result = await createDocument({ orgId, documentType: "invoice", sourceId: invoiceId, templateId, locale, membership: a.membership, email: a.email, idempotencyKey, forceNewVersion: forceNewVersion === true });
    return respond(result, result.idempotentReplay ? 200 : 201);
  } catch (err) { return fail(err, "invoice generate-document POST"); }
}

export async function GET(req, { params }) {
  try {
    const { invoiceId } = await params;
    const orgId = new URL(req.url).searchParams.get("orgId");
    const a = await authed(req, orgId);
    if (a.response) return a.response;
    const { documents } = await listDocuments({ orgId, membership: a.membership, email: a.email, documentType: "invoice", sourceRecordType: "INVOICE", sourceRecordId: invoiceId });
    return NextResponse.json({ documents });
  } catch (err) { return fail(err, "invoice generate-document GET"); }
}
