// Generated for the AI Business Operations Manager SOW (section 51). Thin wrapper: authentication, org scope,
// rate limit, body limit and replay protection live in the shared workflowRoute wrapper; the logic is in src/lib/workflows/.
import { workflowRoute } from "../_lib.js";
import * as copilot from "../../../../../lib/workflows/copilot.js";

export const POST = workflowRoute(async ({ orgId, membership, email, params, body, query }) => copilot.draftWorkflowFromPrompt({ orgId, membership, actorEmail: email, prompt: body.prompt, name: body.name }), { okStatus: 201 });
