// GET /api/analytics/oauth/companies  (signed in) -> the companies this person could connect to Power BI, with the reason when not.
import { getRawSessionToken, getSession } from "../../../../../lib/orgs.js";
import { connectableCompanies } from "../../../../../lib/analytics/oauth.js";
import { json, handle } from "../../_lib.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const s = await getSession(getRawSessionToken(req));
    if (!s) return json({ authenticated: false }, 401);
    return json({ authenticated: true, email: s.email, companies: await connectableCompanies(s.email) });
  } catch (err) { return handle(err, "companies"); }
}
