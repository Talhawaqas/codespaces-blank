// app/api/meet/by-token/[token]/route.js -- Inaya Meet (FEATURE_MEET). No session, no orgId needed:
// this is the first call the public /meet/[token] landing page makes, before anyone has
// authenticated or joined anything. Resolves a join token to the room's id/org/title only.
//   GET
import { NextResponse } from "next/server";
import { getRoomByToken } from "../../../../../lib/meet/rooms.js";
import { MeetError } from "../../../../../lib/meet/common.js";
import { requireFeature } from "../../../../../lib/featureFlags.js";

export const dynamic = "force-dynamic";
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });

export async function GET(req, { params }) {
  try {
    const { token } = await params;
    const info = await getRoomByToken({ joinToken: token });
    const off = await requireFeature("FEATURE_MEET", info.orgId);
    if (off) return json({ error: off.error }, off.status);
    return json(info);
  } catch (err) {
    if (err instanceof MeetError) return json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
