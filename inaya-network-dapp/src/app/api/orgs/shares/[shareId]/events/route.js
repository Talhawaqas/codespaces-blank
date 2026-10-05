// app/api/orgs/shares/[shareId]/events/route.js -- GET ?orgId&limit&before: the access log of one share (masked IPs, no secrets).
import { shareRoute } from "../../_lib.js";
import { listAccessEvents } from "../../../../../../lib/sharing/shares.js";
export const dynamic = "force-dynamic";
export async function GET(req, ctx) {
  return shareRoute(req, ctx, async ({ orgId, membership, email, query, params }) => listAccessEvents({ orgId, shareId: params.shareId, actorEmail: email, membership, limit: query.limit, before: query.before || null }));
}
