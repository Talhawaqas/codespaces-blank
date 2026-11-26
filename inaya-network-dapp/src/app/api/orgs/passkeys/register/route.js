// app/api/orgs/passkeys/register/route.js -- add a passkey to the signed-in person (src/lib/passkeys.js).
//   POST { step: "start" }                                 -> { options, requestToken }
//   POST { step: "finish", requestToken, response, name }   -> { passkey }
import { NextResponse } from "next/server";
import { getRawSessionToken, getSession } from "../../../../../lib/orgs.js";
import { startRegistration, finishRegistration, PasskeyError } from "../../../../../lib/passkeys.js";

export const dynamic = "force-dynamic";
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });

export async function POST(req) {
  try {
    const session = await getSession(getRawSessionToken(req));
    if (!session) return json({ error: "Not signed in." }, 401);
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    if (body.step === "start") return json(await startRegistration({ email: session.email, origin: req.headers.get("origin") }));
    if (body.step === "finish") return json({ passkey: await finishRegistration({ email: session.email, requestToken: body.requestToken, response: body.response, name: body.name }) });
    return json({ error: "step must be start or finish." }, 400);
  } catch (err) {
    if (err instanceof PasskeyError) return json({ error: err.message }, err.status);
    console.error("orgs/passkeys/register failed:", err?.name); return json({ error: "Something went wrong." }, 500);
  }
}
