// GET  /api/orgs/finance/ledger/accounts?orgId=...   -> chart of accounts
// POST /api/orgs/finance/ledger/accounts  { orgId, code, name, type }  -> add an account
import { NextResponse } from "next/server";
import { listAccounts, createAccount } from "../../../../../../lib/ledger.js";
import { ledgerAuth } from "../_lib.js";

const serialize = (a) => ({ code: a.code, name: a.name, type: a.type, system: !!a.system });

export async function GET(req) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    const { response } = await ledgerAuth(req, orgId);
    if (response) return response;
    return NextResponse.json({ accounts: (await listAccounts(orgId)).map(serialize) });
  } catch (err) {
    console.error("ledger/accounts GET failed:", err);
    return NextResponse.json({ error: "Could not load the chart of accounts." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    const { response, auth } = await ledgerAuth(req, body.orgId, { write: true });
    if (response) return response;
    const result = await createAccount({ orgId: body.orgId, code: body.code, name: body.name, type: body.type, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(serialize(result.account));
  } catch (err) {
    console.error("ledger/accounts POST failed:", err);
    return NextResponse.json({ error: "Could not create the account." }, { status: 500 });
  }
}
