// app/api/orgs/data-rooms/[roomId]/route.js
// GET   ?orgId= -> room detail + access log
// PATCH { orgId, action, ...args } -> action: "close" | "addDocument" | "removeDocument" | "invite" | "revoke"

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import {
  getDataRoom, getRoomAccessLog, closeDataRoom,
  addDocumentToRoom, removeDocumentFromRoom, inviteExternalUser, revokeRoomAccess,
} from "../../../../../lib/external-data-room.js";

export async function GET(req, { params }) {
  try {
    const { roomId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const room = await getDataRoom(orgId, roomId);
    if (!room) return NextResponse.json({ error: "Room not found." }, { status: 404 });
    const accessLog = await getRoomAccessLog(orgId, roomId);
    return NextResponse.json({
      room: { id: room._id.toString(), roomType: room.roomType, name: room.name, documentIds: room.documentIds.map((id) => id.toString()), closedAt: room.closedAt },
      accessLog: accessLog.map((a) => ({ externalEmail: a.externalEmail, action: a.action, documentId: a.documentId ? a.documentId.toString() : null, accessedAt: a.accessedAt })),
    });
  } catch (err) {
    console.error("orgs/data-rooms/[roomId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch the data room." }, { status: 500 });
  }
}

export async function PATCH(req, { params }) {
  try {
    const { roomId } = await params;
    const body = await req.json();
    const { orgId, action } = body;
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const ctx = { orgId, roomId, actorEmail: auth.session.email, membership: auth.membership };
    let result;
    if (action === "close") result = await closeDataRoom(ctx);
    else if (action === "addDocument") result = await addDocumentToRoom({ ...ctx, documentId: body.documentId });
    else if (action === "removeDocument") result = await removeDocumentFromRoom({ ...ctx, documentId: body.documentId });
    else if (action === "invite") result = await inviteExternalUser({ ...ctx, externalEmail: body.externalEmail, expiresInHours: body.expiresInHours });
    else if (action === "revoke") result = await revokeRoomAccess({ ...ctx, externalEmail: body.externalEmail });
    else return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });

    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    if (result.room) return NextResponse.json({ room: { id: result.room._id.toString(), documentIds: (result.room.documentIds || []).map((id) => id.toString()), closedAt: result.room.closedAt } });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/data-rooms/[roomId] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update the data room." }, { status: 500 });
  }
}
