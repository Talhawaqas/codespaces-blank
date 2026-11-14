// GET /api/public/v1/campaigns/{id}/report   totals, rates, top links, opens/clicks by hour
import * as C from "../../../../../../../lib/engagement/campaigns.js";
import { publicRoute } from "../../../_lib.js";
import { unwrap, gate } from "../../../_engagement.js";
export const dynamic = "force-dynamic";

export const GET = (req, ctx) => publicRoute(req, ctx, {}, async ({ orgId, membership, params }) => { await gate(orgId, "campaigns"); return unwrap(await C.campaignReport({ orgId, membership, campaignId: params.campaignId })); });
