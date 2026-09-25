// GET /api/orgs/documents-automation/sources?orgId=&documentType=
//   -> the records the caller may generate this type of document from
//      (Create Document -> Select Type -> Select Record). Permission-scoped
//      by getAccessibleScope(), so it can never list a record the caller
//      couldn't already see on its own module's view.
import { NextResponse } from "next/server";
import { authed, fail, respond } from "../_lib.js";
import { listSourceRecords } from "../../../../../lib/documentAutomation/adapters.js";
import { getDocumentType } from "../../../../../lib/documentAutomation/documentTypes.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const sp = new URL(req.url).searchParams;
    const a = await authed(req, sp.get("orgId"));
    if (a.response) return a.response;
    const type = sp.get("documentType");
    if (!getDocumentType(type)) return respond({ error: "Unknown document type.", status: 400 });
    const records = await listSourceRecords({ orgId: sp.get("orgId"), membership: a.membership, email: a.email, documentType: type });
    return NextResponse.json({ records });
  } catch (err) { return fail(err, "sources GET"); }
}
