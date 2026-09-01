// app/api/backup/replicate-shard/route.js
//
// POST /api/backup/replicate-shard
// Body: { fileHash, shardId ('alpha'|'beta'), content, primaryProvider, primaryCid }
//
// Called by api/upload/route.js right after its own primary Pinata pin succeeds -- fans out to
// every other configured pinning provider (backupEngine.js/pinningProviders/*.js), best-effort.
// Deliberately not wallet-signature-authenticated: this only ever runs as a same-request,
// server-to-server follow-up to an upload that already happened, carries no user-facing mutation
// beyond "replicate this ciphertext I was already given," and the content itself is already
// encrypted ciphertext -- there's nothing here a signature check would additionally protect that
// the upload route's own flow doesn't already gate.

import { NextResponse } from "next/server";
import { replicateShard } from "../../../../lib/backupEngine";

export async function POST(request) {
  try {
    const { fileHash, shardId, content, primaryProvider, primaryCid } = await request.json();
    if (!fileHash || !shardId || !content || !primaryProvider || !primaryCid) {
      return NextResponse.json({ error: "fileHash, shardId, content, primaryProvider, and primaryCid are all required." }, { status: 400 });
    }
    const result = await replicateShard({ fileHash, shardId, content, primaryProvider, primaryCid });
    return NextResponse.json(result);
  } catch (err) {
    console.error("backup/replicate-shard failed:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
