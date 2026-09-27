// POST /api/interop/wtt/initiate
//
// Records an interop-layer (Wormhole WTT) transfer the user just submitted on-chain from their
// own wallet -- mirrors POST /api/bridge/initiate-transfer's role for the native bridge exactly:
// the client already paid gas and got a real sourceTxHash, this route just starts tracking it.
// The actual destination-side completion is handled by GET /api/interop/wtt/relay (cron),
// same "client submits source leg, Inaya's relayer sponsors destination gas" split as the
// existing native bridge.

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { ethers } from "ethers";
import { recordInteropTransferInitiated, getInteropTransferCollections } from "@/lib/interopTransfers";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";

export async function POST(request) {
  try {
    const body = await request.json();
    const { sourceChain, destChain, sourceTxHash, userAddress, amount } = body;
    if (!sourceTxHash || typeof sourceTxHash !== "string") {
      return NextResponse.json({ success: false, error: "sourceTxHash is required" }, { status: 400 });
    }
    if (!sourceChain || !destChain || !userAddress || !amount) {
      return NextResponse.json({ success: false, error: "sourceChain, destChain, userAddress, amount are required" }, { status: 400 });
    }

    // SQA-006 (S3): this route is public and every registration costs the relayer external calls (and gas on completion), so it now
    // validates its input, is rate limited per IP, and registers a given source transaction only once.
    if (!/^0x[0-9a-fA-F]{64}$/.test(sourceTxHash)) return NextResponse.json({ success: false, error: "sourceTxHash must be a 32-byte hex transaction hash" }, { status: 400 });
    if (!ethers.isAddress(userAddress)) return NextResponse.json({ success: false, error: "userAddress is not a valid address" }, { status: 400 });
    if (typeof sourceChain !== "string" || typeof destChain !== "string" || sourceChain.length > 32 || destChain.length > 32) return NextResponse.json({ success: false, error: "sourceChain and destChain must be short strings" }, { status: 400 });
    if (!/^\d+(\.\d+)?$/.test(String(amount)) || Number(amount) <= 0) return NextResponse.json({ success: false, error: "amount must be a positive number" }, { status: 400 });
    try { await checkRateLimit({ action: "interop:wtt-initiate", key: getClientIp(request), max: 30, windowMs: 60 * 60 * 1000 }); }
    catch (err) { return NextResponse.json({ success: false, error: err.message }, { status: 429 }); }
    const { transfers } = await getInteropTransferCollections();
    const existing = await transfers.findOne({ sourceTxHash: sourceTxHash.toLowerCase() }, { projection: { _id: 1 } });
    if (existing) return NextResponse.json({ success: true, transferId: existing._id, existing: true });

    const transferId = randomUUID();
    await recordInteropTransferInitiated({ transferId, provider: "wormhole", sourceChain, destChain, sourceTxHash: sourceTxHash.toLowerCase(), userAddress, amount });

    return NextResponse.json({ success: true, transferId });
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
