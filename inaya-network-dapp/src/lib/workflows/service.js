// src/lib/workflows/service.js
//
// SOW §7, §34, §35, §51, §55, §56: the workflow lifecycle. Every function takes
// the caller's LIVE membership (from requireMembership) and re-derives what the
// caller may do from it; nothing is trusted from the request body.
//
//   draft  --publish-->  immutable version N  --rollback--> earlier version
//
// A published version can never change: it is stored in `workflowVersions` with
// its canonical hash, and the engine refuses to run a version whose hash no
// longer matches. Editing a workflow only ever touches its DRAFT.

import { getOrgCollections, toObjectId, getMembership } from "../orgs.js";
import { canManageOrg } from "../orgGates.js";
import { logOrgActivity } from "../org-activity-log.js";
import { canonicalHash } from "../documentAutomation/manifest.js";
import { encryptIntegrationSecret, decryptIntegrationSecret, isIntegrationCryptoConfigured } from "../integrationCrypto.js";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { NODE_TYPES, validateWorkflowDefinition, normalizeSettings, requiredScopes, scopeHeld, definitionRisk, DATA_SCOPES, NODE_KEY_RE } from "./nodes.js";
import { TOOLS } from "./tools.js";
import { nextRun } from "./schedule.js";
import { credentialStatus } from "./credentials.js";
import { buildTemplateDefinition, listTemplates } from "./templates.js";
import { enqueueExecution, runExecutionNow, cancelExecutionRecord, retryExecutionRecord, pauseExecutionRecord, resumeExecutionRecord } from "./queue.js";
import { recordWorkflowEvidence } from "./evidence.js";
import { localTestHostsAllowed } from "./http.js";
import { redact, fail } from "./common.js";

