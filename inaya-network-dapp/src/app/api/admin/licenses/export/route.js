// app/api/admin/licenses/export/route.js -- GET (same filters as the list) -> a real .xlsx workbook (SOW 13.3, 13.4):
// License Register, Payment History, License Activity, Summary and About (export time + filters). Admin only; every
// export is recorded (who, when, which filters).
import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../../lib/admin-auth";
import { buildLicenseWorkbook, filtersFrom } from "../../../../../lib/licensing/admin.js";
import { licenseCollections } from "../../../../../lib/licensing/service.js";
import { adminActorName } from "../../../../../lib/licensing/config.js";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req) {
  if (!isAdminAuthenticated(req)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const filters = filtersFrom(new URL(req.url));
    const { buffer, filename, counts } = await buildLicenseWorkbook(filters);
    const { ledger } = await licenseCollections();
    await ledger.insertOne({ kind: "license_event", orgId: null, eventType: "license_report_exported", actorType: "admin", actorId: adminActorName(), source: "admin_portal", at: new Date().toISOString(), createdAt: new Date().toISOString(), metadata: { filters, ...counts } });
    return new Response(buffer, { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("admin/licenses/export failed:", err?.message);
    import("../../../../../lib/metrics/metrics.js").then((m) => m.metric?.("license.payment", { label: "report_failed" })).catch(() => {});
    return NextResponse.json({ error: "Could not build the workbook." }, { status: 500 });
  }
}
