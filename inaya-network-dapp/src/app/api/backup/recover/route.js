// app/api/backup/recover/route.js
//
// POST /api/backup/recover
// Body: { fileHash, address, message, signature, timestamp }
//
// Wallet-signature-authenticated exactly like every other file-keyed metadata mutation in this
// codebase (metadata.js's signMetadataAction pattern) -- reuses the SAME verifyMetadataAuth/
// verifyOnChainFileOwner helper api/metadata/delete-file/route.js already uses, rather than
// reimplementing signature verification a second time. Forces an immediate recovery attempt for
// this one asset instead of waiting for the next cron pass (api/backup/cron/recover runs the
// same underlying logic automatically). Backs custody-sdk's requestRecovery().

import { NextResponse } from "next/server";
import { verifyMetadataAuth, verifyOnChainFileOwner } from "../../../../lib/metadata-auth";
import { requestRecoveryFor } from "../../../../lib/backupEngine";

export async function POST(req) {
  try {
    const { fileHash, address, message, signature, timestamp } = await req.json();
    if (!fileHash) return NextResponse.json({ error: "fileHash is required." }, { status: 400 });

    verifyMetadataAuth({ action: "requestRecovery", resourceId: fileHash, address, message, signature, timestamp });
    await verifyOnChainFileOwner(fileHash, address);

    const status = await requestRecoveryFor(fileHash);
    return NextResponse.json(status);
  } catch (err) {
    console.error("backup/recover failed:", err);
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
}
