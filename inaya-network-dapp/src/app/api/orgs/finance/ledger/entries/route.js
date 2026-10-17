// GET  /api/orgs/finance/ledger/entries?orgId=...&from=&to=&limit=
//        -> posts any missing automatic entries first (idempotent), then lists.
// POST /api/orgs/finance/ledger/entries  { orgId, date, memo, lines:[{accountCode, debit, credit, memo?}] }
//        -> a manual, balanced journal entry (Finance Manager / owner / admin).
import { NextResponse } from "next/server";
import { syncLedger, listEntries, postEntry } from "../../../../../../lib/ledger.js";
import { ledgerAuth, serializeEntry } from "../_lib.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const { response } = await ledgerAuth(req, orgId);
    if (response) return response;
    const sync = await syncLedger(orgId);
    const entries = await listEntries(orgId, { from: searchParams.get("from"), to: searchParams.get("to"), limit: Number(searchParams.get("limit")) || 200 });
    return NextResponse.json({ entries: entries.map(serializeEntry), sync });
  } catch (err) {
    console.error("ledger/entries GET failed:", err);
    return NextResponse.json({ error: "Could not load journal entries." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    const { response, auth } = await ledgerAuth(req, body.orgId, { write: true });
    if (response) return response;
    const result = await postEntry({ orgId: body.orgId, date: body.date, memo: body.memo, lines: body.lines, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(serializeEntry(result.entry));
  } catch (err) {
    console.error("ledger/entries POST failed:", err);
    return NextResponse.json({ error: "Could not post the journal entry." }, { status: 500 });
  }
}
