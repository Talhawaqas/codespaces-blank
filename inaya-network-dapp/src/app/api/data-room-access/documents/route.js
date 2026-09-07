// app/api/data-room-access/documents/route.js
//
// GET /api/data-room-access/documents — the external session's ONLY read
// path, resolved entirely from the session cookie (never a client-
// supplied orgId/roomId) so a session can never be pointed at a room it
// wasn't issued for. Every real access is logged (§229) inside
// listRoomDocuments() itself.

import { NextResponse } from "next/server";
import { getRoomSession, listRoomDocuments } from "../../../../lib/external-data-room.js";

export const dynamic = "force-dynamic";
const DATA_ROOM_SESSION_COOKIE = "inaya_data_room_session";

export async function GET(req) {
  try {
    const token = req.cookies.get(DATA_ROOM_SESSION_COOKIE)?.value;
    const session = await getRoomSession(token);
    if (!session) return NextResponse.json({ error: "Your session is invalid or has expired." }, { status: 401 });

    const { documents } = await listRoomDocuments(session);
    return NextResponse.json({ documents: documents.map((d) => ({ id: d._id.toString(), title: d.title || d.name || null, classification: d.classification || null, uploadedAt: d.createdAt || d.uploadedAt || null })) });
  } catch (err) {
    console.error("data-room-access/documents GET failed:", err);
    return NextResponse.json({ error: "Could not fetch documents." }, { status: 500 });
  }
}
