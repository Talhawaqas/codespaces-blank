// POST /api/analytics/oauth/approve  { orgId, params: { response_type, client_id, redirect_uri, state, code_challenge, code_challenge_method } }
// The signed-in person approves Power BI for one company -> { redirect } that sends the sign-in window back to Power BI.
import { getRawSessionToken, getSession } from "../../../../../lib/orgs.js";
import { approve } from "../../../../../lib/analytics/oauth.js";
import { json, handle } from "../../_lib.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  try {
    const s = await getSession(getRawSessionToken(req));
    if (!s) return json({ error: "login_required", error_description: "Sign in first." }, 401);
    let b = {}; try { b = await req.json(); } catch { b = {}; }
    return json(await approve({ email: s.email, orgId: String(b.orgId || ""), params: b.params || {} }));
  } catch (err) { return handle(err, "approve"); }
}