export const RIGHTS = ["view", "edit", "execute", "publish", "manageCredentials", "manageTemplates", "viewExecutions", "exportEvidence"];
const NAME_RE = /^[\w .,&()'/-]{2,80}$/u;

/** The caller's effective rights on one workflow (SOW §56). Org owners/admins hold all. */
export function rightsFor(workflow, membership, email) {
  if (canManageOrg(membership)) return new Set(RIGHTS);
  const set = new Set();
  if (workflow?.ownerEmail && workflow.ownerEmail === email) ["view", "edit", "execute", "viewExecutions"].forEach((r) => set.add(r));
  if (workflow?.createdBy === email) ["view", "edit", "execute", "viewExecutions"].forEach((r) => set.add(r));
  for (const a of workflow?.acl || []) if ((a.email && a.email === email) || (a.role && a.role === membership?.role)) for (const r of a.rights || []) if (RIGHTS.includes(r)) set.add(r);
  return set;
}
const can = (workflow, membership, email, right) => rightsFor(workflow, membership, email).has(right);
const denied = (what) => fail(`You don't have permission to ${what} this workflow.`, 403);

async function audit(orgId, workflowId, actorEmail, action, metadata = {}, extra = {}) {
  return recordWorkflowEvidence({ orgId, workflowId, action, actorEmail, actorType: "human", data: metadata, graph: false, ...extra });
}

async function loadWorkflow(orgId, id) {
  const { workflows } = await getOrgCollections();
  let w; try { w = await workflows.findOne({ _id: toObjectId(id), orgId: toObjectId(orgId), deletedAt: null }); } catch { return null; }
  return w;
}

const publicWorkflow = (w, rights) => ({
  workflowId: String(w._id), name: w.name, description: w.description || "", status: w.status, ownerEmail: w.ownerEmail, createdBy: w.createdBy, updatedBy: w.updatedBy,
  createdAt: w.createdAt, updatedAt: w.updatedAt, publishedAt: w.publishedAt || null, publishedVersion: w.published?.version || null, versionCount: w.versionCounter || 0,
  draftUpdatedAt: w.draftUpdatedAt, riskLevel: definitionRisk(w.draft), triggerKinds: (w.draft?.nodes || []).filter((n) => NODE_TYPES[n.type]?.category === "trigger" && !n.disabled).map((n) => n.type),
  schedule: w.schedule ? { enabled: w.schedule.enabled, nextRunAt: w.schedule.nextRunAt, lastFiredAt: w.schedule.lastFiredAt || null, timezone: w.schedule.config?.timezone } : null,
  lastExecutionAt: w.lastExecutionAt || null, hasWebhook: !!w.webhook?.secretEncrypted, rights: [...(rights || [])],
});

// ------------------------------------------------------------ definition IO
function cleanDefinition(def) {
  const d = def && typeof def === "object" ? def : {};
  const nodes = (Array.isArray(d.nodes) ? d.nodes : []).slice(0, 80).map((n) => ({
    key: String(n?.key ?? ""), type: String(n?.type ?? ""), name: String(n?.name ?? n?.key ?? "").slice(0, 80),
    config: n?.config && typeof n.config === "object" && !Array.isArray(n.config) ? JSON.parse(JSON.stringify(n.config)) : {},
    position: { x: Number(n?.position?.x) || 0, y: Number(n?.position?.y) || 0 }, ...(n?.disabled ? { disabled: true } : {}), ...(n?.note ? { note: String(n.note).slice(0, 300) } : {}),
  }));
  const edges = (Array.isArray(d.edges) ? d.edges : []).slice(0, 250).map((e) => ({ from: String(e?.from ?? ""), to: String(e?.to ?? ""), fromPort: String(e?.fromPort || "out") }));
  return { nodes, edges, settings: normalizeSettings(d.settings) };
}

/** Definition checks that need the database or the publisher's live scopes. */
export async function validateForPublish({ orgId, definition, membership, actorEmail }) {
  const base = validateWorkflowDefinition(definition);
  const errors = [...base.errors]; const warnings = [...base.warnings];
  const settings = normalizeSettings(definition.settings);
  const manager = canManageOrg(membership);
  const { orgMembers } = await getOrgCollections();
  const members = new Set((await orgMembers.find({ orgId: toObjectId(orgId), status: "active" }).project({ email: 1 }).toArray()).map((m) => m.email.toLowerCase()));

  for (const s of requiredScopes(definition)) if (!scopeHeld(membership, s)) errors.push({ code: "PUBLISHER_LACKS_SCOPE", message: `You do not hold the "${s}" data scope, so you cannot publish a workflow that reads it.` });
  if (settings.allowExternalRecipients && !manager) errors.push({ code: "EXTERNAL_RECIPIENTS_NEED_MANAGER", message: "Only an owner or admin can allow external recipients." });
  if (settings.allowHttpDelete && !manager) errors.push({ code: "HTTP_DELETE_NEEDS_MANAGER", message: "Only an owner or admin can allow HTTP DELETE." });
  const attached = new Set();
  for (const n of definition.nodes || []) {
    if (n.disabled) continue;
    const c = n.config || {};
    if (["notify.email", "notify.gmail"].includes(n.type)) for (const r of c.recipients || []) if (!members.has(String(r).toLowerCase()) && !settings.allowExternalRecipients) errors.push({ code: "RECIPIENT_NOT_MEMBER", message: `"${n.name || n.key}": ${r} is not a member of this organization (allow external recipients in the workflow permissions to send outside).`, node: n.key });
    if (n.type === "notify.inaya") for (const r of c.recipients || []) if (!members.has(String(r).toLowerCase())) errors.push({ code: "RECIPIENT_NOT_MEMBER", message: `"${n.name || n.key}": ${r} is not a member of this organization.`, node: n.key });
    if (c.credentialId) {
      const st = await credentialStatus({ orgId, credentialId: c.credentialId });
      if (!st.ok) errors.push({ code: "CREDENTIAL_UNAVAILABLE", message: `"${n.name || n.key}": the credential is ${st.reason === "NOT_FOUND" ? "not found for this organization" : st.reason.toLowerCase()}.`, node: n.key });
      else attached.add(String(c.credentialId));
    }
    if (["data.support_tickets", "http.request"].includes(n.type)) {
      try { new URL(String(c.url).replace(/\{\{[^}]*\}\}/g, "x")); } catch { errors.push({ code: "BAD_URL", message: `"${n.name || n.key}": the URL is not valid.`, node: n.key }); }
      const localTest = localTestHostsAllowed() && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(String(c.url));
      if (!/^https:\/\//i.test(String(c.url)) && !localTest) errors.push({ code: "HTTPS_REQUIRED", message: `"${n.name || n.key}": only https URLs are allowed.`, node: n.key });
    }
    if (n.type === "ai.agent") for (const t of c.tools || []) {
      if (!TOOLS[t]) errors.push({ code: "UNKNOWN_TOOL", message: `"${n.name || n.key}": "${t}" is not a registered tool.`, node: n.key });
      else if (!settings.dataScopes.includes(TOOLS[t].requiredPermission)) errors.push({ code: "TOOL_SCOPE_NOT_DECLARED", message: `"${n.name || n.key}": tool ${t} needs the "${TOOLS[t].requiredPermission}" scope, which the workflow does not declare.`, node: n.key });
    }
    if (n.type === "action.propose") warnings.push({ code: "HIGH_RISK_ACTION", message: `"${n.name || n.key}" proposes a business change; it will wait for a human approval and the standard delay.`, node: n.key });
  }
  return { valid: errors.length === 0, errors, warnings, attachedCredentials: [...attached], riskLevel: definitionRisk(definition) };
}

// ------------------------------------------------------------------ CRUD
export async function createWorkflow({ orgId, membership, actorEmail, name, description = "", definition = null, templateId = null }) {
  if (!name || !NAME_RE.test(String(name).trim())) return fail("A workflow name of 2–80 characters is required.");
  let def = definition;
  if (templateId) { def = buildTemplateDefinition(templateId); if (!def) return fail("Unknown template.", 404); }
  if (!def) def = { nodes: [{ key: "trigger", type: "trigger.manual", name: "Manual trigger", config: {}, position: { x: 60, y: 120 } }], edges: [], settings: {} };
  const cleaned = cleanDefinition(def);
  if (JSON.stringify(cleaned).length > 400_000) return fail("The workflow definition is too large.", 413);
  const { workflows } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = { orgId: toObjectId(orgId), name: String(name).trim(), description: String(description).slice(0, 500), status: "DRAFT", draft: cleaned, draftUpdatedAt: now, published: null, versionCounter: 0, ownerEmail: actorEmail, acl: [], createdBy: actorEmail, updatedBy: actorEmail, createdAt: now, updatedAt: now, publishedAt: null, deletedAt: null, schedule: null, triggerEvents: [], dataChange: null, webhook: null, templateId: templateId || null };
  try { const r = await workflows.insertOne(doc); doc._id = r.insertedId; } catch (err) { if (err?.code === 11000) return fail("A workflow with that name already exists.", 409); throw err; }
  await audit(orgId, doc._id, actorEmail, "WORKFLOW_CREATED", { name: doc.name, templateId: doc.templateId, definitionHash: canonicalHash(cleaned) });
  return { workflow: publicWorkflow(doc, rightsFor(doc, membership, actorEmail)) };
}

export async function listWorkflows({ orgId, membership, email }) {
  const { workflows } = await getOrgCollections();
  const all = await workflows.find({ orgId: toObjectId(orgId), deletedAt: null }).sort({ updatedAt: -1 }).limit(200).toArray();
  return { workflows: all.filter((w) => can(w, membership, email, "view")).map((w) => publicWorkflow(w, rightsFor(w, membership, email))) };
}

export async function getWorkflow({ orgId, id, membership, email }) {
  const w = await loadWorkflow(orgId, id);
  if (!w || !can(w, membership, email, "view")) return fail("Workflow not found.", 404); // no distinction between missing and hidden
  const rights = rightsFor(w, membership, email);
  return { workflow: publicWorkflow(w, rights), draft: w.draft, published: w.published ? { version: w.published.version, definitionHash: w.published.definitionHash, publishedAt: w.published.publishedAt, publishedBy: w.published.publishedBy } : null, validation: validateWorkflowDefinition(w.draft), acl: rights.has("edit") ? w.acl : undefined };
}

export async function updateWorkflow({ orgId, id, membership, actorEmail, name, description, definition, baseUpdatedAt = null }) {
  const w = await loadWorkflow(orgId, id);
  if (!w || !can(w, membership, actorEmail, "view")) return fail("Workflow not found.", 404);
  if (!can(w, membership, actorEmail, "edit")) return denied("edit");
  if (baseUpdatedAt && baseUpdatedAt !== w.draftUpdatedAt) return fail("Someone else changed this workflow's draft. Reload and re-apply your change.", 409, { reasonCode: "STALE_DRAFT", current: w.draftUpdatedAt });
  const set = { updatedAt: new Date().toISOString(), updatedBy: actorEmail };
  if (name !== undefined) { if (!NAME_RE.test(String(name).trim())) return fail("A workflow name of 2–80 characters is required."); set.name = String(name).trim(); }
  if (description !== undefined) set.description = String(description).slice(0, 500);
  let draftHash = null;
  if (definition !== undefined) {
    const cleaned = cleanDefinition(definition);
    if (JSON.stringify(cleaned).length > 400_000) return fail("The workflow definition is too large.", 413);
    set.draft = cleaned; set.draftUpdatedAt = set.updatedAt; draftHash = canonicalHash(cleaned);
  }
  const { workflows } = await getOrgCollections();
  try { await workflows.updateOne({ _id: w._id, orgId: w.orgId }, { $set: set }); } catch (err) { if (err?.code === 11000) return fail("A workflow with that name already exists.", 409); throw err; }
  await audit(orgId, w._id, actorEmail, "WORKFLOW_EDITED", { fields: Object.keys(set).filter((k) => !["updatedAt", "updatedBy"].includes(k)), draftHash, note: "Draft only: the published version is unchanged." });
  return getWorkflow({ orgId, id, membership, email: actorEmail });
}

export async function deleteWorkflow({ orgId, id, membership, actorEmail }) {
  const w = await loadWorkflow(orgId, id);
  if (!w || !can(w, membership, actorEmail, "view")) return fail("Workflow not found.", 404);
  if (!can(w, membership, actorEmail, "edit") || (w.status === "ACTIVE" && !can(w, membership, actorEmail, "publish"))) return denied("delete");
  const { workflows, workflowExecutions } = await getOrgCollections();
  await workflows.updateOne({ _id: w._id }, { $set: { deletedAt: new Date().toISOString(), status: "DISABLED", triggerEvents: [] } });
  await disarmTriggers(workflows, w._id);
  await workflowExecutions.updateMany({ workflowId: w._id, status: { $in: ["QUEUED", "WAITING", "PAUSED"] }, "lease.owner": null }, { $set: { status: "CANCELLED", completedAt: new Date().toISOString(), errors: [{ code: "WORKFLOW_DELETED", message: "The workflow was deleted.", at: new Date().toISOString() }] } });
  await audit(orgId, w._id, actorEmail, "WORKFLOW_DELETED", { name: w.name, note: "History and evidence are retained." });
  return { deleted: true };
}

/** Turns off the schedule and data-change trigger, whichever the workflow actually has (a null sub-document cannot be $set into). */
async function disarmTriggers(workflows, id) {
  await workflows.updateOne({ _id: id, schedule: { $ne: null } }, { $set: { "schedule.enabled": false } });
  await workflows.updateOne({ _id: id, dataChange: { $ne: null } }, { $set: { "dataChange.enabled": false } });
}

// ----------------------------------------------------- publish / versions
function activationFields(definition, wfDoc) {
  const settings = normalizeSettings(definition.settings);
  const triggers = definition.nodes.filter((n) => !n.disabled && NODE_TYPES[n.type]?.category === "trigger");
  const t = triggers[0];
  const out = { schedule: null, triggerEvents: [], dataChange: null, triggerKind: t?.type || null };
  if (t?.type === "trigger.schedule") { const cfg = { enabled: true, ...t.config.schedule }; out.schedule = { config: cfg, enabled: cfg.enabled !== false, nextRunAt: nextRun(cfg), lastFiredAt: wfDoc?.schedule?.lastFiredAt || null }; }
  if (t?.type === "trigger.event") out.triggerEvents = [{ type: "event", key: t.config.eventType }];
  if (t?.type === "trigger.evidence_event") out.triggerEvents = [{ type: "evidence_event", key: t.config.subjectType || null }];
  if (t?.type === "trigger.twin_complete") out.triggerEvents = [{ type: "twin_complete", key: null }];
  if (t?.type === "trigger.data_change") out.dataChange = { enabled: true, source: t.config.source, checkEveryMinutes: t.config.checkEveryMinutes || 60, nextCheckAt: new Date(Date.now() + (t.config.checkEveryMinutes || 60) * 60000).toISOString(), lastHash: null };
  return { ...out, settings };
}

export async function publishWorkflow({ orgId, id, membership, actorEmail, note = "" }) {
  const w = await loadWorkflow(orgId, id);
  if (!w || !can(w, membership, actorEmail, "view")) return fail("Workflow not found.", 404);
  if (!can(w, membership, actorEmail, "publish")) return denied("publish");
  const definition = cleanDefinition(w.draft);
  const v = await validateForPublish({ orgId, definition, membership, actorEmail });
  if (!v.valid) return fail("The workflow did not pass validation, so it was not published.", 422, { errors: v.errors, warnings: v.warnings }); // fail closed
  const trig = definition.nodes.find((n) => !n.disabled && NODE_TYPES[n.type]?.category === "trigger");
  let webhookSecret = null; let webhook = w.webhook || null;
  if (trig?.type === "trigger.webhook" && !webhook?.secretEncrypted) {
    if (!isIntegrationCryptoConfigured()) return fail("Webhook triggers need INTEGRATION_ENCRYPTION_KEY to be configured on the server.", 503);
    webhookSecret = `whsec_${randomBytes(24).toString("hex")}`;
    webhook = { secretEncrypted: encryptIntegrationSecret(webhookSecret), createdAt: new Date().toISOString() };
  }
  const { workflows, workflowVersions } = await getOrgCollections();
  const bumped = await workflows.findOneAndUpdate({ _id: w._id }, { $inc: { versionCounter: 1 } }, { returnDocument: "after" });
  const version = bumped.versionCounter;
  const definitionHash = canonicalHash(definition);
  const now = new Date().toISOString();
  await workflowVersions.insertOne({ orgId: w.orgId, workflowId: w._id, version, definition, definitionHash, publishedBy: actorEmail, publishedAt: now, note: String(note).slice(0, 300), validation: { warnings: v.warnings, riskLevel: v.riskLevel } });
  const act = activationFields(definition, w);
  const ownerChanged = w.ownerEmail !== actorEmail;
  await workflows.updateOne({ _id: w._id }, { $set: { status: "ACTIVE", published: { version, definition, definitionHash, publishedAt: now, publishedBy: actorEmail }, publishedAt: now, ownerEmail: actorEmail, updatedAt: now, updatedBy: actorEmail, schedule: act.schedule, triggerEvents: act.triggerEvents, dataChange: act.dataChange, webhook } });
  await audit(orgId, w._id, actorEmail, "WORKFLOW_PUBLISHED", { version, definitionHash, riskLevel: v.riskLevel, warnings: v.warnings.length, nodeCount: definition.nodes.length });
  for (const cid of v.attachedCredentials) await audit(orgId, w._id, actorEmail, "CREDENTIAL_ATTACHED", { credentialId: cid, version });
  if (ownerChanged) await audit(orgId, w._id, actorEmail, "WORKFLOW_OWNER_CHANGED", { from: w.ownerEmail, to: actorEmail, note: "The publisher becomes the run identity; their scopes were validated at publish." });
  return { version, definitionHash, warnings: v.warnings, riskLevel: v.riskLevel, ...(webhookSecret ? { webhookSecret, note: "Save the webhook secret now: it is shown once." } : {}), workflow: (await getWorkflow({ orgId, id, membership, email: actorEmail })).workflow };
}

export async function listVersions({ orgId, id, membership, email }) {
  const w = await loadWorkflow(orgId, id);
  if (!w || !can(w, membership, email, "view")) return fail("Workflow not found.", 404);
  const { workflowVersions } = await getOrgCollections();
  const rows = await workflowVersions.find({ orgId: w.orgId, workflowId: w._id }).sort({ version: -1 }).limit(100).project({ definition: 0 }).toArray();
  return { versions: rows.map((v) => ({ version: v.version, definitionHash: v.definitionHash, publishedBy: v.publishedBy, publishedAt: v.publishedAt, note: v.note, active: w.published?.version === v.version })) };
}

export async function getVersion({ orgId, id, version, membership, email }) {
  const w = await loadWorkflow(orgId, id);
  if (!w || !can(w, membership, email, "view")) return fail("Workflow not found.", 404);
  const { workflowVersions } = await getOrgCollections();
  const v = await workflowVersions.findOne({ orgId: w.orgId, workflowId: w._id, version: Number(version) });
  if (!v) return fail("Version not found.", 404);
  return { version: v.version, definition: v.definition, definitionHash: v.definitionHash, publishedAt: v.publishedAt, integrityOk: canonicalHash(v.definition) === v.definitionHash };
}

export async function rollbackWorkflow({ orgId, id, version, membership, actorEmail }) {
  const w = await loadWorkflow(orgId, id);
  if (!w || !can(w, membership, actorEmail, "view")) return fail("Workflow not found.", 404);
  if (!can(w, membership, actorEmail, "publish")) return denied("roll back");
  const { workflows, workflowVersions } = await getOrgCollections();
  const v = await workflowVersions.findOne({ orgId: w.orgId, workflowId: w._id, version: Number(version) });
  if (!v) return fail("Version not found.", 404);
  if (canonicalHash(v.definition) !== v.definitionHash) return fail("That version no longer matches its recorded hash and cannot be activated.", 409, { reasonCode: "VERSION_TAMPERED" });
  const validation = await validateForPublish({ orgId, definition: v.definition, membership, actorEmail });
  if (!validation.valid) return fail("That version no longer passes validation under your current permissions, so it was not activated.", 422, { errors: validation.errors });
  const act = activationFields(v.definition, w);
  const now = new Date().toISOString();
  await workflows.updateOne({ _id: w._id }, { $set: { status: "ACTIVE", published: { version: v.version, definition: v.definition, definitionHash: v.definitionHash, publishedAt: v.publishedAt, publishedBy: v.publishedBy }, ownerEmail: actorEmail, updatedAt: now, updatedBy: actorEmail, schedule: act.schedule, triggerEvents: act.triggerEvents, dataChange: act.dataChange } });
  await audit(orgId, w._id, actorEmail, "WORKFLOW_ROLLED_BACK", { toVersion: v.version, fromVersion: w.published?.version || null, note: "No history was deleted." });
  return { activeVersion: v.version };
}

export async function setWorkflowEnabled({ orgId, id, membership, actorEmail, enabled }) {
  const w = await loadWorkflow(orgId, id);
  if (!w || !can(w, membership, actorEmail, "view")) return fail("Workflow not found.", 404);
  if (!can(w, membership, actorEmail, "publish")) return denied(enabled ? "enable" : "disable");
  if (!w.published) return fail("Publish the workflow before enabling it.", 409);
  const { workflows, workflowExecutions } = await getOrgCollections();
  const now = new Date().toISOString();
  if (enabled) {
    const v = await validateForPublish({ orgId, definition: w.published.definition, membership, actorEmail });
    if (!v.valid) return fail("The workflow no longer passes validation under your permissions (for example a credential expired), so it was not enabled.", 422, { errors: v.errors });
    const act = activationFields(w.published.definition, w);
    await workflows.updateOne({ _id: w._id }, { $set: { status: "ACTIVE", ownerEmail: actorEmail, updatedAt: now, updatedBy: actorEmail, schedule: act.schedule, triggerEvents: act.triggerEvents, dataChange: act.dataChange } });
  } else {
    await workflows.updateOne({ _id: w._id }, { $set: { status: "DISABLED", updatedAt: now, updatedBy: actorEmail, triggerEvents: [] } });
    await disarmTriggers(workflows, w._id);
    await workflowExecutions.updateMany({ workflowId: w._id, mode: "production", status: { $in: ["QUEUED", "WAITING", "PAUSED"] }, "lease.owner": null }, { $set: { status: "CANCELLED", completedAt: now, errors: [{ code: "WORKFLOW_DISABLED", message: "The workflow was disabled while this execution was queued.", at: now }] } });
  }
  await audit(orgId, w._id, actorEmail, enabled ? "WORKFLOW_ENABLED" : "WORKFLOW_DISABLED", { version: w.published.version });
  return { status: enabled ? "ACTIVE" : "DISABLED" };
}

// --------------------------------------------------------------- execution
const execView = (e, full = false) => ({
  executionId: String(e._id), workflowId: String(e.workflowId), workflowName: e.workflowName, workflowVersion: e.workflowVersion, mode: e.mode, status: e.status,
  trigger: e.trigger, initiatingIdentity: e.initiatingIdentity, runAs: e.runAs, createdAt: e.createdAt, startedAt: e.startedAt, completedAt: e.completedAt, durationMs: e.durationMs,
  summary: e.summary || {}, errors: e.errors || [], retryState: e.retryState || {}, deadLetter: !!e.deadLetter,
  // the list query does not load nodeResults, so these come from the summary the engine stored; the detail view can recount
  nodesExecuted: e.nodeResults ? Object.values(e.nodeResults).filter((r) => r.status === "COMPLETED").length : (e.summary?.nodesExecuted ?? 0),
  failedNode: e.summary?.failedNode || (e.nodeResults ? Object.entries(e.nodeResults).find(([, r]) => r.status === "FAILED")?.[0] : null) || null,
  retryCount: e.nodeResults ? Object.values(e.nodeResults).reduce((a, r) => a + (r.retryCount || 0), 0) : (e.summary?.retryCount ?? 0),
  ...(full ? { nodeResults: e.nodeResults || {}, definitionHash: e.definitionHash, budgets: e.budgets, testDataUsed: !!e.testData } : {}),
});

/** Run identity for a manual run is the caller; they must hold every scope the workflow declares. */
function assertCallerCanRun(definition, membership) {
  for (const s of requiredScopes(definition)) if (!scopeHeld(membership, s)) return fail(`You do not hold the "${s}" data scope this workflow reads, so you cannot run it.`, 403, { reasonCode: "PERMISSION_DENIED" });
  return null;
}

export async function executeWorkflow({ orgId, id, membership, actorEmail, mode = "production", payload = undefined, idempotencyKey = null, wait = true, testData = null, useDraft = false }) {
  const w = await loadWorkflow(orgId, id);
  if (!w || !can(w, membership, actorEmail, "view")) return fail("Workflow not found.", 404);
  if (!can(w, membership, actorEmail, "execute")) return denied("run");
  if (!["production", "dry_run", "test"].includes(mode)) return fail("mode must be production, dry_run or test.");
  let definition; let version;
  if (mode === "production") {
    if (!w.published || w.status !== "ACTIVE") return fail("Only a published, enabled workflow can run in production. Use Test or Dry run for a draft.", 409);
    definition = w.published.definition; version = w.published.version;
  } else if (useDraft || !w.published) { definition = cleanDefinition(w.draft); version = 0; }
  else { definition = w.published.definition; version = w.published.version; }
  const pre = validateWorkflowDefinition(definition);
  if (!pre.valid) return fail("The workflow is not valid, so it cannot run.", 422, { errors: pre.errors });
  const deny = assertCallerCanRun(definition, membership);
  if (deny) return deny;
  const trigType = mode === "test" ? "manual_test" : mode === "dry_run" ? "manual_dry_run" : "manual";
  const q = await enqueueExecution({
    orgId, workflow: w, version, definition: version === 0 ? definition : null, mode,
    trigger: { type: trigType, source: "user", ...(payload !== undefined ? { payload } : {}) }, runAs: actorEmail, initiatingIdentity: { kind: "user", email: actorEmail, role: membership?.role || null },
    idempotencyKey, testData: mode === "test" ? testData : null,
  });
  if (q.error) return q;
  const { workflows } = await getOrgCollections();
  if (q.created) await workflows.updateOne({ _id: w._id }, { $set: { lastExecutionAt: new Date().toISOString() } });
  if (!q.created) return { execution: execView(q.execution), duplicate: true };
  const finished = wait ? await runExecutionNow(q.execution._id) : q.execution;
  return { execution: execView(finished, true) };
}

export const testWorkflow = (args) => executeWorkflow({ ...args, mode: "test", useDraft: args.useDraft ?? true });

/** Webhook/API triggers run as the workflow owner, whose live membership is re-checked by the engine. */
export async function triggerExternally({ orgId, workflowId, kind, payload, idempotencyKey = null, identity }) {
  const w = await loadWorkflow(orgId, workflowId);
  if (!w || w.status !== "ACTIVE" || !w.published) return fail("Workflow not found or not active.", 404);
  const trig = w.published.definition.nodes.find((n) => !n.disabled && NODE_TYPES[n.type]?.category === "trigger");
  if (trig?.type !== (kind === "webhook" ? "trigger.webhook" : "trigger.api")) return fail("This workflow is not configured for that trigger.", 409);
  const q = await enqueueExecution({ orgId, workflow: w, version: w.published.version, mode: "production", trigger: { type: kind, source: identity?.source || kind, payload }, runAs: w.ownerEmail, initiatingIdentity: { kind, ...identity }, idempotencyKey });
  if (q.error) return q;
  if (!q.created) return { execution: execView(q.execution), duplicate: true };
  const { workflows } = await getOrgCollections();
  await workflows.updateOne({ _id: w._id }, { $set: { lastExecutionAt: new Date().toISOString() } });
  return { execution: execView(q.execution), queued: true };
}

/** HMAC verification for webhook triggers: timestamp window + constant-time compare + replay ledger. */
export async function verifyWebhook({ workflowId, timestamp, signature, rawBody }) {
  const { workflows, workflowWebhookHits } = await getOrgCollections();
  let w; try { w = await workflows.findOne({ _id: toObjectId(workflowId), deletedAt: null }); } catch { return { ok: false, status: 404 }; }
  if (!w || w.status !== "ACTIVE" || !w.webhook?.secretEncrypted) return { ok: false, status: 404 };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts * 1000) > 5 * 60 * 1000) return { ok: false, status: 401, reason: "stale or missing timestamp" };
  let secret; try { secret = decryptIntegrationSecret(w.webhook.secretEncrypted); } catch { return { ok: false, status: 500 }; }
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const given = Buffer.from(String(signature || ""), "hex"); const want = Buffer.from(expected, "hex");
  if (given.length !== want.length || !timingSafeEqual(given, want)) return { ok: false, status: 401, reason: "bad signature" };
  try { await workflowWebhookHits.insertOne({ workflowId: w._id, nonce: expected, createdAt: new Date() }); } catch (err) { if (err?.code === 11000) return { ok: false, status: 409, reason: "replayed request" }; throw err; }
  return { ok: true, workflow: w };
}

