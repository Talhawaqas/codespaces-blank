// app/api/orgs/file-requests/route.js -- file requests, requester side (behind FEATURE_ADVANCED_SHARING)
//   POST { orgId, title, instructions?, expirationPreset|expiresAt, maxFiles?, maxFileBytes?, allowedExtensions?[], requireIdentity?{name,email,company},
//          classification?, notifyOwner?, label?, publicKeyJwk, wrappedPrivateKey } -> creates a request; the upload link is returned once.
//   GET  ?orgId&scope=mine|org&status&limit&before -> the requester's list (scope org: owner/admin).
import { requesterRoute } from "./_lib.js";
import { createRequest, listRequests, RequestError } from "../../../../lib/filerequests/requests.js";
import { resolveExpiresAt } from "../../../../lib/document-permissions.js";
export const dynamic = "force-dynamic";

export async function POST(req, ctx) {
  return requesterRoute(req, ctx, async ({ orgId, email, body }) => {
    const expiresAt = body.expiresAt || resolveExpiresAt({ preset: body.expirationPreset, customExpiresAt: null });
    if (!expiresAt) throw new RequestError(400, "Choose when the request expires.");
    const made = await createRequest({ orgId, actorEmail: email, input: { ...body, expiresAt } });
    const origin = new URL(req.url).origin;
    const { wrappedPrivateKey, ...rest } = made.request;
    return { ...rest, uploadUrl: `${origin}/request/${made.token}` };
  });
}
export async function GET(req, ctx) {
  return requesterRoute(req, ctx, async ({ orgId, membership, email, query }) => listRequests({ orgId, actorEmail: email, membership, scope: query.scope || "mine", status: query.status || null, limit: query.limit, before: query.before || null }));
}
