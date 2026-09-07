// app/api/data-room-access/[token]/route.js
//
// GET /api/data-room-access/[token] — the external investor/diligence
// counterparty/auditor's own entry point, deliberately OUTSIDE
// src/app/api/orgs/* and its requireMembership() gate, mirroring
// regulatory-examiner/[token]/route.js exactly. Excluded from
// test/vertical-lock-wiring.test.mjs — no orgId query param, no
// membership concept.

import { NextResponse } from "next/server";
import { exchangeRoomMagicLink } from "../../../../lib/external-data-room.js";

export const dynamic = "force-dynamic";
export const DATA_ROOM_SESSION_COOKIE = "inaya_data_room_session";

export async function GET(req, { params }) {
  try {
    const { token } = await params;
    const result = await exchangeRoomMagicLink(token);
    if (result.error) {
      return NextResponse.json({ error: "This link is invalid or has expired." }, { status: result.status });
    }

    const response = NextResponse.json({ verified: true, roomId: result.roomId });
    response.cookies.set(DATA_ROOM_SESSION_COOKIE, result.sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV !== "development",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60,
      path: "/",
    });
    return response;
  } catch (err) {
    console.error("data-room-access/[token] failed:", err);
    return NextResponse.json({ error: "Could not verify this link." }, { status: 500 });
  }
}
