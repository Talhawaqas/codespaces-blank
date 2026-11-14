// POST /api/public/v1/marketing/suppressions { email }   adds an address to the do-not-email list (e.g. an unsubscribe from another system)
import * as S from "../../../../../../lib/engagement/suppression.js";
import { publicRoute } from "../../_lib.js";
import { unwrap, gate } from "../../_engagement.js";
export const dynamic = "force-dynamic";

export const POST = (req, ctx) => publicRoute(req, ctx, {}, async ({ orgId, email, body }) => { await gate(orgId, "campaigns"); return unwrap(await S.suppress({ orgId, email: body.email, reason: "manual", source: "API", actorEmail: email })); });
