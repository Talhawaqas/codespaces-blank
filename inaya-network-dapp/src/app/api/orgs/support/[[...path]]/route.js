// Customer Portal & Customer Service SOW: the agent/administrator API. One catch-all wrapper over
// src/lib/support/agentApi.js: authentication, organization scope (the caller's OWN membership), rate limit, body
// limit and Idempotency-Key replay protection live in the shared workflowRoute wrapper; permissions, ticket
// visibility, validation and auditing live in the library.
import { workflowRoute } from "../../workflows/_lib.js";
import { handleAgent } from "../../../../../lib/support/agentApi.js";

const handler = workflowRoute(async ({ orgId, membership, email, params, body, query, req }) => handleAgent({ method: req.method, path: params.path || [], query, body, orgId, membership, email }));
export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
