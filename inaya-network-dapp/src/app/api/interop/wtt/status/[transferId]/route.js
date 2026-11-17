// GET /api/interop/wtt/status/[transferId]
//
// Public. Mirrors GET /api/bridge/transfer-status/[id]'s role for the native bridge --
// polled by the frontend after a client-submitted interop transfer to show live status.

import { NextResponse } from "next/server";
import { getInteropTransferStatus } from "@/lib/interopTransfers";

export async function GET(request, { params }) {
  params = await params; // Next.js 15: params is a Promise (SQA 17 Nov 2026)
  const { transferId } = params;
  const transfer = await getInteropTransferStatus(transferId);
  if (!transfer) return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
  return NextResponse.json({ success: true, transfer });
}
