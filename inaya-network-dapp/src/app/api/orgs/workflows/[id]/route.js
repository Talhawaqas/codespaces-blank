// Generated for the AI Business Operations Manager SOW (section 51). Thin wrapper: authentication, org scope,
// rate limit, body limit and replay protection live in the shared workflowRoute wrapper; the logic is in src/lib/workflows/.
import { workflowRoute } from "../_lib.js";
import * as svc from "../../../../../lib/workflows/service.js";

export const GET = workflowRoute(async ({ orgId, membership, email, params, body, query }) => svc.getWorkflow({ orgId, id: params.id, membership, email }));
export const PATCH = workflowRoute(async ({ orgId, membership, email, params, body, query }) => svc.updateWorkflow({ orgId, id: params.id, membership, actorEmail: email, name: body.name, description: body.description, definition: body.definition, baseUpdatedAt: body.baseUpdatedAt }));
export const DELETE = workflowRoute(async ({ orgId, membership, email, params, body, query }) => svc.deleteWorkflow({ orgId, id: params.id, membership, actorEmail: email }));
