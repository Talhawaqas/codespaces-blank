// GET /api/orgs/finance/ledger/reports?orgId=...&type=trial-balance|pnl|balance-sheet&from=&to=&asOf=&format=json|csv
//   Syncs automatic entries first so a report always reflects current records.
import { NextResponse } from "next/server";
import { syncLedger, trialBalance, profitAndLoss, balanceSheet } from "../../../../../../lib/ledger.js";
import { ledgerAuth, toCsv } from "../_lib.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const { response } = await ledgerAuth(req, orgId);
    if (response) return response;
    const type = searchParams.get("type") || "trial-balance";
    const from = searchParams.get("from") || undefined;
    const to = searchParams.get("to") || undefined;
    const asOf = searchParams.get("asOf") || undefined;
    await syncLedger(orgId);

    let report, rows, columns;
    if (type === "trial-balance") {
      report = await trialBalance(orgId, { asOf });
      rows = [...report.rows, { code: "", name: "TOTAL", type: "", debit: report.totalDebit, credit: report.totalCredit }];
      columns = ["code", "name", "type", "debit", "credit"];
    } else if (type === "pnl") {
      report = await profitAndLoss(orgId, { from, to });
      rows = [...report.revenue.map((r) => ({ section: "Revenue", ...r })), ...report.expenses.map((r) => ({ section: "Expenses", ...r })),
        { section: "Net income", code: "", name: "", amount: report.netIncome }];
      columns = ["section", "code", "name", "amount"];
    } else if (type === "balance-sheet") {
      report = await balanceSheet(orgId, { asOf });
      rows = [...report.assets.map((r) => ({ section: "Assets", ...r })), ...report.liabilities.map((r) => ({ section: "Liabilities", ...r })),
        ...report.equity.map((r) => ({ section: "Equity", ...r })), { section: "Equity", code: "", name: "Retained earnings", amount: report.retainedEarnings }];
      columns = ["section", "code", "name", "amount"];
    } else {
      return NextResponse.json({ error: "type must be trial-balance, pnl or balance-sheet." }, { status: 400 });
    }

    if (searchParams.get("format") === "csv") {
      return new NextResponse(toCsv(rows, columns), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${type}.csv"` } });
    }
    return NextResponse.json({ type, ...report });
  } catch (err) {
    console.error("ledger/reports GET failed:", err);
    return NextResponse.json({ error: "Could not build the report." }, { status: 500 });
  }
}
