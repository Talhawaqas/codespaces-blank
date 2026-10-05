// GET    /api/public/v1/shares/{shareId}   access events for one share
// DELETE /api/public/v1/shares/{shareId}   revoke it
import * as S from "../../../../../../lib/sharing/shares.js";
import { publicRoute } from "../../_lib.js";
export const dynamic = "force-dynamic";
const F = { flag: "FEATURE_ADVANCED_SHARING" };
export const GET = (req, ctx) => publicRoute(req, ctx, F, ({ orgId, membership, email, params, query }) => S.listAccessEvents({ orgId, shareId: params.shareId, actorEmail: email, membership, limit: query.limit, before: query.before || null }));
export const DELETE = (req, ctx) => publicRoute(req, ctx, F, ({ orgId, membership, email, params }) => S.revokeShare({ orgId, shareId: params.shareId, actorEmail: email, membership }));
