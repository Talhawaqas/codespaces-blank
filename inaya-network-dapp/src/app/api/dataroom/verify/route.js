// app/api/dataroom/verify/route.js
//
// GET /api/dataroom/verify?token=... — called via fetch from the
// /dataroom page's client-side effect when it sees ?token= in the URL
// (not a full-page redirect route, unlike orgs/login/consume — the data
// room is a single-page flow, see src/app/dataroom/page.js). Consumes the
// magic link, sets the session cookie, returns the visitor's current
// state so the page can decide whether to show the NDA screen or go
// straight to documents.

import { NextResponse } from "next/server";
import { consumeDataroomMagicLink, getDataroomCollections, toObjectId, DATAROOM_SESSION_COOKIE, DATAROOM_SESSION_TTL_MS } from "../../../../lib/dataroom.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const token = new URL(req.url).searchParams.get("token");
    const result = await consumeDataroomMagicLink(token);
    if (result.error) {
      return NextResponse.json({ error: "This link is invalid or has expired. Please request a new one." }, { status: result.status });
    }

    const { visitors } = await getDataroomCollections();
    const visitor = await visitors.findOne({ _id: toObjectId(result.visitorId) });

    const response = NextResponse.json({ verified: true, name: visitor?.name, email: visitor?.email, ndaAcceptedAt: visitor?.ndaAcceptedAt || null });
    response.cookies.set(DATAROOM_SESSION_COOKIE, result.sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV !== "development",
      sameSite: "lax",
      maxAge: DATAROOM_SESSION_TTL_MS / 1000,
      path: "/",
    });
    return response;
  } catch (err) {
    console.error("dataroom/verify failed:", err);
    return NextResponse.json({ error: "Could not verify this link." }, { status: 500 });
  }
}
