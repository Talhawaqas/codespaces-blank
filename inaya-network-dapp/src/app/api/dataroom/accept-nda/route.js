// app/api/dataroom/accept-nda/route.js
//
// POST /api/dataroom/accept-nda — records ndaAcceptedAt for the current
// session's visitor. Requires a verified session; there's nothing to
// attach an NDA acceptance to otherwise.

import { NextResponse } from "next/server";
import { getDataroomVisitor, acceptDataroomNda } from "../../../../lib/dataroom.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  try {
    const visitor = await getDataroomVisitor(req);
    if (!visitor) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    await acceptDataroomNda(visitor._id);
    return NextResponse.json({ accepted: true });
  } catch (err) {
    console.error("dataroom/accept-nda failed:", err);
    return NextResponse.json({ error: "Could not record NDA acceptance." }, { status: 500 });
  }
}
