// Generated for the AI Business Operations Manager SOW (section 51). Thin wrapper: authentication, org scope,
// rate limit, body limit and replay protection live in the shared workflowRoute wrapper; the logic is in src/lib/workflows/.
import { workflowRoute } from "../../_lib.js";
import * as svc from "../../../../../../lib/workflows/service.js";

export const POST = workflowRoute(async ({ orgId, membership, email, params, body, query }) => svc.testWorkflow({ orgId, id: params.id, membership, actorEmail: email, testData: body.testData || {}, useDraft: body.useDraft !== false }));
