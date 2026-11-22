// GET /api/shop/ping -- used when a shop connects its own domain: Inaya fetches https://<domain>/api/shop/ping and checks that the
// domain serves THIS store over HTTPS. Answers only for a domain whose ownership TXT record was already verified.
import { NextResponse } from "next/server";
import { ccol } from "../../../../lib/commerce/store.js";
import { OK } from "../../../../lib/online/stores.js";

export const dynamic = "force-dynamic";
export async function GET(req) {
  const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").toLowerCase().split(":")[0];
  const c = await ccol(); const s = host ? await c.findOne({ kind: OK.store, "domain.host": host, "domain.verifiedAt": { $ne: null } }, { projection: { _id: 1 } }) : null;
  return NextResponse.json(s ? { storeId: String(s._id) } : { storeId: null }, { headers: { "Cache-Control": "no-store" } });
}
