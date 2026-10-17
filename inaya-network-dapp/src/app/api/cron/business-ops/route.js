// app/api/cron/business-ops/route.js
//
// GET /api/cron/business-ops — daily, same CRON_SECRET bearer-token check as
// every other cron route. Runs two independent jobs; one failing never
// stops the other, and each reports its own result:
//   taskReminders  "due tomorrow" / "overdue" notices (lib/business-notify.js)
//   autoReorder    draft purchase requests for opted-in low-stock products
//                  (lib/inventory-reorder.js)

import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { runTaskReminders } from "../../../../lib/business-notify.js";
import { runAutoReorder } from "../../../../lib/inventory-reorder.js";

async function runJob(fn) {
  try {
    return { ok: true, ...(await fn()) };
  } catch (err) {
    console.error("cron/business-ops job failed:", err);
    return { ok: false, error: err.message };
  }
}

export async function GET(request) {
  if (!isAuthorizedCron(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const taskReminders = await runJob(() => runTaskReminders());
  const autoReorder = await runJob(() => runAutoReorder());
  return NextResponse.json({ success: taskReminders.ok && autoReorder.ok, taskReminders, autoReorder });
}
