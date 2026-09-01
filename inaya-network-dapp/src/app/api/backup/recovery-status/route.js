// app/api/backup/recovery-status/route.js
//
// GET /api/backup/recovery-status?fileHash=0x...
//
// Read-only, unauthenticated. Backs custody-sdk's getRecoveryStatus().

import { NextResponse } from "next/server";
import { getRecoveryStatus } from "../../../../lib/backupEngine";

export async function GET(request) {
  try {
    const fileHash = new URL(request.url).searchParams.get("fileHash");
    if (!fileHash) return NextResponse.json({ error: "fileHash is required." }, { status: 400 });
    const status = await getRecoveryStatus(fileHash);
    return NextResponse.json(status);
  } catch (err) {
    console.error("backup/recovery-status failed:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
