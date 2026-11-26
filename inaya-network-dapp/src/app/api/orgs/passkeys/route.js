// app/api/orgs/passkeys/route.js -- the signed-in person's passkeys (src/lib/passkeys.js).
//   GET               -> { passkeys: [{ id, name, rpID, createdAt, lastUsedAt, deviceType, backedUp }] }
//   DELETE ?id=...    -> remove one
import { NextResponse } from "next/server";
import { getRawSessionToken, getSession } from "../../../../lib/orgs.js";
import { listPasskeys, removePasskey, PasskeyError } from "../../../../lib/passkeys.js";

export const dynamic = "force-dynamic";
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });

async function run(req, fn) {
  try {
    const session = await getSession(getRawSessionToken(req));
    if (!session) return json({ error: "Not signed in." }, 401);
    return json(await fn(session.email));
  } catch (err) {
    if (err instanceof PasskeyError) return json({ error: err.message }, err.status);
    console.error("orgs/passkeys failed:", err?.name); return json({ error: "Something went wrong." }, 500);
  }
}
export const GET = (req) => run(req, async (email) => ({ passkeys: await listPasskeys(email) }));
export const DELETE = (req) => run(req, (email) => removePasskey({ email, id: new URL(req.url).searchParams.get("id") }));
