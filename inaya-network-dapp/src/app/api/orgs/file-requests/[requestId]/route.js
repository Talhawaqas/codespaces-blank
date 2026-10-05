// app/api/orgs/file-requests/[requestId]/route.js
//   GET    ?orgId  -> the request with its uploads (metadata + sealed keys + the wrapped private key, so the owner's browser can open them)
//   DELETE ?orgId  -> close the request now (in-progress uploads are discarded; completed ones stay for collection)
import { requesterRoute } from "../_lib.js";
import { getRequest, revokeRequest } from "../../../../../lib/filerequests/requests.js";
export const dynamic = "force-dynamic";
export async function GET(req, ctx) { return requesterRoute(req, ctx, async ({ orgId, membership, email, params }) => getRequest({ orgId, requestId: params.requestId, actorEmail: email, membership })); }
export async function DELETE(req, ctx) { return requesterRoute(req, ctx, async ({ orgId, membership, email, params }) => revokeRequest({ orgId, requestId: params.requestId, actorEmail: email, membership })); }
