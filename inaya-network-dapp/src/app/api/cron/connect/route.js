// app/api/cron/connect/route.js -- Inaya Connect safety net (CRON_SECRET like every other cron): processes inbound
// WhatsApp messages left PENDING (the after-response step timed out or failed) or whose processing lease expired.
import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { processPending } from "../../../../lib/connect/process.js";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
export async function GET(req) {
  if (!isAuthorizedCron(req.headers.get("authorization"))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { return NextResponse.json({ ok: true, ...(await processPending({ limit: 50 })) }); }
  catch (e) { console.error("cron/connect failed:", e?.message); return NextResponse.json({ ok: false, error: e.message }, { status: 500 }); }
}
