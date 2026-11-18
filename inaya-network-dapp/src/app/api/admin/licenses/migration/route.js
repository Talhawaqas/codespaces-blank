// app/api/admin/licenses/migration/route.js -- launch migration (License Manager SOW 20). Admin session only.
//   GET                                   -> companies with a pre-license subscription record (read-only report)
//   POST { action: "adopt", orgId, amount?, confirm: true }       -> that record becomes an active license, paid-through kept
//   POST { action: "bulk", rows: [...], preview: true }            -> validates every row, changes nothing
//   POST { action: "bulk", rows: [...], preview: false, confirm }  -> assigns each valid row (awaiting first payment)
import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../../lib/admin-auth";
import { adoptLegacySubscription, bulkAssign, legacySubscriptions, LicenseError } from "../../../../../lib/licensing/service.js";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req) {
  if (!isAdminAuthenticated(req)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try { return NextResponse.json({ legacy: await legacySubscriptions() }); }
  catch (err) { console.error("admin/licenses/migration GET failed:", err?.message); return NextResponse.json({ error: "Could not load the migration report." }, { status: 500 }); }
}

export async function POST(req) {
  if (!isAdminAuthenticated(req)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  let b = {}; try { b = await req.json(); } catch { b = {}; }
  try {
    if (b.action === "adopt") {
      if (b.confirm !== true) return NextResponse.json({ error: "Confirm this change first.", code: "CONFIRM_REQUIRED" }, { status: 400 });
      return NextResponse.json(JSON.parse(JSON.stringify(await adoptLegacySubscription({ orgId: b.orgId, amount: b.amount ?? null }))));
    }
    if (b.action === "bulk") {
      const preview = b.preview !== false;
      if (!preview && b.confirm !== true) return NextResponse.json({ error: "Confirm this change first.", code: "CONFIRM_REQUIRED" }, { status: 400 });
      return NextResponse.json(await bulkAssign({ rows: b.rows, preview }));
    }
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (err) {
    if (err instanceof LicenseError || err?.status) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status || 400 });
    console.error("admin/licenses/migration POST failed:", err?.message);
    return NextResponse.json({ error: "The change could not be saved. Nothing was changed." }, { status: 500 });
  }
}
