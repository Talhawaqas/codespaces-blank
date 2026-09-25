// GET /api/orgs/documents-automation/numbers?orgId=&documentType=&fiscalYear=
//   -> the auditable number-allocation ledger and the series report
//      (cancelled / voided / failed numbers and any unaccounted sequence).
import { NextResponse } from "next/server";
import { authed, fail, respond } from "../_lib.js";
import { listNumberLedger, numberSeriesReport } from "../../../../../lib/documentAutomation/numbering.js";
import { canManageFinance } from "../../../../../lib/orgs.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const sp = new URL(req.url).searchParams;
    const orgId = sp.get("orgId");
    const a = await authed(req, orgId);
    if (a.response) return a.response;
    if (!canManageFinance(a.membership)) return respond({ error: "Only a Finance Manager or an owner/admin can view the number ledger.", status: 403 });
    const documentType = sp.get("documentType") || undefined;
    const ledger = await listNumberLedger({ orgId, documentType, fiscalYear: sp.get("fiscalYear") || undefined });
    const report = documentType ? await numberSeriesReport({ orgId, documentType, fiscalYear: sp.get("fiscalYear") || undefined }) : null;
    return NextResponse.json({ ledger: ledger.map((r) => ({ number: r.number, documentType: r.documentType, fiscalYear: r.fiscalYear, sequence: r.sequence, status: r.status, statusReason: r.statusReason, documentId: r.documentId ? String(r.documentId) : null, allocatedAt: r.allocatedAt, statusChangedAt: r.statusChangedAt })), report });
  } catch (err) { return fail(err, "numbers GET"); }
}
