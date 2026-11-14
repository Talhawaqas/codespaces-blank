// GET /api/public/v1/campaigns?status   email campaigns with delivery stats and open/click/bounce rates
import * as C from "../../../../../lib/engagement/campaigns.js";
import { publicRoute } from "../_lib.js";
import { unwrap, gate } from "../_engagement.js";
export const dynamic = "force-dynamic";

export const GET = (req, ctx) => publicRoute(req, ctx, {}, async ({ orgId, membership, query }) => { await gate(orgId, "campaigns"); return unwrap(await C.listCampaigns({ orgId, membership, status: query.status })); });
