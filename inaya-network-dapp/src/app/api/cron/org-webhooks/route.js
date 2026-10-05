// GET /api/cron/org-webhooks -- delivery worker for the organization webhook registry (CRON_SECRET bearer, like the other cron routes).
import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { processDeliveries } from "../../../../lib/webhooks/registry.js";
export const dynamic = "force-dynamic";
export async function GET(request) {
  if (!isAuthorizedCron(request.headers.get("authorization"))) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  try { return NextResponse.json({ success: true, ...(await processDeliveries({ limit: 50 })) }); }
  catch (err) { console.error("cron/org-webhooks failed:", err); return NextResponse.json({ success: false, error: "Worker failed." }, { status: 500 }); }
}
