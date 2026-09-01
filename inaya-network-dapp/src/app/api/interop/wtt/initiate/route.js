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
import { recordInteropTransferInitiated } from "@/lib/interopTransfers";

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

    const transferId = randomUUID();
    await recordInteropTransferInitiated({ transferId, provider: "wormhole", sourceChain, destChain, sourceTxHash, userAddress, amount });

    return NextResponse.json({ success: true, transferId });
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
