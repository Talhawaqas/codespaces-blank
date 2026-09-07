// app/api/orgs/data-rooms/route.js
// GET   ?orgId=&roomType= -> list data rooms
// POST  { orgId, roomType, name, relatedRecordId } -> create a room

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { createDataRoom, listDataRooms } from "../../../../lib/external-data-room.js";

function serialize(r) {
  return { id: r._id.toString(), roomType: r.roomType, name: r.name, relatedRecordId: r.relatedRecordId ? r.relatedRecordId.toString() : null, documentCount: r.documentIds.length, closedAt: r.closedAt, createdByEmail: r.createdByEmail, createdAt: r.createdAt };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const rooms = await listDataRooms(orgId, { roomType: searchParams.get("roomType") || undefined });
    return NextResponse.json({ rooms: rooms.map(serialize) });
  } catch (err) {
    console.error("orgs/data-rooms GET failed:", err);
    return NextResponse.json({ error: "Could not fetch data rooms." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, roomType, name } = body;
    if (!orgId || !roomType || !name) return NextResponse.json({ error: "orgId, roomType, and name are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await createDataRoom({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ room: serialize(result.room) });
  } catch (err) {
    console.error("orgs/data-rooms POST failed:", err);
    return NextResponse.json({ error: "Could not create the data room." }, { status: 500 });
  }
}
