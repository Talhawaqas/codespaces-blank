// app/api/pos-scan/route.js -- Inaya Commerce: the phone side of "phone as a scanner" (scanPair.js). No sign-in: the
// pairing key from the till's QR code is the only credential, and it can only add barcode text to that one till.
//   POST { token, code }   adds a scanned code        POST { token, check: true }   is the pairing still open?
import { NextResponse } from "next/server";
import { pushScan, pairStatus } from "../../../lib/commerce/scanPair.js";

export const dynamic = "force-dynamic";
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });

export async function POST(req) {
  let body = {}; try { body = await req.json(); } catch { return json({ error: "Bad request." }, 400); }
  try {
    const r = body.check ? await pairStatus({ token: body.token }) : await pushScan({ token: body.token, code: body.code });
    return r.error ? json({ error: r.error, code: r.code }, r.status || 400) : json(r);
  } catch (e) { console.error("pos-scan failed:", e?.message); return json({ error: "Could not send the code. Try again." }, 500); }
}
