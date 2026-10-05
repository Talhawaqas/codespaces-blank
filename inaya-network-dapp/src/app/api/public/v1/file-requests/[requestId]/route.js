// GET    /api/public/v1/file-requests/{requestId}   the request and its upload list (metadata only; the wrapped private key and file contents are never returned)
// DELETE /api/public/v1/file-requests/{requestId}   revoke the request
import * as R from "../../../../../../lib/filerequests/requests.js";
import { publicRoute } from "../../_lib.js";
export const dynamic = "force-dynamic";
const F = { flag: "FEATURE_ADVANCED_SHARING" };
export const GET = (req, ctx) => publicRoute(req, ctx, F, async ({ orgId, membership, email, params }) => { const r = await R.getRequest({ orgId, requestId: params.requestId, actorEmail: email, membership }); delete r.wrappedPrivateKey; delete r.publicKeyJwk; return r; });
export const DELETE = (req, ctx) => publicRoute(req, ctx, F, ({ orgId, membership, email, params }) => R.revokeRequest({ orgId, requestId: params.requestId, actorEmail: email, membership }));
