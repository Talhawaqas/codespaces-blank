// app/api/data-room-access/nda/route.js
//
// POST /api/data-room-access/nda -- external reviewer accepts this
// room's NDA, resolved entirely from the session cookie (never a
// client-supplied roomId), same pattern as documents/route.js.

import { NextResponse } from "next/server";
import { acceptRoomNda } from "../../../../lib/external-data-room.js";

export const dynamic = "force-dynamic";
const DATA_ROOM_SESSION_COOKIE = "inaya_data_room_session";

export async function POST(req) {
  try {
    const token = req.cookies.get(DATA_ROOM_SESSION_COOKIE)?.value;
    const result = await acceptRoomNda(token);
    if (result.error) return NextResponse.json({ error: "Your session is invalid or has expired." }, { status: 401 });
    return NextResponse.json(result);
  } catch (err) {
    console.error("data-room-access/nda POST failed:", err);
    return NextResponse.json({ error: "Could not record NDA acceptance." }, { status: 500 });
  }
}
