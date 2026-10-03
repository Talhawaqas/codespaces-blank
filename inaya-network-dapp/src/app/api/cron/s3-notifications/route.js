// GET /api/cron/s3-notifications -- every 2 minutes (vercel.json). Delivers due S3 event notifications with
// backoff and dead-letters the ones that exhaust their attempts (see lib/s3-compat/notifications.js).

import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { processNotificationDeliveries } from "../../../../lib/s3-compat/notifications.js";

export const maxDuration = 60;

export async function GET(request) {
  if (!isAuthorizedCron(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await processNotificationDeliveries({ limit: 40 });
    if (result.delivered || result.failed || result.dead) console.log("[s3-notifications]", JSON.stringify(result));
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error("cron/s3-notifications failed:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
