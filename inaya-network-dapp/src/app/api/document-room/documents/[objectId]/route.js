// GET /api/document-room/documents/[objectId]?download=1
//   -> the PDF for an identity-verified Data Room session. Refused (410) when
//      the document was superseded / voided / expired or the delivery was
//      revoked; every view/download is logged to the room access log AND the
//      document's evidence chain.
import { NextResponse } from "next/server";
import { getRoomSession } from "../../../../../lib/external-data-room.js";
import { getClientIp } from "../../../../../lib/rateLimit.js";
import { resolveRoomDocument } from "../../../../../lib/documentAutomation/delivery.js";
import { limited, pdfResponse } from "../../../orgs/documents-automation/_lib.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const COOKIE = "inaya_data_room_session";

export async function GET(req, { params }) {
  try {
    const { objectId } = await params;
    const rl = await limited(req, { action: "room-download", max: 60 });
    if (rl) return rl;
    const session = await getRoomSession(req.cookies.get(COOKIE)?.value);
    if (!session) return NextResponse.json({ error: "Your session is invalid or has expired." }, { status: 401 });
    const download = new URL(req.url).searchParams.get("download") === "1";
    const result = await resolveRoomDocument({ session, documentObjectId: objectId, download, ip: getClientIp(req) });
    if (result.error) return NextResponse.json({ error: result.error, ...(result.ndaRequired ? { ndaRequired: true } : {}) }, { status: result.status });
    return pdfResponse(result.buffer, result.filename, { hash: result.documentHash, inline: !download });
  } catch (err) {
    console.error("document-room/documents/[objectId] GET failed:", err);
    return NextResponse.json({ error: "Could not open this document." }, { status: 500 });
  }
}
