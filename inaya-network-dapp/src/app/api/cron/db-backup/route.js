// GET /api/cron/db-backup
// Daily encrypted snapshot of the whole database to Vercel Blob (src/lib/dbBackup.js).
// Same Vercel Cron gate as every other route under api/cron/* (Authorization: Bearer $CRON_SECRET).

import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { runDbBackup } from "../../../../lib/dbBackup.js";
import { sendEmail } from "../../../../lib/email.js";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request) {
  if (!isAuthorizedCron(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runDbBackup();
    console.log(`[db-backup] ${result.collections} collections, ${result.documents} documents, ${result.bytes} bytes, pruned ${result.pruned}`);
    return NextResponse.json({ success: true, ...result, url: undefined });
  } catch (err) {
    console.error("cron/db-backup failed:", err);
    // A failed backup must not go unnoticed.
    await sendEmail({ to: "contact@inayanetwork.com", subject: "Inaya daily database backup FAILED", text: `The daily database backup failed at ${new Date().toISOString()}:\n\n${err.message}\n\nCheck the Vercel logs for /api/cron/db-backup.` }).catch(() => {});
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