export async function rotateWebhookSecret({ orgId, id, membership, actorEmail }) {
  const w = await loadWorkflow(orgId, id);
  if (!w || !can(w, membership, actorEmail, "view")) return fail("Workflow not found.", 404);
  if (!can(w, membership, actorEmail, "manageCredentials")) return denied("manage credentials of");
  if (!isIntegrationCryptoConfigured()) return fail("INTEGRATION_ENCRYPTION_KEY is not configured on this server.", 503);
  const secret = `whsec_${randomBytes(24).toString("hex")}`;
  const { workflows } = await getOrgCollections();
  await workflows.updateOne({ _id: w._id }, { $set: { webhook: { secretEncrypted: encryptIntegrationSecret(secret), createdAt: new Date().toISOString() } } });
  await audit(orgId, w._id, actorEmail, "CREDENTIAL_CREATED", { kind: "webhook_secret" });
  return { webhookSecret: secret, note: "Save the webhook secret now: it is shown once." };
}

export async function listExecutions({ orgId, membership, email, workflowId = null, status = null, mode = "production", limit = 25, before = null }) {
  const { workflows, workflowExecutions } = await getOrgCollections();
  const q = { orgId: toObjectId(orgId) };
  if (mode && mode !== "all") q.mode = mode;
  if (status) q.status = status;
  if (before) q.createdAt = { $lt: before };
  const visible = new Set();
  if (workflowId) {
    const w = await loadWorkflow(orgId, workflowId);
    if (!w || !can(w, membership, email, "viewExecutions")) return fail("Workflow not found.", 404);
    q.workflowId = w._id;
  } else if (!canManageOrg(membership)) {
    const mine = await workflows.find({ orgId: toObjectId(orgId), deletedAt: null }).toArray();
    for (const w of mine) if (can(w, membership, email, "viewExecutions")) visible.add(w._id);
    q.workflowId = { $in: [...visible] };
  }
  const rows = await workflowExecutions.find(q).sort({ createdAt: -1 }).limit(Math.min(Math.max(Number(limit) || 25, 1), 100)).project({ nodeResults: 0, testData: 0, definitionSnapshot: 0 }).toArray();
  const withCounts = rows.map((r) => execView(r));
  return { executions: withCounts, nextBefore: rows.length ? rows[rows.length - 1].createdAt : null };
}

