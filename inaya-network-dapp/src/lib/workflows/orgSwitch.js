// src/lib/workflows/orgSwitch.js
//
// An organization-wide off switch for Workflow Automations, for the owner or an admin. Distinct from the platform suspending an
// organization (org.disabledAt / status, which the engine already honours): this one is the customer's own control, e.g. while they
// investigate something odd. While it is off, no production run is created (schedules, data-change, event, webhook, API and manual
// production runs are all refused at enqueueExecution) and a production run that was already queued is refused when a worker
// claims it. Test and dry-run executions have no side effects and stay available so workflows can still be edited and checked.
// Turning it on or off is recorded in the tamper-evident audit chain.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { canManageOrg } from "../orgGates.js";
import { recordWorkflowEvidence } from "./evidence.js";

const fail = (error, status = 400) => ({ error, status });

export const automationsOff = (org) => !!org?.automationsOffAt;

export async function getOrgAutomations({ orgId }) {
  const { orgs } = await getOrgCollections();
  const org = await orgs.findOne({ _id: toObjectId(orgId) }, { projection: { automationsOffAt: 1, automationsOffBy: 1, automationsOffReason: 1 } });
  if (!org) return fail("Organization not found.", 404);
  return { enabled: !automationsOff(org), offSince: org.automationsOffAt || null, offBy: org.automationsOffBy || null, reason: org.automationsOffReason || null };
}

export async function setOrgAutomations({ orgId, membership, actorEmail, enabled, reason = "" }) {
  if (!canManageOrg(membership)) return fail("Only the owner or an admin can turn automations on or off for the organization.", 403);
  if (typeof enabled !== "boolean") return fail("enabled must be true or false.");
  const why = String(reason || "").trim().slice(0, 300);
  const { orgs } = await getOrgCollections();
  const patch = enabled
    ? { $unset: { automationsOffAt: "", automationsOffBy: "", automationsOffReason: "" } }
    : { $set: { automationsOffAt: new Date().toISOString(), automationsOffBy: actorEmail, automationsOffReason: why || null } };
  const r = await orgs.updateOne({ _id: toObjectId(orgId) }, patch);
  if (!r.matchedCount) return fail("Organization not found.", 404);
  await recordWorkflowEvidence({ orgId, action: "ORG_AUTOMATIONS_CHANGED", actorEmail, actorType: "user", result: enabled ? "ENABLED" : "DISABLED", data: { enabled, reason: why || null } });
  return getOrgAutomations({ orgId });
}
