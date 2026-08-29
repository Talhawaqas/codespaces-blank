// POST /api/bridge/claim
//
// Public. Same pattern as /api/bridge/unstake, for InayaStaking.claimRewardTo(...).
//
// Body: { messageHash, destChainId, amount, userAddress, sourceTxHash }

import { NextResponse } from "next/server";
import { recordTransferInitiated, validateTransferInput } from "@/lib/bridge";
import { CHAIN_IDS } from "@/lib/chains";

export async function POST(request) {
  try {
    const body = await request.json();
    const { messageHash, destChainId, amount, userAddress, sourceTxHash, message } = body;
    if (!messageHash || typeof messageHash !== "string") {
      return NextResponse.json({ success: false, error: "messageHash is required" }, { status: 400 });
    }
    validateTransferInput({ sourceChainId: CHAIN_IDS.BSC_TESTNET, destChainId, amount, userAddress });

    await recordTransferInitiated({
      messageHash,
      sourceChainId: CHAIN_IDS.BSC_TESTNET,
      destChainId,
      amount,
      userAddress,
      sourceTxHash,
      kind: "claim",
      message,
    });

    return NextResponse.json({ success: true, messageHash });
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 400 });
  }
}
