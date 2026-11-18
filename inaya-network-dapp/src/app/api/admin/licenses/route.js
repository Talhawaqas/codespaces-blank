// app/api/admin/licenses/route.js -- Inaya Admin Portal: License Manager list (SOW 6.1, 6.2). Admin session only.
//   GET ?status=&cycle=&plan=&currency=&method=&q=&dueFrom=&dueTo=&graceFrom=&graceTo=&activatedFrom=&activatedTo=&renewalsWithinDays=&page=&pageSize=
//       -> { summary, total, page, pageSize, rows, plans, pkPackages }
//   GET ?companies=<name or id>  -> companies for the "assign a license" picker
import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../lib/admin-auth";
import { listLicenses, licenseSummary, searchCompanies, PLAN_OPTIONS, filtersFrom } from "../../../../lib/licensing/admin.js";
import { PK_PACKAGES } from "../../../../lib/pkPricing.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  if (!isAdminAuthenticated(req)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const url = new URL(req.url);
    if (url.searchParams.has("companies")) return NextResponse.json({ companies: await searchCompanies(url.searchParams.get("companies")) });
    const filters = filtersFrom(url);
    const [list, summary] = await Promise.all([
      listLicenses(filters, { page: url.searchParams.get("page"), pageSize: url.searchParams.get("pageSize") }),
      licenseSummary({}, { renewalDays: Number(url.searchParams.get("renewalDays")) || 30 }),
    ]);
    return NextResponse.json({ summary, ...list, filters, plans: PLAN_OPTIONS(), pkPackages: PK_PACKAGES });
  } catch (err) {
    console.error("admin/licenses GET failed:", err?.message);
    return NextResponse.json({ error: "Could not load licenses." }, { status: 500 });
  }
}
