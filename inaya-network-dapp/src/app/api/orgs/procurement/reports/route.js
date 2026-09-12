// app/api/orgs/procurement/reports/route.js
//
// GET /api/orgs/procurement/reports?orgId=&type=open-pos|closed-pos|po-by-vendor|po-by-department|ar-payment-history&format=json|csv
//
// Same hand-built-CSV pattern as api/orgs/finance/reports/route.js — no
// new library. "po-by-department" is this report's stand-in for the
// SOW's "List PO by Customers" (a PO has no customer relationship in this
// data model; the requesting department is the closest internal
// analogue). "ar-payment-history" is genuinely accounts-receivable — the
// existing payments ledger's INCOMING entries against invoices, distinct
// from every other report here (all accounts-payable/PO-side).

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, toObjectId } from "../../../../../lib/orgs.js";
import { getAccessibleScope } from "../../../../../lib/document-permissions.js";

const REPORT_TYPES = ["open-pos", "closed-pos", "po-by-vendor", "po-by-department", "ar-payment-history"];
const OPEN_STATUSES = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "ORDERED", "PARTIALLY_RECEIVED"];
const CLOSED_STATUSES = ["RECEIVED", "REJECTED", "CANCELLED"];

function csvEscape(value) {
  const str = String(value ?? "");
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}
function toCsv(rows, columns) {
  const header = columns.map(csvEscape).join(",");
  const body = rows.map((row) => columns.map((col) => csvEscape(row[col])).join(",")).join("\n");
  return `${header}\n${body}`;
}
function poTotal(po) {
  return po.items.reduce((s, i) => s + i.quantity * (i.unitPrice || 0), 0);
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const type = searchParams.get("type") || "open-pos";
    const format = searchParams.get("format") || "json";
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    if (!REPORT_TYPES.includes(type)) return NextResponse.json({ error: `type must be one of: ${REPORT_TYPES.join(", ")}` }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
    const supplierNameById = new Map(scope.visibleSuppliers.map((s) => [s._id.toString(), s.name]));
    const deptNameById = new Map(scope.visibleDepartments.map((d) => [d._id.toString(), d.name]));

    let rows, columns, filenamePart;
    if (type === "open-pos" || type === "closed-pos") {
      const statuses = type === "open-pos" ? OPEN_STATUSES : CLOSED_STATUSES;
      rows = scope.visiblePurchaseOrders.filter((po) => statuses.includes(po.status)).map((po) => ({
        supplier: supplierNameById.get(po.supplierId.toString()) || "Unknown", department: deptNameById.get(po.departmentId.toString()) || "Unknown",
        status: po.status, total: poTotal(po).toFixed(2), currency: po.currency || "USD", createdAt: po.createdAt,
      }));
      columns = ["supplier", "department", "status", "total", "currency", "createdAt"];
      filenamePart = type;
    } else if (type === "po-by-vendor" || type === "po-by-department") {
      const keyFn = type === "po-by-vendor" ? (po) => supplierNameById.get(po.supplierId.toString()) || "Unknown" : (po) => deptNameById.get(po.departmentId.toString()) || "Unknown";
      const groups = new Map();
      for (const po of scope.visiblePurchaseOrders) {
        const key = keyFn(po);
        const g = groups.get(key) || { group: key, poCount: 0, totalValue: 0 };
        g.poCount += 1; g.totalValue += poTotal(po);
        groups.set(key, g);
      }
      rows = [...groups.values()].map((g) => ({ ...g, totalValue: g.totalValue.toFixed(2) }));
      columns = ["group", "poCount", "totalValue"];
      filenamePart = type;
    } else {
      const deptIds = scope.visibleDepartments.map((d) => d._id);
      const { payments, invoices } = await getOrgCollections();
      const paymentRows = deptIds.length ? await payments.find({ orgId: toObjectId(orgId), departmentId: { $in: deptIds }, direction: "INCOMING", relatedInvoiceId: { $ne: null }, deletedAt: null }).sort({ paymentDate: -1 }).toArray() : [];
      const invoiceById = new Map((await invoices.find({ _id: { $in: paymentRows.map((p) => p.relatedInvoiceId) } }).toArray()).map((i) => [i._id.toString(), i]));
      rows = paymentRows.map((p) => ({
        invoiceNumber: invoiceById.get(p.relatedInvoiceId.toString())?.invoiceNumber || "Unknown",
        paymentDate: p.paymentDate, amount: p.amount, currency: p.currency, method: p.method || "—",
      }));
      columns = ["invoiceNumber", "paymentDate", "amount", "currency", "method"];
      filenamePart = "ar-payment-history";
    }

    if (format === "csv") {
      const csv = toCsv(rows, columns);
      return new NextResponse(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filenamePart}-${orgId}.csv"` } });
    }
    return NextResponse.json({ type, count: rows.length, rows });
  } catch (err) {
    console.error("orgs/procurement/reports GET failed:", err);
    return NextResponse.json({ error: "Could not generate the report." }, { status: 500 });
  }
}
