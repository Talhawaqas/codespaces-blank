// GET /api/bridge/transfers/[address]
//
// Public read, like /staking-position/[address]: a wallet's recent bridge transfers (sent by it or
// addressed to it) with their delivery status, so a user can always see where their $INAYA went.
// Everything returned is already public on-chain (addresses, amounts, tx hashes).

import { NextResponse } from "next/server";
import { ethers } from "ethers";
import { getTransfersForUser } from "@/lib/bridge";
import { slidingWindowCheck, getClientIp } from "@/lib/rateLimit";

const PUBLIC_LIMIT = 20;

export async function GET(request, { params }) {
  const { address } = params;
  if (!ethers.isAddress(address)) {
    return NextResponse.json({ success: false, error: "Invalid address" }, { status: 400 });
  }

  const limit = await slidingWindowCheck({ action: "bridge:transfers", key: getClientIp(request), max: 60, windowMs: 60_000 });
  if (!limit.allowed) {
    return NextResponse.json({ success: false, error: "Too many requests" }, { status: 429, headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } });
  }

  try {
    const docs = await getTransfersForUser(address, PUBLIC_LIMIT);
    const transfers = docs.map((d) => ({
      messageHash: d._id,
      kind: d.kind,
      status: d.status,
      sourceChainId: Number(d.sourceChainId),
      destChainId: Number(d.destChainId),
      amount: d.amount,
      sender: d.userAddress && d.userAddress !== ethers.ZeroAddress.toLowerCase() ? d.userAddress : null,
      recipient: d.recipientAddress || null,
      sourceTxHash: d.sourceTxHash || null,
      destTxHash: d.destTxHash || null,
      failureReason: d.failureReason || null,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    }));
    return NextResponse.json({ success: true, transfers });
  } catch (err) {
    console.error("bridge/transfers GET failed:", err);
    return NextResponse.json({ success: false, error: "Could not load transfers" }, { status: 500 });
  }
}
