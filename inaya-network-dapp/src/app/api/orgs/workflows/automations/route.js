// GET -> whether Workflow Automations are on for the organization (any member); PUT { enabled, reason? } -> owner/admin only.
// Thin wrapper: authentication, org scope, rate limit and replay protection live in the shared workflowRoute wrapper.
import { workflowRoute } from "../_lib.js";
import { getOrgAutomations, setOrgAutomations } from "../../../../../lib/workflows/orgSwitch.js";

export const GET = workflowRoute(async ({ orgId }) => getOrgAutomations({ orgId }));
export const PUT = workflowRoute(async ({ orgId, membership, email, body }) => setOrgAutomations({ orgId, membership, actorEmail: email, enabled: body.enabled, reason: body.reason }));
