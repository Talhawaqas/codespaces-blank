// Generated for the AI Business Operations Manager SOW (section 51). Thin wrapper: authentication, org scope,
// rate limit, body limit and replay protection live in the shared workflowRoute wrapper; the logic is in src/lib/workflows/.
import { workflowRoute } from "../../../_lib.js";
import * as explain from "../../../../../../../lib/workflows/explain.js";

export const GET = workflowRoute(async ({ orgId, membership, email, params, body, query }) => explain.explainExecution({ orgId, executionId: params.executionId, membership, email }));
