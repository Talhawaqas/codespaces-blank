// Generated for the AI Business Operations Manager SOW (section 51). Thin wrapper: authentication, org scope,
// rate limit, body limit and replay protection live in the shared workflowRoute wrapper; the logic is in src/lib/workflows/.
import { workflowRoute } from "./_lib.js";
import * as svc from "../../../../lib/workflows/service.js";

export const GET = workflowRoute(async ({ orgId, membership, email, params, body, query }) => svc.listWorkflows({ orgId, membership, email }));
export const POST = workflowRoute(async ({ orgId, membership, email, params, body, query }) => body.templateId ? svc.createFromTemplate({ orgId, templateId: body.templateId, name: body.name, membership, actorEmail: email }) : svc.createWorkflow({ orgId, membership, actorEmail: email, name: body.name, description: body.description, definition: body.definition }), { okStatus: 201 });
