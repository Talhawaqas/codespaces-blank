// POST /api/analytics/oauth/token  (application/x-www-form-urlencoded, RFC 6749)
//   grant_type=authorization_code&code&redirect_uri&code_verifier&client_id   |   grant_type=refresh_token&refresh_token&client_id
import { exchangeToken } from "../../../../../lib/analytics/oauth.js";
import { json, handle, readForm } from "../../_lib.js";
import { checkRateLimit, getClientIp } from "../../../../../lib/rateLimit.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  try {
    try { await checkRateLimit({ action: "analytics-token", key: getClientIp(req), max: 120, windowMs: 10 * 60 * 1000 }); }
    catch { return json({ error: "slow_down", error_description: "Too many requests." }, 429); }
    return json(await exchangeToken(await readForm(req)));
  } catch (err) { return handle(err, "token"); }
}