export async function getExecution({ orgId, executionId, membership, email }) {
  const { workflowExecutions } = await getOrgCollections();
  let e; try { e = await workflowExecutions.findOne({ _id: toObjectId(executionId), orgId: toObjectId(orgId) }); } catch { e = null; }
  if (!e) return fail("Execution not found.", 404);
  const w = await loadWorkflow(orgId, e.workflowId);
  if (!w && !canManageOrg(membership)) return fail("Execution not found.", 404);
  if (w && !can(w, membership, email, "viewExecutions")) return fail("Execution not found.", 404);
  return { execution: execView(e, true) };
}

async function guardedExecAction(orgId, executionId, membership, email, right, fn) {
  const { workflowExecutions } = await getOrgCollections();
  let e; try { e = await workflowExecutions.findOne({ _id: toObjectId(executionId), orgId: toObjectId(orgId) }); } catch { e = null; }
  if (!e) return fail("Execution not found.", 404);
  const w = await loadWorkflow(orgId, e.workflowId);
  if (!can(w || { ownerEmail: null }, membership, email, right)) return fail("Execution not found.", 404);
  return fn(e, w);
}
export const cancelExecution = ({ orgId, executionId, membership, actorEmail }) => guardedExecAction(orgId, executionId, membership, actorEmail, "execute", async () => { const r = await cancelExecutionRecord({ orgId, executionId, actorEmail }); return r.error ? r : { execution: execView(r.execution), pending: !!r.pending }; });
export const pauseExecution = ({ orgId, executionId, membership, actorEmail }) => guardedExecAction(orgId, executionId, membership, actorEmail, "execute", async () => { const r = await pauseExecutionRecord({ orgId, executionId }); return r.error ? r : { execution: execView(r.execution) }; });
export const resumeExecution = ({ orgId, executionId, membership, actorEmail }) => guardedExecAction(orgId, executionId, membership, actorEmail, "execute", async () => { const r = await resumeExecutionRecord({ orgId, executionId }); return r.error ? r : { execution: execView(r.execution) }; });
export const retryExecution = ({ orgId, executionId, membership, actorEmail, wait = true }) => guardedExecAction(orgId, executionId, membership, actorEmail, "execute", async () => {
  const r = await retryExecutionRecord({ orgId, executionId, actorEmail });
  if (r.error) return r;
  const done = wait ? await runExecutionNow(r.execution._id) : r.execution;
  return { execution: execView(done, true) };
});

