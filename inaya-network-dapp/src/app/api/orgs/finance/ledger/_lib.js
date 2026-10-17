// Shared auth for the ledger routes: reading needs finance access,
// writing needs finance-manager rights (same gates as the rest of Finance).
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessFinance, canManageFinance } from "../../../../../lib/orgs.js";

export async function ledgerAuth(req, orgId, { write = false } = {}) {
  if (!orgId) return { response: NextResponse.json({ error: "orgId is required." }, { status: 400 }) };
  await ensureOrgIndexes();
  const auth = await requireMembership(req, orgId);
  if (auth.error) return { response: NextResponse.json({ error: auth.error }, { status: auth.status }) };
  const allowed = write ? canManageFinance(auth.membership) : canAccessFinance(auth.membership);
  if (!allowed) {
    return { response: NextResponse.json({ error: write ? "Only a Finance Manager or an owner/admin can change the ledger." : "Only Finance roles can view the ledger." }, { status: 403 }) };
  }
  return { auth };
}

export function serializeEntry(e) {
  return {
    id: e._id.toString(), date: e.date, memo: e.memo, total: e.total, lines: e.lines,
    source: e.source || null, reversalOf: e.reversalOf ? e.reversalOf.toString() : null,
    postedByEmail: e.postedByEmail, createdAt: e.createdAt,
  };
}

export function toCsv(rows, columns) {
  const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => esc(r[c])).join(","))].join("\n");
}
