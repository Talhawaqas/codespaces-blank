// app/api/nodes/operator/logout/route.js
//
// POST /api/nodes/operator/logout — clears the session cookie and deletes
// the underlying session doc, same "actually revoke, don't just clear the
// client cookie" discipline orgs.js's own logout route follows.

import { NextResponse } from "next/server";
import { destroySession, NODE_SESSION_COOKIE } from "../../../../../lib/nodeOperatorAuth.js";

export async function POST(req) {
  try {
    const rawToken = req.cookies.get(NODE_SESSION_COOKIE)?.value;
    await destroySession(rawToken);
    const res = NextResponse.json({ ok: true });
    res.cookies.delete(NODE_SESSION_COOKIE);
    return res;
  } catch (err) {
    console.error("nodes/operator/logout POST failed:", err);
    return NextResponse.json({ error: "Could not sign out." }, { status: 500 });
  }
}
