// POST /api/analytics/oauth/revoke  token=<refresh or access token>  (RFC 7009: always answers 200)
import { revokeToken } from "../../../../../lib/analytics/oauth.js";
import { json, handle, readForm } from "../../_lib.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  try { const f = await readForm(req); return json(await revokeToken(f.token)); }
  catch (err) { return handle(err, "revoke"); }
}
