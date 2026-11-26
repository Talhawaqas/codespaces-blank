// app/api/orgs/app-handoff/route.js -- POST { challenge } (signed in on the website) -> { code } for the mobile app
// (src/lib/appHandoff.js). Used by /business/app-signin after a passkey or SSO sign-in.
import { NextResponse } from "next/server";
import { getRawSessionToken, getSession } from "../../../../lib/orgs.js";
import { createHandoff, HandoffError } from "../../../../lib/appHandoff.js";

export const dynamic = "force-dynamic";
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });

export async function POST(req) {
  try {
    const session = await getSession(getRawSessionToken(req));
    if (!session) return json({ error: "Not signed in." }, 401);
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    return json(await createHandoff({ email: session.email, challenge: body.challenge, sessionCreatedAt: session.createdAt }));
  } catch (err) {
    if (err instanceof HandoffError) return json({ error: err.message }, err.status);
    console.error("orgs/app-handoff failed:", err?.name); return json({ error: "Something went wrong." }, 500);
  }
}
