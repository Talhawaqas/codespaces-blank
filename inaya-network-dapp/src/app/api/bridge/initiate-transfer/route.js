// POST /api/bridge/initiate-transfer
//
// Public. The user's wallet has ALREADY sent the on-chain lock/burn tx client-side (same
// pattern as page.js's client-signed staking calls) -- this route just registers the pending
// transfer doc so the status tracker has something to poll immediately, before the cron
// indexer even picks up the on-chain event.
//
// Body: { messageHash, sourceChainId, destChainId, amount, userAddress, sourceTxHash, kind }

import { NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";
import { recordTransferInitiated, validateTransferInput } from "@/lib/bridge";

export async function POST(request) {
  try {
    const body = await request.json();
    const { messageHash, sourceChainId, destChainId, amount, userAddress, sourceTxHash, kind, message } = body;

    if (!messageHash || typeof messageHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(messageHash)) {
      return NextResponse.json({ success: false, error: "messageHash is required and must be a 32-byte hex value" }, { status: 400 });
    }
    // SQA-005/006: public write route -- rate limited per IP; the document it creates is untrusted until the source chain confirms it
    try { await checkRateLimit({ action: "bridge:register", key: getClientIp(request), max: 60, windowMs: 60 * 60 * 1000 }); }
    catch (err) { return NextResponse.json({ success: false, error: err.message }, { status: 429 }); }
    validateTransferInput({ sourceChainId, destChainId, amount, userAddress });

    await recordTransferInitiated({ messageHash, sourceChainId, destChainId, amount, userAddress, sourceTxHash, kind, message });

    return NextResponse.json({ success: true, messageHash });
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 400 });
  }
}
