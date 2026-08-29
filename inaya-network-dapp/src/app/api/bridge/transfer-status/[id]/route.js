// GET /api/bridge/transfer-status/[id]
//
// Public. `id` = messageHash. This Mongo doc, not on-chain state, is the actual source of truth
// the dApp polls for pending/completed/failed -- see CROSS_CHAIN_BRIDGE_GUIDE.md's "no on-chain
// ack" design note.

import { NextResponse } from "next/server";
import { getTransferStatus } from "@/lib/bridge";

export async function GET(request, { params }) {
  const { id } = params;
  const doc = await getTransferStatus(id);
  if (!doc) {
    return NextResponse.json({ success: false, error: "Unknown messageHash" }, { status: 404 });
  }
  return NextResponse.json({ success: true, transfer: doc });
}
