// app/api/wallet/notifications/mark-all-read/route.js
//
// POST /api/wallet/notifications/mark-all-read
// Body: { address, message, signature, timestamp }
//
// Enterprise OS SOW, Phase 3. Same signature scheme as the single-read
// route — resourceId is the fixed literal "all" so the signed message is
// stable and doesn't need to enumerate every notification id.

import { NextResponse } from "next/server";
import { verifyMetadataAuth } from "../../../../../lib/metadata-auth.js";
import { markAllRead } from "../../../../../lib/notifications.js";

export async function POST(req) {
  try {
    const { address, message, signature, timestamp } = await req.json();
    verifyMetadataAuth({ action: "markAllNotificationsRead", resourceId: "all", address, message, signature, timestamp });

    const result = await markAllRead({ scope: "wallet", walletAddress: address });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