// ------------------------------------------------------- templates / IO
export function listWorkflowTemplates({ membership }) { return { templates: listTemplates({ membership }) }; }

export async function createFromTemplate({ orgId, templateId, name, membership, actorEmail }) {
  const t = listTemplates({ membership }).find((x) => x.id === templateId);
  if (!t) return fail("That template is not available to you.", 404);
  return createWorkflow({ orgId, membership, actorEmail, name: name || t.name, description: t.description, templateId });
}

const SECRET_IN_EXPORT = /^(credentialId)$/;
export async function exportWorkflow({ orgId, id, membership, email, version = null }) {
  const w = await loadWorkflow(orgId, id);
  if (!w || !can(w, membership, email, "view")) return fail("Workflow not found.", 404);
  let def = w.draft;
  if (version) { const { workflowVersions } = await getOrgCollections(); const v = await workflowVersions.findOne({ orgId: w.orgId, workflowId: w._id, version: Number(version) }); if (!v) return fail("Version not found.", 404); def = v.definition; }
  const stripped = JSON.parse(JSON.stringify(cleanDefinition(def)), (k, val) => (SECRET_IN_EXPORT.test(k) ? undefined : val));
  for (const n of stripped.nodes) if (n.config?.credentialId === undefined && ["notify.slack", "notify.gmail", "http.request", "data.support_tickets"].includes(n.type)) n.config.credentialRef = { placeholder: true, note: "Attach one of your organization's credentials after importing." };
  return { export: { format: "inaya.workflow/1", exportedAt: new Date().toISOString(), name: w.name, description: w.description, definition: stripped, definitionHash: canonicalHash(stripped), notice: "Credentials, secrets and tokens are never included." } };
}

