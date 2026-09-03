// app/api/wallet/notifications/[id]/read/route.js
//
// POST /api/wallet/notifications/:id/read
// Body: { address, message, signature, timestamp }
//
// Enterprise OS SOW, Phase 3. A write, so unlike the GET above it's real-
// signature-gated — reuses verifyMetadataAuth's existing message format
// (metadata-auth.js), the same generic action/resourceId/timestamp
// signing scheme already used for file rename/delete/move, rather than
// inventing a second signing convention for this one route.

import { NextResponse } from "next/server";
import { verifyMetadataAuth } from "../../../../../../lib/metadata-auth.js";
import { markRead } from "../../../../../../lib/notifications.js";

export async function POST(req, { params }) {
  try {
    const { address, message, signature, timestamp } = await req.json();
    verifyMetadataAuth({ action: "markNotificationRead", resourceId: params.id, address, message, signature, timestamp });

    await markRead({ scope: "wallet", walletAddress: address, notificationId: params.id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
