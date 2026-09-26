// Generated for the AI Business Operations Manager SOW (section 51). Thin wrapper: authentication, org scope,
// rate limit, body limit and replay protection live in the shared workflowRoute wrapper; the logic is in src/lib/workflows/.
import { workflowRoute } from "../_lib.js";
import * as creds from "../../../../../lib/workflows/credentials.js";

export const GET = workflowRoute(async ({ orgId, membership, email, params, body, query }) => creds.listCredentials({ orgId, membership }));
export const POST = workflowRoute(async ({ orgId, membership, email, params, body, query }) => creds.createCredential({ orgId, provider: body.provider, label: body.label, secret: body.secret, allowedHosts: body.allowedHosts, expiresAt: body.expiresAt, membership, actorEmail: email }), { okStatus: 201 });
