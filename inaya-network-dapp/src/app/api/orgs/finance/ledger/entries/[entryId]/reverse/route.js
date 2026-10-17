// POST /api/orgs/finance/ledger/entries/:entryId/reverse  { orgId, date? }
//   -> posts the reversing entry (once; a repeat returns the same reversal).
import { NextResponse } from "next/server";
import { reverseEntry } from "../../../../../../../../lib/ledger.js";
import { ledgerAuth, serializeEntry } from "../../../_lib.js";

export async function POST(req, { params }) {
  try {
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    const { response, auth } = await ledgerAuth(req, body.orgId, { write: true });
    if (response) return response;
    const { entryId } = await params;
    const result = await reverseEntry({ orgId: body.orgId, entryId, date: body.date, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ created: result.created, entry: serializeEntry(result.entry) });
  } catch (err) {
    console.error("ledger/entries/[entryId]/reverse failed:", err);
    return NextResponse.json({ error: "Could not reverse the entry." }, { status: 500 });
  }
}
