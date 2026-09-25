// GET /api/document-room/documents -- the generated documents an identity-verified
// Data Room session may see (metadata only). The session comes from the cookie
// the existing /api/data-room-access/[token] exchange set; the org, room and
// document set are resolved from THAT session, never from the request.
import { NextResponse } from "next/server";
import { getRoomSession } from "../../../../lib/external-data-room.js";
import { listRoomGeneratedDocuments } from "../../../../lib/documentAutomation/delivery.js";
import { limited } from "../../orgs/documents-automation/_lib.js";

export const dynamic = "force-dynamic";
const COOKIE = "inaya_data_room_session";

export async function GET(req) {
  try {
    const rl = await limited(req, { action: "room-list", max: 90 });
    if (rl) return rl;
    const session = await getRoomSession(req.cookies.get(COOKIE)?.value);
    if (!session) return NextResponse.json({ error: "Your session is invalid or has expired." }, { status: 401 });
    const out = await listRoomGeneratedDocuments({ session });
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("document-room/documents GET failed:", err);
    return NextResponse.json({ error: "Could not fetch documents." }, { status: 500 });
  }
}