export async function importWorkflow({ orgId, membership, actorEmail, payload, name }) {
  if (!payload || payload.format !== "inaya.workflow/1" || !payload.definition) return fail("This is not an Inaya workflow export.");
  if (JSON.stringify(payload).length > 400_000) return fail("The file is too large.", 413);
  const text = JSON.stringify(payload.definition);
  if (/(secret|password|api[_-]?key|token|bearer)["']?\s*:\s*["'][^"']{6,}/i.test(text)) return fail("The file contains what looks like a raw secret and was refused.", 422);
  const created = await createWorkflow({ orgId, membership, actorEmail, name: name || payload.name || "Imported workflow", description: payload.description || "", definition: payload.definition });
  if (created.error) return created;
  await audit(orgId, toObjectId(created.workflow.workflowId), actorEmail, "WORKFLOW_IMPORTED", { definitionHash: payload.definitionHash || null });
  const full = await getWorkflow({ orgId, id: created.workflow.workflowId, membership, email: actorEmail });
  return { workflow: created.workflow, validation: full.validation, note: "Imported as a DRAFT. It must pass validation and be published explicitly." };
}

// ----------------------------------------------------------------- sharing
export async function setWorkflowAcl({ orgId, id, membership, actorEmail, acl }) {
  const w = await loadWorkflow(orgId, id);
  if (!w || !can(w, membership, actorEmail, "view")) return fail("Workflow not found.", 404);
  if (!canManageOrg(membership) && w.ownerEmail !== actorEmail) return denied("share");
  if (!Array.isArray(acl) || acl.length > 50) return fail("acl must be a list of up to 50 entries.");
  const { orgMembers, workflows } = await getOrgCollections();
  const clean = [];
  for (const a of acl) {
    const rights = (a.rights || []).filter((r) => RIGHTS.includes(r));
    if (!a.email && !a.role) return fail("Each entry needs an email or a role.");
    if (a.email) { const m = await orgMembers.findOne({ orgId: toObjectId(orgId), email: String(a.email).toLowerCase(), status: "active" }); if (!m) return fail(`${a.email} is not a member of this organization.`); clean.push({ email: m.email, rights }); }
    else if (["admin", "member", "owner"].includes(a.role)) clean.push({ role: a.role, rights });
    else return fail("role must be admin, member or owner.");
  }
  // only managers may hand out publish / manageCredentials / exportEvidence
  if (!canManageOrg(membership) && clean.some((c) => c.rights.some((r) => ["publish", "manageCredentials", "manageTemplates", "exportEvidence"].includes(r)))) return fail("Only an owner or admin can grant publish, credential, template or evidence-export rights.", 403);
  await workflows.updateOne({ _id: w._id }, { $set: { acl: clean, updatedAt: new Date().toISOString(), updatedBy: actorEmail } });
  await audit(orgId, w._id, actorEmail, "WORKFLOW_SHARED", { entries: clean.length });
  await audit(orgId, w._id, actorEmail, "WORKFLOW_PERMISSION_CHANGED", { entries: clean.map((c) => ({ who: c.email || `role:${c.role}`, rights: c.rights })) });
  return { acl: clean };
}

export { execView, loadWorkflow, cleanDefinition, publicWorkflow, can, rightsFor as effectiveRights, audit, NODE_KEY_RE, DATA_SCOPES, redact };
