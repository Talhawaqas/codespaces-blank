// Generated for the AI Business Operations Manager SOW (section 51). Thin wrapper: authentication, org scope,
// rate limit, body limit and replay protection live in the shared workflowRoute wrapper; the logic is in src/lib/workflows/.
import { workflowRoute } from "../../_lib.js";
import * as evals from "../../../../../../lib/workflows/evaluations.js";

export const GET = workflowRoute(async ({ orgId, membership, email, params, body, query }) => evals.listEvaluations({ orgId, workflowId: params.id, membership, email }));
export const POST = workflowRoute(async ({ orgId, membership, email, params, body, query }) => evals.createEvaluation({ orgId, workflowId: params.id, name: body.name, cases: body.cases, membership, actorEmail: email }), { okStatus: 201 });
