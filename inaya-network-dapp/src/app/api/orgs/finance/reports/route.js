// app/api/orgs/finance/reports/route.js
//
// GET /api/orgs/finance/reports?orgId=...&type=revenue|expenses|outstanding&format=json|csv
//
// CSV is hand-built (no runtime CSV/PDF library exists anywhere in this
// app today, confirmed before writing this — a small manual string
// builder needs no new dependency, matching this codebase's consistent
// preference for hand-rolling small utilities over pulling in a
// library). PDF export is explicitly out of scope for this testnet-
// demonstration pass (see BUSINESS_OPERATIONS_FINANCE.md) — no runtime
// PDF generation exists anywhere in this app, and adding one is real new
// scope better done once there's an actual invoice-template design.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessFinance, toObjectId } from "../../../../../lib/orgs.js";
import { getAccessibleScope } from "../../../../../lib/document-permissions.js";

const REPORT_TYPES = ["revenue", "expenses", "outstanding", "paid-unpaid"];

function csvEscape(value) {
  const str = String(value ?? "");
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toCsv(rows, columns) {
  const header = columns.map(csvEscape).join(",");
  const body = rows.map((row) => columns.map((col) => csvEscape(row[col])).join(",")).join("\n");
  return `${header}\n${body}`;
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const type = searchParams.get("type") || "revenue";
    const format = searchParams.get("format") || "json";
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    if (!REPORT_TYPES.includes(type)) return NextResponse.json({ error: `type must be one of: ${REPORT_TYPES.join(", ")}` }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessFinance(auth.membership)) return NextResponse.json({ error: "You don't have finance access." }, { status: 403 });

    const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
    const { visibleInvoices, visibleExpenses } = scope;

    let rows, columns, filenamePart;
    if (type === "revenue") {
      rows = visibleInvoices.filter((i) => i.status === "PAID").map((i) => ({ invoiceNumber: i.invoiceNumber, issueDate: i.issueDate, total: i.total, currency: i.currency }));
      columns = ["invoiceNumber", "issueDate", "total", "currency"];
      filenamePart = "revenue";
    } else if (type === "expenses") {
      rows = visibleExpenses.filter((e) => e.status === "APPROVED").map((e) => ({ vendor: e.vendor, category: e.category, expenseDate: e.expenseDate, amount: e.amount, currency: e.currency }));
      columns = ["vendor", "category", "expenseDate", "amount", "currency"];
      filenamePart = "expenses";
    } else if (type === "outstanding") {
      rows = visibleInvoices.filter((i) => ["SENT", "OVERDUE"].includes(i.status)).map((i) => ({ invoiceNumber: i.invoiceNumber, dueDate: i.dueDate, total: i.total, currency: i.currency, status: i.status }));
      columns = ["invoiceNumber", "dueDate", "total", "currency", "status"];
      filenamePart = "outstanding-invoices";
    } else {
      rows = visibleInvoices.map((i) => ({ invoiceNumber: i.invoiceNumber, status: i.status, total: i.total, currency: i.currency }));
      columns = ["invoiceNumber", "status", "total", "currency"];
      filenamePart = "paid-unpaid";
    }

    const totalAmount = rows.reduce((sum, r) => sum + (Number(r.total ?? r.amount) || 0), 0);

    if (format === "csv") {
      const csv = toCsv(rows, columns);
      return new NextResponse(csv, {
        headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filenamePart}-${orgId}.csv"` },
      });
    }

    return NextResponse.json({ type, count: rows.length, totalAmount, rows });
  } catch (err) {
    console.error("orgs/finance/reports failed:", err);
    return NextResponse.json({ error: "Could not generate the report." }, { status: 500 });
  }
}
