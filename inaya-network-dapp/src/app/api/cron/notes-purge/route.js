// app/api/cron/notes-purge/route.js
//
// GET /api/cron/notes-purge -- nightly (CRON_SECRET bearer, same pattern as the other cron routes). Permanently removes Secure Notes that have
// sat in the trash longer than the retention period (30 days). Only ciphertext and keys exist server side, so nothing readable is touched.

import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { purgeTrashedNotes } from "../../../../lib/notes/notes.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  if (!isAuthorizedCron(request.headers.get("authorization"))) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  try { return NextResponse.json({ success: true, ...(await purgeTrashedNotes()) }); }
  catch (err) { console.error("cron/notes-purge failed:", err); return NextResponse.json({ success: false, error: "Purge failed." }, { status: 500 }); }
}
