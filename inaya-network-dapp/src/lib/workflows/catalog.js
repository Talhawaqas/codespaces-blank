// src/lib/workflows/catalog.js
//
// Small read/verify helpers the editor and the API need: the node/tool catalog
// (so the editor never hard-codes what the engine supports), live validation of a
// draft, the evidence passport with its permission check, and clearing agent memory.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { listNodeTypes, DATA_SCOPES, DEFAULT_SETTINGS, ACTION_RISK_POLICY, REPORT_TYPES, APPROVED_PROPOSE_TOOLS } from "./nodes.js";
import { EXPRESSION_FUNCTIONS } from "./expr.js";
import { listTools } from "./tools.js";
import { CREDENTIAL_PROVIDERS } from "./credentials.js";
import { SCENARIO_TYPES } from "../digitalTwinSimulate.js";
import { validateForPublish, cleanDefinition, loadWorkflow, can, RIGHTS } from "./service.js";
import { buildEvidencePassport } from "./evidence.js";
import { clearMemory } from "./memory.js";
import { emitWorkflowEvent } from "./queue.js";
import { canManageOrg } from "../orgGates.js";
import { randomUUID } from "node:crypto";
import { fail } from "./common.js";

export function catalog() {
  return {
    nodeTypes: listNodeTypes(), tools: listTools(), dataScopes: DATA_SCOPES, rights: RIGHTS, reportTypes: REPORT_TYPES, twinScenarios: SCENARIO_TYPES,
    proposeTools: APPROVED_PROPOSE_TOOLS, credentialProviders: Object.entries(CREDENTIAL_PROVIDERS).map(([id, d]) => ({ id, label: d.label })),
    expressionFunctions: EXPRESSION_FUNCTIONS, defaultSettings: DEFAULT_SETTINGS, riskPolicy: ACTION_RISK_POLICY,
    limits: { maxNodes: 60, maxEdges: 200 },
    integrationStatus: {
      email: "Inaya delivery (requires a mail provider on the server)", slack: "implemented; NOT verified against live Slack (mock-tested)",
      gmail: "implemented via the Gmail API with an OAuth token credential; NOT verified against live Gmail (mock-tested)",
      helpdesk: "read through the controlled HTTP connector; NOT verified against a real helpdesk vendor (local test server only)",
      gemini: "server-side only; the browser never receives the key",
    },
  };
}

/** Live validation for the editor: the same checks publish will run, without publishing. */
export async function validateDraft({ orgId, membership, email, body }) {
  if (!body?.definition) return fail("definition is required.");
  const definition = cleanDefinition(body.definition);
  return validateForPublish({ orgId, definition, membership, actorEmail: email });
}

export async function passport({ orgId, executionId, membership, email }) {
  const { workflowExecutions } = await getOrgCollections();
  let e; try { e = await workflowExecutions.findOne({ _id: toObjectId(executionId), orgId: toObjectId(orgId) }); } catch { e = null; }
  if (!e) return fail("Execution not found.", 404);
  const w = await loadWorkflow(orgId, e.workflowId);
  if (!w || !can(w, membership, email, "view")) return fail("Execution not found.", 404); // no hint that it exists
  if (!can(w, membership, email, "exportEvidence")) return fail("You don't have permission to export evidence for this workflow.", 403);
  return buildEvidencePassport({ orgId, executionId });
}

export async function clearWorkflowMemory({ orgId, id, membership, email }) {
  const w = await loadWorkflow(orgId, id);
  if (!w || !can(w, membership, email, "view")) return fail("Workflow not found.", 404);
  if (!can(w, membership, email, "edit")) return fail("You don't have permission to edit this workflow.", 403);
  return clearMemory({ orgId, workflowId: w._id });
}

/** Lets an owner/admin raise a custom event (for example from an integration) that starts workflows with an Event trigger. */
export async function emitEvent({ orgId, membership, body }) {
  if (!canManageOrg(membership)) return fail("Only an owner or admin can raise workflow events.", 403);
  if (!/^[a-z0-9_.:-]{3,60}$/i.test(String(body?.eventType || ""))) return fail("eventType is required (for example invoice.overdue).");
  if (JSON.stringify(body?.payload ?? null).length > 32 * 1024) return fail("The payload is too large.", 413);
  const r = await emitWorkflowEvent({ orgId, type: "event", key: body.eventType, eventId: body.eventId || randomUUID(), payload: body.payload || {} });
  return { fired: r.fired };
}
