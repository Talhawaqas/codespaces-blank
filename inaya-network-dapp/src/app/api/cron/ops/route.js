// app/api/cron/ops/route.js -- Manage Orders: every 15 minutes, same CRON_SECRET check as every other cron route.
//   pm          preventive-maintenance Work Orders that are due (idempotent per template + due date)
//   exceptions  review items: clocked in with no job started, scheduled job not started, paused too long, many
//               attendance corrections. Review signals only -- never pay deductions or discipline.
// Each job reports its own result; one failing never stops the other. Companies without the entitlement are skipped.
import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { generateAllPm } from "../../../../lib/ops/pm.js";
import { scanAllExceptions } from "../../../../lib/ops/activity.js";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
async function run(fn) { try { return { ok: true, ...(await fn()) }; } catch (e) { console.error("cron/ops job failed:", e?.message); return { ok: false, error: e.message }; } }
export async function GET(req) {
  if (!isAuthorizedCron(req.headers.get("authorization"))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const now = new Date();
  return NextResponse.json({ pm: await run(() => generateAllPm(now)), exceptions: await run(() => scanAllExceptions(now)) });
}
