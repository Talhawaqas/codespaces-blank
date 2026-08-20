// app/api/admin/dataroom/visitors/[visitorId]/revoke/route.js
//
// POST /api/admin/dataroom/visitors/:visitorId/revoke — immediately kills
// all of this visitor's active sessions and marks them revoked, so a
// re-verification (fresh magic link) is required to get back in.

import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../../../../lib/admin-auth.js";
import { revokeDataroomVisitor } from "../../../../../../../lib/dataroom.js";

export const dynamic = "force-dynamic";

export async function POST(req, { params }) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const { visitorId } = params;
    await revokeDataroomVisitor(visitorId);
    return NextResponse.json({ revoked: true });
  } catch (err) {
    console.error("admin/dataroom/visitors/revoke failed:", err);
    return NextResponse.json({ error: "Could not revoke access." }, { status: 500 });
  }
}
