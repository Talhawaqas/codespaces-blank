// app/api/dataroom/session/route.js
//
// GET /api/dataroom/session — current visitor's name/email/NDA status,
// or { visitor: null } if there's no valid session. The /dataroom page
// calls this on mount (when it has no ?token= to consume) to decide which
// screen to show.

import { NextResponse } from "next/server";
import { getDataroomVisitor } from "../../../../lib/dataroom.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const visitor = await getDataroomVisitor(req);
    if (!visitor) return NextResponse.json({ visitor: null });
    return NextResponse.json({
      visitor: { name: visitor.name, email: visitor.email, ndaAcceptedAt: visitor.ndaAcceptedAt },
    });
  } catch (err) {
    console.error("dataroom/session failed:", err);
    return NextResponse.json({ visitor: null });
  }
}
