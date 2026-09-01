// app/api/backup/status/route.js
//
// GET /api/backup/status?fileHash=0x...
//
// Read-only, unauthenticated (same trust level as metadata/list-files -- a fileHash alone reveals
// no plaintext or anything sensitive beyond "this file exists and its backup health"). Backs
// custody-sdk's getBackupStatus()/getRedundancyStatus().

import { NextResponse } from "next/server";
import { getBackupStatus } from "../../../../lib/backupEngine";

export async function GET(request) {
  try {
    const fileHash = new URL(request.url).searchParams.get("fileHash");
    if (!fileHash) return NextResponse.json({ error: "fileHash is required." }, { status: 400 });
    const status = await getBackupStatus(fileHash);
    return NextResponse.json(status);
  } catch (err) {
    console.error("backup/status failed:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
